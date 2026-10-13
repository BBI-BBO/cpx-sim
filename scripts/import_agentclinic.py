#!/usr/bin/env python3
"""AgentClinic-MedQA 증례(jsonl)를 대회 형식 case.json + model_record.json 뼈대로 바꾼다 (추가 연습용 참고 자료).

  python3 scripts/import_agentclinic.py \\
      --input ~/Downloads/nova-dl/bench/nova-benchmarks-2026/AgentClinic-MedQA/agentclinic_medqa_extended.jsonl \\
      --output /tmp/agentclinic-cases --limit 10

- 영어 원문을 그대로 둔다 (번역하지 않음). case.json 에 reference_only=true · language="en" 표시를 붙인다.
  대회 평가 증례가 아니며 한국어 30자 SAY 연습에 쓰려면 번역·재작성이 필요하다.
- 서버(DB)에는 넣지 않는다. 폴더에 파일만 쓴다. 넣고 싶으면 사람이 검토한 뒤 따로 올린다.
- 대응: Patient_Actor.History → patient_script, 나머지 Patient_Actor → patient_profile (엔진이 가상 환자 대본 뒤에 붙임),
  Physical_Examination_Findings → start_information.vital_signs + exam_results, Test_Results → tests (본선 TEST),
  Correct_Diagnosis → truth · model_record.diagnosis. 첫마디(opening)는 원문에 없어 인구학 정보와 주된 증상으로 만든 틀 문장이다.
- 라이선스: AgentClinic(MIT)·MedQA(MIT). 출력 폴더에 LICENSE 파일을 함께 복사하고 출처·변환 사실을 case.json 의 source 에 남긴다.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

RECORD_FIELDS = {"S": ["cc", "hpi", "pmh", "fh", "sh", "ros"], "O": ["exam", "tests"],
                 "A": ["evidence", "differential"], "P": ["tests", "treatment", "disposition", "follow_up", "education"]}
CITATION = ("Schmidgall S, et al. AgentClinic: a multimodal agent benchmark to evaluate AI in simulated clinical environments. "
            "arXiv:2405.07960 (2024); Jin D, et al. What Disease does this Patient Have? arXiv:2009.13081 (2020).")


def label(key: str) -> str:
    return str(key).replace("_", " ").strip()


def text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return " / ".join(text(v) for v in value if text(v))
    if isinstance(value, dict):
        return "; ".join(f"{label(k)}: {text(v)}" for k, v in value.items() if text(v))
    return str(value).strip()


def flatten(obj, prefix=""):
    """중첩 dict 를 (이름, 결과) 줄로 편다. 예: Imaging → Chest_CT → Findings 는 ('Imaging / Chest CT', 결과)."""
    rows = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            name = prefix if key == "Findings" and prefix else f"{prefix} / {label(key)}" if prefix else label(key)
            rows += flatten(value, name)
    elif text(obj):
        rows.append((prefix or "Findings", text(obj)))
    return rows


def age_sex(demographics: str):
    d = demographics.lower()
    m = re.search(r"(\d+)[- ](year|month|week|day)", d)
    age = int(m.group(1)) if m and m.group(2) == "year" else 0
    sex = "여" if re.search(r"\b(female|woman|girl|mother)\b", d) else "남" if re.search(r"\b(male|man|boy)\b", d) else ""
    return age, sex


def convert(raw: dict, case_id: str, src: Path, line_no: int) -> tuple[dict, dict]:
    osce = raw.get("OSCE_Examination", raw)
    actor = dict(osce.get("Patient_Actor") or {})
    demographics = text(actor.get("Demographics"))
    symptoms = actor.get("Symptoms") or {}
    primary = text(symptoms.get("Primary_Symptom")) if isinstance(symptoms, dict) else text(symptoms)
    profile = {"demographics": demographics}
    if isinstance(symptoms, dict):
        profile["primary_symptom"] = primary
        profile["secondary_symptoms"] = symptoms.get("Secondary_Symptoms") or []
    else:
        profile["symptoms"] = primary
    for key, value in actor.items():
        if key not in ("Demographics", "History", "Symptoms") and text(value):
            profile[key.lower()] = value if isinstance(value, (str, list)) else text(value)

    pe = dict(osce.get("Physical_Examination_Findings") or {})
    vitals = pe.pop("Vital_Signs", None)
    vital_text = text(vitals) if isinstance(vitals, dict) else text(vitals)
    exam_results = ([{"exam": "Vital signs", "result": vital_text}] if vital_text else []) + \
        [{"exam": name, "result": result} for name, result in flatten(pe) if result]
    tests = [{"id": f"T{i}", "name": name, "result": result}
             for i, (name, result) in enumerate(flatten(osce.get("Test_Results") or {}), 1) if result]
    truth = text(osce.get("Correct_Diagnosis"))
    age, sex = age_sex(demographics)
    opening = f"I'm a {demographics}." + (f" I came in because of {primary[0].lower() + primary[1:]}." if primary else "")
    case = {
        "case_id": case_id,
        "reference_only": True,
        "language": "en",
        "notice": "AgentClinic-MedQA 영어 원문 변환본. 대회 평가 증례가 아닌 추가 연습용 참고 자료이며 의학과 검수를 거치지 않았다. "
                  "opening 은 변환기가 만든 틀 문장이다.",
        "source": {"dataset": "AgentClinic-MedQA", "file": src.name, "line": line_no, "license": "MIT (AgentClinic), MIT (MedQA)",
                   "citation": CITATION, "converted_by": "scripts/import_agentclinic.py"},
        "objective_for_doctor": text(osce.get("Objective_for_Doctor")),
        "start_information": {"opening": opening, "vital_signs": vital_text},
        "patient_script": text(actor.get("History")),
        "patient_profile": profile,
        "exam_results": exam_results,
        "tests": tests,
        "truth": truth,
        "patient": {"name": case_id, "age": age, "sex": sex, "chief_complaint": primary, "opening": opening},
    }
    record = {sec: {field: "" for field in fields} for sec, fields in RECORD_FIELDS.items()}
    record["diagnosis"] = truth  # 나머지 칸은 비워 둔 뼈대 (사람이 채움)
    return case, record


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, required=True, help="agentclinic_medqa(_extended).jsonl")
    ap.add_argument("--output", type=Path, required=True, help="증례 폴더를 만들 곳 (AC001/case.json, AC001/model_record.json …)")
    ap.add_argument("--start", type=int, default=1, help="시작 줄 번호 (1부터)")
    ap.add_argument("--limit", type=int, default=0, help="변환할 증례 수 (0 = 전부)")
    ap.add_argument("--prefix", default="AC", help="증례 id 앞부분 (기본 AC)")
    a = ap.parse_args()

    lines = a.input.read_text(encoding="utf-8").splitlines()
    a.output.mkdir(parents=True, exist_ok=True)
    index = []
    for line_no, line in enumerate(lines, 1):
        if line_no < a.start or not line.strip():
            continue
        if a.limit and len(index) >= a.limit:
            break
        case_id = f"{a.prefix}{line_no:03d}"
        case, record = convert(json.loads(line), case_id, a.input, line_no)
        folder = a.output / case_id
        folder.mkdir(exist_ok=True)
        (folder / "case.json").write_text(json.dumps(case, ensure_ascii=False, indent=1), encoding="utf-8")
        (folder / "model_record.json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
        index.append({"case_id": case_id, "truth": case["truth"], "chief_complaint": case["patient"]["chief_complaint"],
                      "exam_rows": len(case["exam_results"]), "tests": len(case["tests"])})
    for lic in ("LICENSE.txt", "LICENSE_MedQA.txt"):
        if (a.input.parent / lic).exists():
            shutil.copyfile(a.input.parent / lic, a.output / lic)
    (a.output / "index.json").write_text(json.dumps({"reference_only": True, "language": "en", "source": "AgentClinic-MedQA",
                                                     "cases": index}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(index)}건 → {a.output} (영어 참고용, 서버에는 넣지 않음)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
