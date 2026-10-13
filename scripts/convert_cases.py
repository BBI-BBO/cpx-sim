#!/usr/bin/env python3
"""예전 형식 증례를 대회 형식(공개 샘플 case.json 과 같은 모양)으로 바꾼다.

대회 형식
  start_information: {opening, vital_signs}   의사가 처음 받는 것
  patient_script:    "대본 한 덩어리"          가상 환자가 아는 전부 (시작 정보와 함께)
  exam_results:      [{exam, result}]          진찰표
  model_record:      {S, O, A, P, diagnosis}   선택 (예전 증례에는 없으면 만들지 않음)
  truth:             정답

예전 형식(PMC 로 만든 A~G: script 칸별 목록·qa·beliefs·acting·exam·vitals)의 글을 그대로 이어 붙일 뿐
새 사실을 만들지 않는다. 규칙은 supabase/functions/api/index.ts 의 caseFacts()·legacyScript()·legacyExams() 와 같다.
예전 칸(script·qa·exam·vitals …)은 지우지 않고 남긴다. 엔진은 대회 형식 칸이 있으면 그것만 읽는다.

  # 파일: {cid: 증례} JSON 을 바꿔 새 파일로
  python3 scripts/convert_cases.py fixtures/old-cases.json --output /tmp/new-cases.json

  # 서버 DB: 먼저 무엇이 바뀌는지 보고(기본은 미리 보기), --apply 로 저장 (이전 판은 case_history 에 보관됨)
  SP_WEB_PASSWORD=… python3 scripts/convert_cases.py --api https://<ref>.supabase.co/functions/v1
  SP_WEB_PASSWORD=… python3 scripts/convert_cases.py --api https://<ref>.supabase.co/functions/v1 --apply --only A,B
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

NOT_FACT_KEYS = re.compile(r"성격|말투|말버릇|감정|예시")  # 연기 지시라 대본(환자가 아는 사실)에 넣지 않음


def txt(value) -> str:
    return "" if value is None else str(value).strip()


def line_list(value) -> list[str]:
    items = value if isinstance(value, list) else [value]
    return [txt(x) for x in items if txt(x)]


def legacy_script(case: dict) -> str:
    script = case.get("script") or {}
    sample = line_list(script.get("공개 샘플 대본"))
    if sample:  # 예전 NOVA 샘플 변환본: 원문 대본만 (qa 는 모범 기록에서 온 것이라 환자 지식이 아님)
        return "\n\n".join(sample)
    out: list[str] = []
    opening = txt((case.get("patient") or {}).get("opening"))
    if opening:
        out.append(opening)
    for key, value in script.items():
        values = line_list(value)
        if values:
            out.append(f"{key}: {' / '.join(values)}")
    qa = [f"- {txt(x.get('q'))}: {txt(x.get('a'))}" for x in case.get("qa") or []
          if isinstance(x, dict) and txt(x.get("q")) and txt(x.get("a"))]
    if qa:
        out.append("자주 묻는 것:\n" + "\n".join(qa))
    persona = [(k, " / ".join(line_list(v))) for k, v in (case.get("persona") or {}).items() if not NOT_FACT_KEYS.search(k)]
    persona = [f"- {k}: {v}" for k, v in persona if v]
    if persona:
        out.append("나에 대해:\n" + "\n".join(persona))
    acting = case.get("acting") or {}
    worry, expect = line_list(acting.get("걱정")), line_list(acting.get("기대"))
    if worry:
        out.append("걱정: " + " / ".join(worry))
    if expect:
        out.append("바라는 것: " + " / ".join(expect))
    beliefs = [f"- ({txt(x.get('kind')) or '짐작'}) {txt(x.get('belief'))}" for x in case.get("beliefs") or []
               if isinstance(x, dict) and txt(x.get("belief"))]
    if beliefs:
        out.append("내 생각·들은 말:\n" + "\n".join(beliefs))
    return "\n\n".join(out)


def legacy_exams(case: dict) -> list[dict]:
    rows = []
    for x in case.get("exam") or []:
        if not isinstance(x, dict):
            continue
        row = {"exam": txt(x.get("name", x.get("exam"))), "result": txt(x.get("finding", x.get("result")))}
        if row["exam"] and row["result"]:
            rows.append(row)
    vitals = txt(case.get("vitals"))  # 예전 엔진은 활력징후를 진찰 한 줄로 따로 붙였다
    if vitals and not any(re.search(r"활력|vital", r["exam"], re.I) for r in rows):
        rows.insert(0, {"exam": "활력징후 측정 (Vital signs)", "result": re.sub(r"\s*\n+\s*", ", ", vitals)})
    return rows


def case_facts(case: dict) -> dict:
    start = case.get("start_information") or {}
    script = txt(case.get("patient_script"))
    exams = [{"exam": txt(r.get("exam")), "result": txt(r.get("result"))}
             for r in case.get("exam_results") or [] if isinstance(r, dict)]
    exams = [r for r in exams if r["exam"] and r["result"]]
    return {
        "start_information": {"opening": txt(start.get("opening")) or txt((case.get("patient") or {}).get("opening")),
                              "vital_signs": txt(start.get("vital_signs")) or txt(case.get("vitals"))},
        "patient_script": script or legacy_script(case),
        "exam_results": exams or legacy_exams(case),
        "unified": bool(script) and bool(exams),
    }


def convert(case: dict, force: bool = False) -> tuple[dict, bool]:
    """(바뀐 증례, 바뀌었는지). 이미 대회 형식이면 --force 없이는 그대로 둔다."""
    facts = case_facts(case)
    if facts["unified"] and not force:
        return case, False
    if force:  # 예전 칸에서 다시 만든다
        facts = case_facts({k: v for k, v in case.items() if k not in ("start_information", "patient_script", "exam_results")})
    out = dict(case)
    out["start_information"] = facts["start_information"]
    out["patient_script"] = facts["patient_script"]
    out["exam_results"] = facts["exam_results"]
    if not txt(out.get("truth")) and isinstance(out.get("model_record"), dict):
        out["truth"] = txt(out["model_record"].get("diagnosis"))
    return out, True


def summary(cid: str, case: dict, changed: bool) -> str:
    facts = case_facts(case)
    problems = []
    if not facts["start_information"]["opening"]:
        problems.append("첫마디 없음")
    if not facts["patient_script"]:
        problems.append("대본 없음")
    if not facts["exam_results"]:
        problems.append("진찰표 없음")
    state = "변환" if changed else "그대로(이미 대회 형식)"
    return (f"{cid}: {state} · 대본 {len(facts['patient_script'])}자 · 진찰 {len(facts['exam_results'])}행"
            + (f" · 확인 필요: {', '.join(problems)}" if problems else ""))


def request(url: str, body: dict | None = None, token: str = "") -> dict:
    headers = {"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})}
    req = urllib.request.Request(url, method="POST" if body is not None else "GET", headers=headers,
                                 data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"{url} 실패 {exc.code}: {exc.read().decode(errors='replace')[:400]}") from None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", help="{cid: 증례} JSON 파일")
    ap.add_argument("--output", help="바꾼 증례를 쓸 파일 (input 과 같이)")
    ap.add_argument("--api", help="서버 주소 (…/functions/v1). 주면 DB 의 증례를 바꾼다")
    ap.add_argument("--password", default=os.environ.get("SP_WEB_PASSWORD", ""))
    ap.add_argument("--apply", action="store_true", help="--api 와 함께: 실제로 저장 (없으면 미리 보기만)")
    ap.add_argument("--only", default="", help="이 증례만 (쉼표로 구분한 cid)")
    ap.add_argument("--force", action="store_true", help="이미 대회 형식인 증례도 예전 칸에서 다시 만든다")
    ap.add_argument("--show", action="store_true", help="바꾼 대본·진찰표를 화면에 찍는다")
    args = ap.parse_args()
    only = {x.strip() for x in args.only.split(",") if x.strip()}

    if args.api:
        if not args.password:
            raise SystemExit("--password 또는 SP_WEB_PASSWORD 가 필요합니다")
        root = args.api.rstrip("/")
        token = request(root + "/api/login", {"password": args.password}).get("token", "")
        rows = request(root + "/api/admin/cases", token=token).get("rows", [])
        changed_n = 0
        for row in rows:
            cid = row["cid"]
            if only and cid not in only:
                continue
            case = request(root + "/api/admin/case?cid=" + urllib.parse.quote(cid), token=token)
            case = {k: v for k, v in case.items() if not k.startswith("_")}
            new, changed = convert(case, args.force)
            print(summary(cid, new, changed))
            if args.show and changed:
                print(json.dumps({k: new[k] for k in ("start_information", "patient_script", "exam_results")}, ensure_ascii=False, indent=1))
            if changed:
                changed_n += 1
                if args.apply:
                    request(root + "/api/admin/case/save", {"cid": cid, "data": new}, token)
        print(f"{'저장' if args.apply else '미리 보기'}: {changed_n}건 변환" + ("" if args.apply else " (저장하려면 --apply)"))
        return 0

    if not args.input:
        ap.error("input 파일이나 --api 가 필요합니다")
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    cases = data if isinstance(data, dict) else {str(c.get("case_id", i)): c for i, c in enumerate(data)}
    out = {}
    for cid, case in cases.items():
        if only and cid not in only:
            out[cid] = case
            continue
        new, changed = convert(case, args.force)
        out[cid] = new
        print(summary(cid, new, changed), file=sys.stderr)
        if args.show and changed:
            print(json.dumps({k: new[k] for k in ("start_information", "patient_script", "exam_results")}, ensure_ascii=False, indent=1), file=sys.stderr)
    if args.output:
        Path(args.output).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{len(out)}건 → {args.output}", file=sys.stderr)
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
