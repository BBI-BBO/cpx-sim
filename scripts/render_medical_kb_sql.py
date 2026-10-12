#!/usr/bin/env python3
"""Render the canonical medical KB JSON as idempotent PostgreSQL seed SQL."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path


def norm(value: str) -> str:
    value = unicodedata.normalize("NFC", str(value)).casefold().strip()
    return re.sub(r"[\s.·•_\-/()\[\]{}]+", "", value)


def lit(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def json_lit(value: object) -> str:
    return lit(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) + "::jsonb"


def text_array(values: list[str]) -> str:
    return "ARRAY[" + ",".join(lit(x) for x in values) + "]::text[]"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", default=str(Path(__file__).resolve().parents[1] / "medical-db" / "cpx_core_v1.json"))
    args = parser.parse_args()
    path = Path(args.path)
    raw = path.read_bytes()
    data = json.loads(raw)
    meta = data["meta"]
    version = meta["version"]
    digest = hashlib.sha256(raw).hexdigest()

    print("begin;")
    print("update medical_kb_versions set active = false where active = true;")
    print(
        "insert into medical_kb_versions (version, pack_id, content_sha256, metadata, active) values "
        f"({lit(version)}, {lit(meta['id'])}, {lit(digest)}, {json_lit(meta)}, true) "
        "on conflict (version) do update set pack_id=excluded.pack_id, content_sha256=excluded.content_sha256, "
        "metadata=excluded.metadata, active=true, updated_at=now();"
    )
    for source in data["sources"]:
        print(
            "insert into medical_kb_sources (source_id, data, version) values "
            f"({lit(source['id'])}, {json_lit(source)}, {lit(version)}) "
            "on conflict (source_id) do update set data=excluded.data, version=excluded.version, updated_at=now();"
        )
    for exam in data["exams"]:
        terms = [exam["canonical_ko"], *exam.get("aliases", [])]
        normalized = sorted({norm(x) for x in terms if norm(x)})
        print(
            "insert into medical_kb_exams (exam_id, canonical_ko, normalized_aliases, data, version) values "
            f"({lit(exam['id'])}, {lit(exam['canonical_ko'])}, {text_array(normalized)}, {json_lit(exam)}, {lit(version)}) "
            "on conflict (exam_id) do update set canonical_ko=excluded.canonical_ko, normalized_aliases=excluded.normalized_aliases, "
            "data=excluded.data, version=excluded.version, updated_at=now();"
        )
    for profile in data["profiles"]:
        terms = [profile["canonical_ko"], profile["canonical_en"], *profile.get("aliases", [])]
        normalized = sorted({norm(x) for x in terms if norm(x)})
        print(
            "insert into medical_kb_profiles (profile_id, canonical_ko, canonical_en, normalized_aliases, data, version) values "
            f"({lit(profile['id'])}, {lit(profile['canonical_ko'])}, {lit(profile['canonical_en'])}, {text_array(normalized)}, {json_lit(profile)}, {lit(version)}) "
            "on conflict (profile_id) do update set canonical_ko=excluded.canonical_ko, canonical_en=excluded.canonical_en, "
            "normalized_aliases=excluded.normalized_aliases, data=excluded.data, version=excluded.version, updated_at=now();"
        )
    print("commit;")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

