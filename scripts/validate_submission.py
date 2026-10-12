#!/usr/bin/env python3
"""Validate a NOVA Python submission ZIP before it is executed.

The checks mirror the public submission contract: root-level run.py and
requirements.txt, a 50 MB compressed limit, safe ZIP paths, no symlinks, and
wheel-installable pinned PyPI requirements.  This module is intentionally
stdlib-only so it can run before installing a submission's dependencies.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import PurePosixPath


MAX_ZIP_BYTES = 50_000_000
MAX_UNPACKED_BYTES = 500_000_000
MAX_FILES = 5_000
PACKAGE_LINE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*==[^\s=]+$")


def _safe_member(name: str) -> str | None:
    if "\\" in name or name.startswith("/"):
        return "ZIP 경로는 POSIX 상대 경로여야 합니다"
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        return "경로 이동(..) 또는 절대 경로는 허용하지 않습니다"
    if not name or name.endswith("/"):
        return None
    return None


def validate(path: str | os.PathLike[str]) -> dict:
    archive = os.fspath(path)
    errors: list[str] = []
    warnings: list[str] = []
    report = {
        "path": os.path.abspath(archive),
        "filename": os.path.basename(archive),
        "compressed_bytes": os.path.getsize(archive) if os.path.exists(archive) else 0,
        "uncompressed_bytes": 0,
        "file_count": 0,
        "required_files": {"run.py": False, "requirements.txt": False},
        "python_files": 0,
        "requirements": [],
        "errors": errors,
        "warnings": warnings,
        "valid": False,
    }
    if not os.path.isfile(archive):
        errors.append("제출 ZIP 파일을 찾을 수 없습니다")
        return report
    if report["compressed_bytes"] > MAX_ZIP_BYTES:
        errors.append(f"ZIP 크기 {report['compressed_bytes']:,}바이트가 50,000,000바이트를 초과합니다")
    try:
        with zipfile.ZipFile(archive) as zf:
            infos = zf.infolist()
            report["file_count"] = len(infos)
            if len(infos) > MAX_FILES:
                errors.append(f"파일 수 {len(infos):,}개가 5,000개를 초과합니다")
            seen: set[str] = set()
            for info in infos:
                safe_error = _safe_member(info.filename)
                if safe_error:
                    errors.append(f"{info.filename}: {safe_error}")
                if info.filename in seen:
                    errors.append(f"중복 ZIP 경로: {info.filename}")
                seen.add(info.filename)
                if info.flag_bits & 0x1:
                    errors.append(f"암호화된 ZIP 항목은 허용하지 않습니다: {info.filename}")
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    errors.append(f"심볼릭 링크는 허용하지 않습니다: {info.filename}")
                if not info.is_dir():
                    report["uncompressed_bytes"] += info.file_size
            if report["uncompressed_bytes"] > MAX_UNPACKED_BYTES:
                errors.append(f"해제 용량 {report['uncompressed_bytes']:,}바이트가 500,000,000바이트를 초과합니다")
            names = {i.filename for i in infos if not i.is_dir()}
            for required in report["required_files"]:
                report["required_files"][required] = required in names
                if required not in names:
                    errors.append(f"압축 루트에 {required}가 필요합니다")
            if "run.py" in names:
                try:
                    source = zf.read("run.py").decode("utf-8")
                    compile(source, "run.py", "exec")
                except UnicodeDecodeError:
                    errors.append("run.py가 UTF-8이 아닙니다")
                except SyntaxError as exc:
                    errors.append(f"run.py 문법 오류: {exc.msg} (line {exc.lineno})")
            for info in infos:
                if info.is_dir() or not info.filename.endswith(".py"):
                    continue
                report["python_files"] += 1
                try:
                    compile(zf.read(info.filename).decode("utf-8"), info.filename, "exec")
                except UnicodeDecodeError:
                    errors.append(f"{info.filename}가 UTF-8이 아닙니다")
                except SyntaxError as exc:
                    errors.append(f"{info.filename} 문법 오류: {exc.msg} (line {exc.lineno})")
            if "requirements.txt" in names:
                raw = zf.read("requirements.txt").decode("utf-8", errors="replace")
                if "\ufffd" in raw:
                    errors.append("requirements.txt가 UTF-8이 아닙니다")
                for lineno, line in enumerate(raw.splitlines(), 1):
                    item = line.strip()
                    if not item or item.startswith("#"):
                        continue
                    report["requirements"].append(item)
                    if not PACKAGE_LINE.fullmatch(item):
                        errors.append(f"requirements.txt {lineno}행은 name==version 형식이어야 합니다: {item}")
            if any(i.filename.lower().endswith((".dockerfile", "/dockerfile", "dockerfile")) for i in infos):
                warnings.append("Dockerfile은 대회 서버가 사용하지 않으므로 제출에서 제외하는 편이 안전합니다")
    except (zipfile.BadZipFile, OSError) as exc:
        errors.append(f"유효한 ZIP을 읽지 못했습니다: {exc}")
    report["valid"] = not errors
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", help="검사할 submission.zip")
    args = parser.parse_args()
    report = validate(args.zip)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["valid"] else 2)


if __name__ == "__main__":
    main()
