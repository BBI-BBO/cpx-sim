#!/usr/bin/env python3
"""개발 키트(develop.py) 로컬 실행 결과를 CPX 웹 진료 기록으로 올리고 채점한다.

  python3 scripts/import_devkit_runs.py <결과 폴더…> --label "v5 대회조건 로컬" [--memo "…"]
  결과 폴더 = develop.py --out 아래의 <증례>-<시각>/ (transcript.json, record.json)

공개 샘플(C01·C03·C10)은 fixtures/nova-samples-cases.json 의 증례(웹 환자 8·9·10)에 붙인다.
올린 뒤 /api/record/rescore 로 팀 채점기를 돌린다 (팀 CPX 참고점수, 공식 점수 아님).
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from clinic_cli import clinic  # noqa: E402
from evaluate_submission import _encounter_from_remote  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--label", required=True)
    ap.add_argument("--memo", default="")
    ap.add_argument("--no-score", action="store_true")
    a = ap.parse_args()
    fixtures = json.loads((ROOT / "fixtures/nova-samples-cases.json").read_text(encoding="utf-8"))
    c = clinic()
    cases = {x["cid"]: x for x in c.get("/api/cases")["cases"]}
    names = []
    for run in a.runs:
        t = json.loads((run / "transcript.json").read_text(encoding="utf-8"))
        rec = json.loads((run / "record.json").read_text(encoding="utf-8"))
        case_id = run.name.split("-")[0]
        cid = next((k for k in cases if k == case_id or k.endswith(case_id)), case_id)
        remote = {"initial": t.get("start_information") or {}, "events": t.get("events") or [],
                  "record": rec.get("record") or rec, "diagnosis": rec.get("diagnosis", ""), "score": None, "session": None}
        enc = _encounter_from_remote(cid, remote, fixtures.get(case_id) or fixtures.get(cid) or {}, run.name,
                                     encounter_name=f"{time.strftime('%Y%m%d_%H%M%S')}_{case_id}_{run.name[-6:]}")
        s = t.get("summary") or {}
        enc["meta"] = {"label": a.label, "title": f"{a.label} · {case_id} {cases.get(cid, {}).get('cc', '')}".strip(),
                       "memo": "\n".join(x for x in [a.memo, f"개발 키트 로컬 실행 {run}",
                                                     f"턴 {s.get('turns')} · Doctor 호출 {s.get('doctor_calls')} · 입력 {s.get('doctor_input_tokens')} / 출력 {s.get('doctor_output_tokens')} 토큰 · {s.get('seconds')}초"] if x)}
        c.post("/api/admin/import", {"encounters": [enc]})
        names.append((enc["name"], case_id, rec.get("diagnosis", ""), {"calls": s.get("doctor_calls") or 0, "in": s.get("doctor_input_tokens") or 0, "out": s.get("doctor_output_tokens") or 0}))
        print("올림", enc["name"], "·", rec.get("diagnosis", ""))
    if a.no_score:
        return
    for name, case_id, dx, usage in names:  # 팀 채점기로 채점 (rescore = 저장된 기록 그대로)
        conv = c.get("/api/conv?name=" + name)
        sub = conv.get("submit") or {}
        r = c.post("/api/record/rescore", {"name": name, "dx": dx or sub.get("dx") or "진단 미정",
                                           "soap": sub.get("soap"), "soap_fields": sub.get("soap_fields"), "usage": usage})
        s = r.get("submit") or {}
        print(case_id, "점수", s.get("total"), s.get("scores"), "· 정확도", (s.get("judge") or {}).get("accuracy"))


if __name__ == "__main__":
    main()
