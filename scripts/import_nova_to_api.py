#!/usr/bin/env python3
"""Import the bundled NOVA sample adapter cases into the CPX API database.

The endpoint is the existing admin import route; this script does not expose the
case answers to the browser until a completed encounter, matching the current
CPX app behavior.
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path


def post(url: str, body: dict, token: str = "") -> dict:
    request = urllib.request.Request(
        url,
        method="POST",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"{url} 실패 {exc.code}: {exc.read().decode(errors='replace')[:500]}") from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("api", help="Supabase Edge Function URL (…/functions/v1)")
    parser.add_argument("--cases", default=str(Path(__file__).resolve().parents[1] / "fixtures" / "nova-samples-cases.json"))
    parser.add_argument("--password", default=os.environ.get("SP_WEB_PASSWORD", ""))
    args = parser.parse_args()
    if not args.password:
        raise SystemExit("--password 또는 SP_WEB_PASSWORD가 필요합니다")
    cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    root = args.api.rstrip("/")
    login = post(root + "/api/login", {"password": args.password})
    token = login.get("token", "")
    result = post(root + "/api/admin/import", {"cases": [{"cid": cid, "data": data} for cid, data in cases.items()]}, token)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
