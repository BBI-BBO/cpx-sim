#!/usr/bin/env python3
"""Validate the case-answer-blind CPX medical knowledge pack."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path


ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def norm(value: str) -> str:
    value = unicodedata.normalize("NFC", str(value)).casefold().strip()
    value = re.sub(r"[\s.·•_\-/()\[\]{}]+", "", value)
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", default=str(Path(__file__).resolve().parents[1] / "medical-db" / "cpx_core_v1.json"))
    args = parser.parse_args()
    path = Path(args.path)
    data = json.loads(path.read_text(encoding="utf-8"))
    errors: list[str] = []

    sources = {x.get("id") for x in data.get("sources", [])}
    exams = {x.get("id") for x in data.get("exams", [])}
    profiles = data.get("profiles", [])

    for kind, ids in (("source", sources), ("exam", exams)):
        for item_id in ids:
            if not item_id or not ID_RE.fullmatch(str(item_id)):
                errors.append(f"{kind} id 형식 오류: {item_id!r}")

    for exam in data.get("exams", []):
        missing = set(exam.get("source_ids", [])) - sources
        if missing:
            errors.append(f"exam {exam.get('id')}의 없는 source: {sorted(missing)}")
        if not exam.get("canonical_ko") or not exam.get("action_ko"):
            errors.append(f"exam {exam.get('id')}의 표준명/행동 누락")

    alias_owner: dict[str, str] = {}
    profile_ids: set[str] = set()
    for profile in profiles:
        pid = profile.get("id")
        if not pid or not ID_RE.fullmatch(str(pid)):
            errors.append(f"profile id 형식 오류: {pid!r}")
            continue
        if pid in profile_ids:
            errors.append(f"profile id 중복: {pid}")
        profile_ids.add(pid)
        missing_sources = set(profile.get("source_ids", [])) - sources
        missing_exams = set(profile.get("exam_ids", [])) - exams
        if missing_sources:
            errors.append(f"profile {pid}의 없는 source: {sorted(missing_sources)}")
        if missing_exams:
            errors.append(f"profile {pid}의 없는 exam: {sorted(missing_exams)}")
        terms = [profile.get("canonical_ko", ""), profile.get("canonical_en", ""), *profile.get("aliases", [])]
        for term in terms:
            key = norm(term)
            if not key:
                errors.append(f"profile {pid}의 빈 검색어")
                continue
            if key in alias_owner and alias_owner[key] != pid:
                errors.append(f"주호소 별칭 충돌: {term!r} → {alias_owner[key]}, {pid}")
            alias_owner[key] = pid
        mechanisms = profile.get("mechanisms", [])
        if not mechanisms:
            errors.append(f"profile {pid}의 기전 누락")
        for mechanism in mechanisms:
            mid = mechanism.get("id")
            if not mid or not ID_RE.fullmatch(str(mid)):
                errors.append(f"profile {pid}의 mechanism id 오류: {mid!r}")
            if not mechanism.get("chain") or not mechanism.get("manifestations"):
                errors.append(f"profile {pid}/{mid}의 기전 연결 또는 발현 누락")
            linked = set(mechanism.get("exam_ids", []))
            if linked - exams:
                errors.append(f"profile {pid}/{mid}의 없는 exam: {sorted(linked - exams)}")
            if not mechanism.get("discriminators") and not linked:
                errors.append(f"profile {pid}/{mid}에 구분 문진·진찰이 없음")

    if errors:
        print("의학 DB 검증 실패")
        for error in errors:
            print("-", error)
        return 1
    print(f"의학 DB 검증 완료: 주호소 {len(profiles)} · 진찰 {len(exams)} · 출처 {len(sources)} · 검색어 {len(alias_owner)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

