#!/usr/bin/env python3
"""흔한 CPX 질환 평가 증례(fixtures/cpx-eval-2026, 공개 샘플과 같은 case.json + model_record.json)를 CPX API 증례 형식으로 바꾼다.

  python3 scripts/import_cpx_eval.py --output fixtures/cpx-eval-cases.json
  SP_WEB_PASSWORD=… python3 scripts/import_nova_to_api.py <api> --cases fixtures/cpx-eval-cases.json

DB 보강·에이전트 개발에 쓰지 않는 검증 전용 증례다. 정답(answers.json)은 채점에만 쓴다.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import re  # noqa: E402
import import_nova_samples  # noqa: E402
from import_nova_samples import make_case  # noqa: E402

ROOT = Path(__file__).resolve().parents[1] / "fixtures" / "cpx-eval-2026"
# 증례 작성 지시의 나이·성별 (opening 은 한국어 수사라 따로 둔다)
AGE_SEX = {"X01": (25, "남"), "X02": (47, "여"), "X03": (52, "남"), "X04": (61, "남"), "X05": (22, "남"), "X06": (68, "남"),
           "X07": (30, "여"), "X08": (58, "여"), "X09": (27, "여"), "X10": (41, "남"), "X11": (45, "여"), "X12": (35, "여"),
           "X13": (55, "남"), "X14": (38, "여"), "X15": (29, "여"), "X16": (33, "남"), "X17": (50, "남"), "X18": (48, "여"),
           "X19": (52, "남"), "X20": (64, "여"), "X21": (45, "남"), "X22": (24, "여"), "X23": (32, "여"), "X24": (57, "남")}


def parse_patient(case_id, script, record):
    cc = str(record.get("S", {}).get("cc", ""))
    name = re.search(r"이름은\s*(\S+?)(?:이고|고|,|이다)", script)
    age, sex = AGE_SEX[case_id]
    return {"name": name.group(1) if name else case_id, "age": age, "sex": sex, "chief_complaint": cc[:40], "opening": cc}


import_nova_samples.parse_patient = parse_patient


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, required=True)
    a = ap.parse_args()
    answers = json.loads((ROOT / "answers.json").read_text(encoding="utf-8"))
    cases = {}
    for cid, ans in sorted(answers.items()):
        _, data = make_case(ROOT / cid)
        data.update(status="흔한 CPX 질환 검증용 (개발에 쓰지 않음)", source="team synthetic CPX eval 2026-10-13", difficulty="보통")
        pt = data["patient"]
        m = re.search(r"이름은\s*(\S+?)(?:이고|고|,|이다)", pt["opening"])
        pt.update(cc=ans["complaint"], chief_complaint=ans["complaint"], name=m.group(1) if m else cid)
        cases[f"cpxeval-{cid}"] = data
    a.output.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(cases)}건 → {a.output}")


if __name__ == "__main__":
    main()
