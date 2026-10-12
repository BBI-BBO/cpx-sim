#!/usr/bin/env python3
"""Convert the public NOVA sample ZIP layout to the CPX simulator case format.

Usage:
    python scripts/import_nova_samples.py \
        /Users/haechan/Downloads/nova-samples-2026 \
        --output fixtures/nova-samples-cases.json

The source samples contain a single prose patient script and a model record.  The
CPX simulator needs a patient object, an answerable script, an exam table and a
reference record, so this converter keeps the original prose and derives the
small amount of adapter metadata without inventing clinical findings.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


SAMPLE_IDS = ("C01", "C03", "C10")


def lines(value: object) -> list[str]:
    """Turn a model-record field into concise reference bullets."""
    if not value:
        return []
    text = str(value).replace("\r\n", "\n")
    return [part.strip(" -*•·") for part in text.splitlines() if part.strip(" -*•·")]


def parse_patient(case_id: str, script: str, record: dict) -> dict:
    explicit = {
        "C01": {"name": "박선희", "age": 62, "sex": "여", "chief_complaint": "불면"},
        "C03": {"name": "김도현", "age": 6, "sex": "남", "chief_complaint": "또래보다 키가 작음"},
        "C10": {"name": "최윤정", "age": 32, "sex": "여", "chief_complaint": "의도치 않은 체중 감소"},
    }
    data = explicit[case_id].copy()
    data["opening"] = json.loads(json.dumps(record.get("S", {}).get("cc", ""), ensure_ascii=False))
    # Keep the exact public sample opening and vital signs in the source case.
    return data


def make_case(folder: Path) -> tuple[str, dict]:
    case_id = folder.name
    source = json.loads((folder / "case.json").read_text(encoding="utf-8"))
    record = json.loads((folder / "model_record.json").read_text(encoding="utf-8"))
    start = source["start_information"]
    script = source["patient_script"].strip()
    patient = parse_patient(case_id, script, record)
    patient["opening"] = start["opening"].strip()

    exam = [
        {"id": f"E{i:02d}", "name": row["exam"], "finding": row["result"]}
        for i, row in enumerate(source.get("exam_results", []), 1)
    ]
    s = record.get("S", {})
    o = record.get("O", {})
    a = record.get("A", {})
    p = record.get("P", {})
    diagnosis = str(record.get("diagnosis", "")).strip()

    # One answer bucket per major history area gives the simulator enough signal
    # to answer focused questions while retaining the original public script.
    qa = [
        {"q": "주호소와 현병력", "a": str(s.get("hpi", ""))},
        {"q": "과거력·약물·알레르기", "a": str(s.get("pmh", ""))},
        {"q": "가족력", "a": str(s.get("fh", ""))},
        {"q": "사회력", "a": str(s.get("sh", ""))},
        {"q": "계통 문진", "a": str(s.get("ros", ""))},
    ]

    reference = {
        "S": lines(s.get("cc")) + lines(s.get("hpi")) + lines(s.get("pmh")) + lines(s.get("fh")) + lines(s.get("sh")) + lines(s.get("ros")),
        "O": lines(start.get("vital_signs")) + lines(o.get("exam")),
        "A": {
            "main": diagnosis,
            "rationale": lines(a.get("evidence")),
            "ddx": [
                {"dx": re.sub(r"^r/o\s*", "", item, flags=re.I).split(":", 1)[0].strip(),
                 "why": item.split(":", 1)[1].strip() if ":" in item else ""}
                for item in lines(a.get("differential"))
            ],
        },
        "P": {
            "tests": lines(p.get("tests")),
            "treatment": lines(p.get("treatment")),
            "safety": lines(p.get("disposition")) + lines(p.get("education")),
            "followup": lines(p.get("follow_up")),
        },
        "red_flags": [
            "활력징후와 의식 상태 확인",
            "악화 시 즉시 내원해야 할 증상 설명",
        ],
        "communication": [
            "환자의 걱정과 기대를 확인",
            "가능성이 높은 원인과 다음 계획을 쉬운 말로 설명",
        ],
    }

    checklist = [
        {"item": "주호소·발병 시점·경과", "type": "SAY", "why": "현재 문제를 정의", "weight": 3},
        {"item": "관련 동반 증상과 위험 증상", "type": "SAY", "why": "감별과 안전성 판단", "weight": 3},
        {"item": "과거력·복용 약·알레르기", "type": "SAY", "why": "위험 요인과 처치 결정", "weight": 2},
        {"item": "가족력·사회력", "type": "SAY", "why": "위험도와 감별 보강", "weight": 1},
        *[
            {"item": row["name"], "type": "EXAM", "why": "공개 진찰 결과표의 핵심 항목", "weight": 1}
            for row in exam
        ],
    ]

    data = {
        "case_id": case_id,
        "status": "공개 샘플·로컬 검증용",
        "source": "NOVA 2026 public sample (provided by the user)",
        "patient": patient,
        "vitals": start["vital_signs"].strip(),
        "script": {"공개 샘플 대본": [script]},
        "qa": qa,
        "acting": {
            "성격·말투": "표준화 환자처럼 질문한 항목에만 답하고, 진단명은 스스로 단정하지 않습니다.",
            "걱정": ["현재 증상의 원인과 치료 필요성"],
            "기대": ["필요한 검사와 다음 계획을 알고 싶음"],
            "감정": "질환별 공개 대본의 걱정과 기대를 존중하는 자연스러운 환자 반응",
        },
        "beliefs": [],
        "exam": exam,
        "tests": [],
        "reference": reference,
        "checklist": checklist,
        "truth": diagnosis,
    }
    return case_id, data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path, help="nova-samples-2026 폴더")
    parser.add_argument("--output", type=Path, required=True, help="CPX case map JSON 경로")
    args = parser.parse_args()
    cases: dict[str, dict] = {}
    for case_id in SAMPLE_IDS:
        cid, data = make_case(args.samples / case_id)
        cases[cid] = data
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(cases)}개 NOVA 공개 샘플을 {args.output}에 기록했습니다.")


if __name__ == "__main__":
    main()
