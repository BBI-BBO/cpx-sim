#!/usr/bin/env python3
"""Small localhost service for uploading and evaluating a NOVA submission ZIP.

This is intentionally separate from the Supabase Edge Function: Supabase can
store the file, but it cannot safely execute arbitrary participant Python.  The
local service keeps execution on the developer's machine and delegates the
actual three-case run to `evaluate_submission.py` and the official devkit.
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import urllib.parse
import uuid
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from evaluate_submission import evaluate
from validate_submission import MAX_ZIP_BYTES, validate


class SubmissionHandler(SimpleHTTPRequestHandler):
    server_version = "NOVA-Local-Evaluator/1.0"

    @property
    def config(self):
        return self.server.config  # type: ignore[attr-defined]

    def _json(self, payload: dict, code: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):  # noqa: N802
        self._json({"ok": True})

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/api/submission/runs/"):
            run_id = self.path.rsplit("/", 1)[-1]
            path = self.config["runs"] / run_id / "evaluation.json"
            if not path.is_file():
                self._json({"error": "실행 결과를 찾을 수 없습니다"}, 404)
                return
            self._json(json.loads(path.read_text(encoding="utf-8")))
            return
        if self.path == "/api/submission/health":
            self._json({"ok": True, "max_zip_bytes": MAX_ZIP_BYTES})
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802
        if self.path not in {"/api/submission/validate", "/api/submission/evaluate"}:
            self._json({"error": "없는 주소"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_ZIP_BYTES + 1024 * 1024:
            self._json({"error": "ZIP 크기를 확인할 수 없거나 50MB 제한을 초과합니다"}, 413)
            return
        run_id = uuid.uuid4().hex[:12]
        run_dir = self.config["runs"] / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        # 화면은 한글 파일 이름을 encodeURIComponent 로 보낸다 (HTTP 헤더는 ASCII 만). 이 이름이 진료 기록의 실험 라벨이 된다.
        raw_name = urllib.parse.unquote(self.headers.get("X-Filename", "") or "submission.zip")
        archive = run_dir / (os.path.basename(raw_name.replace("\\", "/")).strip() or "submission.zip")
        archive.write_bytes(self.rfile.read(length))
        result = validate(archive)
        if self.path.endswith("/validate"):
            self._json({"run_id": run_id, "validation": result})
            return
        if not result["valid"]:
            self._json({"run_id": run_id, "status": "invalid", "validation": result}, 400)
            return
        pending = {
            "run_id": run_id,
            "status": "running",
            "submission": result,
            "cases": [],
        }
        (run_dir / "evaluation.json").write_text(json.dumps(pending, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        def worker():
            try:
                report = evaluate(
                    archive,
                    self.config["devkit"],
                    self.config["samples"],
                    run_dir,
                    self.config["timeout"],
                    False,
                    official_api=self.config["official_api"],
                    dev_key=self.config["dev_key"],
                    publish_api=self.config["publish_api"],
                    publish_password=self.config["publish_password"],
                    run_id=run_id,
                )
            except Exception as exc:  # keep the browser pollable on setup errors
                report = {"run_id": run_id, "status": "error", "error": str(exc), "submission": result, "cases": []}
            (run_dir / "evaluation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        threading.Thread(target=worker, name=f"nova-eval-{run_id}", daemon=True).start()
        self._json({"run_id": run_id, "status": "running", "validation": result}, 202)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--devkit", required=True, help="nova-devkit 폴더")
    parser.add_argument("--samples", default=str(Path(__file__).resolve().parents[1] / "fixtures" / "nova-samples-2026"))
    parser.add_argument("--runs", default=str(Path(__file__).resolve().parents[1] / "submission-runs"))
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    web_root = Path(__file__).resolve().parents[1] / "web"
    runs = Path(args.runs).resolve()
    runs.mkdir(parents=True, exist_ok=True)
    server = HTTPServer(("127.0.0.1", args.port), SubmissionHandler)
    server.config = {"devkit": str(Path(args.devkit).resolve()), "samples": str(Path(args.samples).resolve()), "runs": runs,
                     "timeout": args.timeout, "official_api": os.environ.get("NOVA_SAMPLE_API") or os.environ.get("NOVA_API_BASE", ""),
                     "dev_key": os.environ.get("NOVA_DEV_KEY", ""), "publish_api": os.environ.get("CPX_API", ""),
                     "publish_password": os.environ.get("SP_WEB_PASSWORD", "")}  # type: ignore[attr-defined]
    # SimpleHTTPRequestHandler serves nova-evaluate.html and the existing app.
    os.chdir(web_root)
    print(f"NOVA 환자 화면: http://127.0.0.1:{args.port}/index.html")
    print(f"NOVA ZIP 검증 화면: http://127.0.0.1:{args.port}/nova-evaluate.html")
    print("평가 모드: NOVA 공개 샘플 서버" if server.config["dev_key"] else "평가 모드: 로컬 DevKit")
    print("중지: Ctrl-C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
