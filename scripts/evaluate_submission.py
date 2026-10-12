#!/usr/bin/env python3
"""Run a validated submission against the three public NOVA samples.

The runner delegates execution to the supplied NOVA devkit, which preserves the
starter's `prepare()`/`consult()` contract and the server-side 50-turn, 30-code
point, one-action rules.  The devkit needs an OpenAI-compatible local endpoint;
use `--dry-run` when only ZIP validation is desired.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path

from validate_submission import validate


CASE_IDS = ("C01", "C03", "C10")
SUMMARY_RE = re.compile(
    r"상태\s+(?P<status>\S+)\s+·\s+(?P<turns>\d+)턴\s+·\s+Doctor 호출\s+(?P<calls>\d+)회"
)


def _json_request(url: str, method: str = "GET", body: dict | None = None, token: str = "") -> dict:
    headers = {"User-Agent": "nova-local-evaluator/1.0", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
                                 headers=headers)
    with urllib.request.urlopen(req, timeout=240) as response:
        return json.loads(response.read())


def _public_sample_ids(api_base: str, dev_key: str) -> dict[str, str]:
    payload = _json_request(api_base.rstrip("/") + "/v1/sample/cases", token=dev_key)
    found = {}
    for item in payload.get("cases", []):
        text = str(item.get("explanation", ""))
        match = re.search(r"\b(C01|C03|C10)\b", text)
        if match:
            found[match.group(1)] = str(item["case_id"])
    missing = [x for x in CASE_IDS if x not in found]
    if missing:
        raise RuntimeError("공개 샘플 서버에서 케이스 ID를 찾지 못했습니다: " + ", ".join(missing))
    return found


def _record_text(record: dict | None, section: str, labels: dict[str, str]) -> str:
    values = (record or {}).get(section) or {}
    return "\n".join(f"{labels.get(k, k)}: {v}" for k, v in values.items() if str(v).strip())


SOAP_FIELD_KEYS = {
    "S": ("cc", "hpi", "pmh", "fh", "sh", "ros"),
    "O": ("exam", "tests"),
    "A": ("evidence", "differential"),
    "P": ("tests", "treatment", "disposition", "follow_up", "education"),
}


def _soap_fields(record: dict | None) -> dict:
    record = record or {}
    out = {}
    for section, keys in SOAP_FIELD_KEYS.items():
        out[section] = {key: str((record.get(section) or {}).get(key, "") or "") for key in keys}
    return out


def _official_score(remote: dict) -> tuple[int | None, dict, dict]:
    raw = remote.get("score")
    if raw is None:
        return None, {}, {}
    if isinstance(raw, (int, float)):
        return int(raw), {}, {"official_score": raw}
    if not isinstance(raw, dict):
        return None, {}, {"official_result": raw}
    total = raw.get("total", raw.get("score", raw.get("final_score")))
    try:
        total = int(round(float(total))) if total is not None else None
    except (TypeError, ValueError):
        total = None
    scores = raw.get("scores") or raw.get("domains") or {}
    judge = raw.get("judge") or {"official": raw}
    return total, scores if isinstance(scores, dict) else {}, judge if isinstance(judge, dict) else {"official": raw}


def _encounter_from_remote(case_id: str, remote: dict, fixture: dict, run_id: str,
                           encounter_name: str | None = None, finalized: bool = True) -> dict:
    initial = remote.get("initial") or {}
    events = []
    turn = 0
    for event in remote.get("events") or []:
        action = event.get("action")
        if action not in {"SAY", "EXAM", "TEST"}:
            continue
        turn += 1
        response = event.get("response") or {}
        out = response.get("content") if action == "SAY" else response.get("result")
        events.append({"type": "turn", "turn": turn, "act": action, "text": event.get("content", ""),
                       "out": out or "", "time": time.strftime("%Y-%m-%dT%H:%M:%S")})
    record = remote.get("record") or {}
    soap_fields = _soap_fields(record)
    soap = {
        "S": _record_text(record, "S", {"cc": "주호소", "hpi": "현병력", "pmh": "과거력·약물·알레르기", "fh": "가족력", "sh": "사회력", "ros": "계통 문진"}),
        "O": _record_text(record, "O", {"exam": "진찰 소견", "tests": "검사 결과"}),
        "A": _record_text(record, "A", {"evidence": "근거", "differential": "감별진단"}),
        "P": _record_text(record, "P", {"tests": "추가 검사", "treatment": "치료", "disposition": "처치 결정", "follow_up": "추적", "education": "환자 교육"}),
    }
    total, scores, judge = _official_score(remote)
    submit = {"type": "submit", "total": total, "scores": scores, "judge": judge, "patient": {},
              "soap": soap, "soap_split": {k: [soap[k]] if soap[k] else [] for k in "SOAP"},
              "soap_fields": soap_fields, "dx": remote.get("diagnosis", ""), "turns": turn, "rejected": 0, "truth": fixture.get("truth"),
              "official_result": remote.get("score") or remote.get("session"), "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
    stamp = time.strftime("%Y%m%d_%H%M%S")
    p = fixture.get("patient") or {}
    name = encounter_name or f"{stamp}_{case_id}_NOVA_{run_id}"
    return {"name": name, "cid": case_id, "mode": "예선",
            "start": {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "patient": p,
                      "vitals": initial.get("vital_signs", fixture.get("vitals", "")), "max_turns": 50, "maxlen": 30},
            "events": events, "draft": None if finalized else {"soap": soap, "soap_fields": soap_fields, "dx": remote.get("diagnosis", "")},
            "submits": [submit] if finalized else [],
            "meta": {"label": "NOVA 공개 샘플", "title": "",
                     "memo": f"{case_id} · NOVA 공개 샘플 서버 {'실행 완료' if finalized else '실행 중'}"},
            "usage": {"calls": 0, "in": 0, "out": 0}, "turns": turn, "n_submits": 1 if finalized else 0,
            "cc": p.get("chief_complaint", ""), "who": f"{p.get('age', '')}세 {p.get('sex', '')}".strip(),
            "total": total if finalized else None, "dx": remote.get("diagnosis", "") if finalized else None, "truth": fixture.get("truth") if finalized else None,
            "accuracy": (judge.get("accuracy") if isinstance(judge, dict) else None), "scores": scores}


def _publish_encounters(api: str, password: str, encounters: list[dict]) -> dict:
    login = _json_request(api.rstrip("/") + "/api/login", "POST", {"password": password})
    token = login.get("token", "")
    if not token:
        raise RuntimeError("CPX 서버 로그인 토큰을 받지 못했습니다")
    return _json_request(api.rstrip("/") + "/api/admin/import", "POST", {"encounters": encounters}, token)


def _rescore_published_encounters(api: str, password: str, encounters: list[dict]) -> tuple[dict[str, dict], list[str]]:
    """Score imported public-sample transcripts with our CPX judge.

    The NOVA development/sample server validates the interaction but returns
    ``score_status=not_scored``.  Once the transcript is imported into our
    CPX app, its normal judge can score the same SOAP and dialogue.  Keeping
    this as a second, explicit step prevents us from presenting the official
    server's null score as if it were a competition score.
    """
    login = _json_request(api.rstrip("/") + "/api/login", "POST", {"password": password})
    token = login.get("token", "")
    if not token:
        raise RuntimeError("CPX 서버 로그인 토큰을 받지 못했습니다")
    scores: dict[str, dict] = {}
    errors: list[str] = []
    for encounter in encounters:
        submit = (encounter.get("submits") or [{}])[-1]
        diagnosis = str(submit.get("dx") or "").strip()
        soap = submit.get("soap") or {}
        soap_fields = submit.get("soap_fields") or {}
        if not diagnosis:
            errors.append(f"{encounter.get('cid', '?')}: 주진단이 없어 재채점하지 못했습니다")
            continue
        try:
            view = _json_request(
                api.rstrip("/") + "/api/record/rescore",
                "POST",
                {"name": encounter["name"], "soap": soap, "soap_fields": soap_fields,
                 "note": soap_fields, "dx": diagnosis, "diagnosis": diagnosis},
                token,
            )
            scored = view.get("submit") or {}
            total = scored.get("total")
            if not isinstance(total, (int, float)):
                errors.append(f"{encounter.get('cid', '?')}: CPX 채점기가 점수를 반환하지 않았습니다")
                continue
            scores[encounter["name"]] = {
                "total": total,
                "scores": scored.get("scores") or {},
                "judge": scored.get("judge") or {},
                "source": "team_cpx_judge",
            }
        except Exception as exc:
            errors.append(f"{encounter.get('cid', '?')}: {type(exc).__name__}: {exc}")
    return scores, errors


def _write_progress(path: Path | None, report: dict) -> None:
    if path is None:
        return
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _evaluate_official(submission: str | os.PathLike[str], devkit: str | os.PathLike[str], samples: str | os.PathLike[str],
                       result_root: Path, timeout: int, api_base: str, dev_key: str,
                       publish_api: str = "", publish_password: str = "", progress_path: Path | None = None,
                       validation: dict | None = None, run_id: str | None = None) -> dict:
    sample_ids = _public_sample_ids(api_base, dev_key)
    devkit_path, samples_path = Path(devkit).resolve(), Path(samples).resolve()
    adapter_cases = json.loads((samples_path.parent / "nova-samples-cases.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="nova-submission-") as temp:
        extract = Path(temp) / "submission"
        extract.mkdir()
        with zipfile.ZipFile(submission) as archive:
            archive.extractall(extract)
        report = {"run_id": run_id or uuid.uuid4().hex[:12], "mode": "official_sample_server", "cases": [], "status": "running", "average_score": None,
                  "submission": validation or {},
                  "score_note": "NOVA 공개 샘플 서버의 참고 결과입니다. 공식 예선 점수와는 다를 수 있습니다.",
                  "criteria": {"domains": {"정보수집": 25, "진단추론": 15, "검사·추적": 10, "안전": 15, "의사소통": 15, "효율": 20},
                               "rules": {"max_turns": 50, "max_chars": 30, "one_action_per_turn": True, "preliminary_test": False}}}
        jobs = {}
        for case_id in CASE_IDS:
            out = result_root / case_id
            encounter_name = f"{time.strftime('%Y%m%d_%H%M%S')}_{case_id}_NOVA_{report['run_id']}"
            cmd = [sys.executable, str(Path(__file__).resolve().parent / "remote_sample_runner.py"),
                   "--submission", str(extract / "run.py"), "--devkit", str(devkit_path), "--api-base", api_base,
                   "--dev-key", dev_key, "--case-id", sample_ids[case_id], "--out", str(out),
                   "--display-case-id", case_id, "--fixture", str(samples_path.parent / "nova-samples-cases.json"),
                   "--encounter-name", encounter_name]
            child_env = os.environ.copy()
            child_env["NOVA_PUBLISH_API"] = publish_api
            child_env["NOVA_PUBLISH_PASSWORD"] = publish_password
            report["cases"].append({"case_id": case_id, "status": "running", "seconds": 0, "turns": 0,
                                    "result_dir": str(out), "published_live": bool(publish_api and publish_password)})
            jobs[case_id] = (cmd, child_env, out, encounter_name)
        _write_progress(progress_path, report)

        def run_case(case_id: str, job: tuple[list[str], dict, Path, str]):
            cmd, child_env, out, encounter_name = job
            started = time.monotonic()
            try:
                proc = subprocess.run(cmd, cwd=devkit_path, env=child_env, text=True, capture_output=True, timeout=timeout)
                raw = json.loads((out / "remote-result.json").read_text(encoding="utf-8"))
                fixture = adapter_cases[case_id]
                case = {"case_id": case_id, "status": raw.get("status", "failed"), "seconds": round(time.monotonic() - started, 2),
                        "turns": raw.get("turns"), "output_tail": (proc.stdout + proc.stderr)[-4000:],
                        "result_dir": str(out), "encounter_name": encounter_name,
                        "score": raw.get("score"), "diagnosis": raw.get("diagnosis"),
                        "publish_errors": raw.get("publish_errors", [])}
                encounter = _encounter_from_remote(case_id, raw, fixture, report["run_id"],
                                                   encounter_name=encounter_name, finalized=True) if raw.get("status") == "completed" else None
                return case, encounter
            except Exception as exc:
                return {"case_id": case_id, "status": "failed", "seconds": round(time.monotonic() - started, 2), "error": str(exc)}, None

        encounters = []
        with ThreadPoolExecutor(max_workers=len(CASE_IDS), thread_name_prefix="nova-sample") as pool:
            futures = {pool.submit(run_case, case_id, jobs[case_id]): case_id for case_id in CASE_IDS}
            for future in as_completed(futures):
                case_id = futures[future]
                case, encounter = future.result()
                index = next(i for i, old in enumerate(report["cases"]) if old["case_id"] == case_id)
                report["cases"][index] = case
                if encounter:
                    encounters.append(encounter)
                _write_progress(progress_path, report)
        if encounters and publish_api and publish_password:
            report["published"] = _publish_encounters(publish_api, publish_password, encounters)
            try:
                local_scores, score_errors = _rescore_published_encounters(publish_api, publish_password, encounters)
                report["local_scoring"] = {"source": "team_cpx_judge", "scored": len(local_scores),
                                            "errors": score_errors}
                for case in report["cases"]:
                    encounter = next((x for x in encounters if x["name"] == case.get("encounter_name")), None)
                    if encounter is None:
                        continue
                    scored = local_scores.get(encounter["name"])
                    if scored:
                        case["official_score"] = case.get("score")
                        case["score"] = scored["total"]
                        case["scores"] = scored["scores"]
                        case["score_source"] = scored["source"]
                    case.pop("encounter_name", None)
                report["score_note"] = "NOVA 공개 샘플 서버는 실행만 검증하고 채점하지 않습니다. 표시 점수는 같은 대화·SOAP를 우리 CPX 채점기로 재채점한 참고 점수입니다."
            except Exception as exc:
                report["local_scoring"] = {"source": "team_cpx_judge", "scored": 0,
                                            "errors": [f"{type(exc).__name__}: {exc}"]}
            _write_progress(progress_path, report)
        report["status"] = "completed" if all(c["status"] == "completed" for c in report["cases"]) else "completed_with_errors"
        scores = [c.get("score") for c in report["cases"] if isinstance(c.get("score"), (int, float))]
        if scores:
            report["average_score"] = round(sum(scores) / len(scores), 1)
        return report


def _summary(output: str, case_id: str, elapsed: float, returncode: int, timed_out: bool) -> dict:
    match = SUMMARY_RE.search(output)
    result = {
        "case_id": case_id,
        "status": "timeout" if timed_out else ("passed" if returncode == 0 and match else "failed"),
        "returncode": returncode,
        "seconds": round(elapsed, 2),
        "turns": int(match.group("turns")) if match else None,
        "doctor_calls": int(match.group("calls")) if match else None,
        "runner_status": match.group("status") if match else None,
        "output_tail": output[-4000:],
    }
    return result


def evaluate(submission: str | os.PathLike[str], devkit: str | os.PathLike[str], samples: str | os.PathLike[str], out: str | os.PathLike[str] | None = None, timeout: int = 1800, dry_run: bool = False,
             official_api: str = "", dev_key: str = "", publish_api: str = "", publish_password: str = "") -> dict:
    validation = validate(submission)
    report: dict = {
        "run_id": uuid.uuid4().hex[:12],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "submission": validation,
        "criteria": {
            "domains": {
                "정보수집": 25,
                "진단추론": 15,
                "검사·추적": 10,
                "안전": 15,
                "의사소통": 15,
                "효율": 20,
            },
            "rules": {
                "max_turns": 50,
                "max_chars": 30,
                "one_action_per_turn": True,
                "preliminary_test": False,
                "doctor_model_required_per_case": True,
            },
        },
        "cases": [],
        "status": "invalid" if not validation["valid"] else ("validated" if dry_run else "queued"),
    }
    if not validation["valid"] or dry_run:
        report["average_score"] = None
        return report

    devkit_path = Path(devkit).resolve()
    samples_path = Path(samples).resolve()
    if not (devkit_path / "develop.py").is_file():
        raise FileNotFoundError(f"devkit/develop.py를 찾을 수 없습니다: {devkit_path}")
    if not samples_path.is_dir():
        raise FileNotFoundError(f"samples 폴더를 찾을 수 없습니다: {samples_path}")
    result_root = Path(out).resolve() if out else Path(tempfile.mkdtemp(prefix="nova-eval-"))
    result_root.mkdir(parents=True, exist_ok=True)
    report["result_dir"] = str(result_root)

    if official_api and dev_key:
        report = _evaluate_official(submission, devkit, samples, result_root, timeout, official_api, dev_key, publish_api, publish_password,
                                    progress_path=result_root / "evaluation.json", validation=validation, run_id=report["run_id"])
        report["run_id"] = report.get("run_id") or uuid.uuid4().hex[:12]
        report["submission"] = validation
        return report

    with tempfile.TemporaryDirectory(prefix="nova-submission-") as temp:
        extract = Path(temp) / "submission"
        extract.mkdir()
        with zipfile.ZipFile(submission) as archive:
            archive.extractall(extract)
        agent = extract / "run.py"
        for case_id in CASE_IDS:
            case_dir = samples_path / case_id
            started = time.monotonic()
            cmd = [
                sys.executable,
                str(devkit_path / "develop.py"),
                "--case",
                str(case_dir),
                "--agent",
                str(agent),
                "--out",
                str(result_root / case_id),
                "--quiet",
            ]
            env = os.environ.copy()
            env.setdefault("PYTHONUTF8", "1")
            try:
                proc = subprocess.run(cmd, cwd=devkit_path, env=env, text=True, capture_output=True, timeout=timeout)
                output = (proc.stdout or "") + (proc.stderr or "")
                case_result = _summary(output, case_id, time.monotonic() - started, proc.returncode, False)
            except subprocess.TimeoutExpired as exc:
                output = (exc.stdout or "") + (exc.stderr or "")
                case_result = _summary(output, case_id, time.monotonic() - started, 124, True)
            report["cases"].append(case_result)
    report["status"] = "completed" if all(x["status"] == "passed" for x in report["cases"]) else "completed_with_errors"
    # The local devkit deliberately does not score.  Scores are populated by the
    # CPX/Supabase judge when the same transcript is submitted there.
    report["average_score"] = None
    report["score_note"] = "NOVA 개발 키트는 채점하지 않습니다. 실행 성공 여부와 transcript/record를 확인한 뒤 서버 샘플 검증 점수를 사용하세요."
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--submission", required=True)
    parser.add_argument("--devkit", default=str(Path.home() / "Downloads" / "nova-devkit"))
    parser.add_argument("--samples", default=str(Path(__file__).resolve().parents[1] / "fixtures" / "nova-samples-2026"))
    parser.add_argument("--out", help="결과 저장 폴더")
    parser.add_argument("--timeout", type=int, default=1800, help="증례별 제한 시간(초)")
    parser.add_argument("--dry-run", action="store_true", help="ZIP 검증만 수행")
    args = parser.parse_args()
    result = evaluate(args.submission, args.devkit, args.samples, args.out, args.timeout, args.dry_run,
                      official_api=os.environ.get("NOVA_SAMPLE_API") or os.environ.get("NOVA_API_BASE", ""),
                      dev_key=os.environ.get("NOVA_DEV_KEY", ""),
                      publish_api=os.environ.get("CPX_API", ""),
                      publish_password=os.environ.get("SP_WEB_PASSWORD", ""))
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "evaluation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["status"] in {"validated", "completed"} else 2)


if __name__ == "__main__":
    main()
