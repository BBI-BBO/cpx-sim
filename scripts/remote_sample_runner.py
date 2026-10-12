#!/usr/bin/env python3
"""Run one submission against one NOVA public sample and save a transcript.

The runner intentionally records only the public interaction returned by the
sample API. The private sample script and examiner data are never written to
the result or passed to the submitted agent.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path


def load_agent(path: Path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("nova_submission", path)
    if not spec or not spec.loader:
        raise RuntimeError(f"제출 run.py를 불러오지 못했습니다: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "prepare", None)) or not callable(getattr(module, "consult", None)):
        raise RuntimeError("run.py에 prepare()와 consult(client, state)가 모두 필요합니다")
    return module


class TraceClient:
    def __init__(self, client, case_id: str, initial: dict, on_update=None):
        self._client = client
        self.case_id = case_id
        self.initial = initial
        self.on_update = on_update
        self.events: list[dict] = []
        self.record = None
        self.diagnosis = ""

    def __getattr__(self, name):
        return getattr(self._client, name)

    def _event(self, action: str, content: str, response: dict | None = None, **extra):
        row = {"turn": sum(1 for e in self.events if e.get("action") in {"SAY", "EXAM", "TEST"}) + 1,
               "action": action, "content": content}
        if response is not None:
            row["response"] = response
        row.update(extra)
        self.events.append(row)
        if self.on_update:
            self.on_update(self)

    def say(self, content, **kwargs):
        response = self._client.say(content, **kwargs)
        self._event("SAY", str(content), response)
        return response

    def exam(self, content, **kwargs):
        response = self._client.exam(content, **kwargs)
        self._event("EXAM", str(content), response)
        return response

    def test(self, content, **kwargs):
        response = self._client.test(content, **kwargs)
        self._event("TEST", str(content), response)
        return response

    def diagnose(self, *, note, diagnosis, **kwargs):
        response = self._client.diagnose(note=note, diagnosis=diagnosis, **kwargs)
        self.record = note
        self.diagnosis = str(diagnosis)
        self.events.append({"turn": sum(1 for e in self.events if e.get("action") in {"SAY", "EXAM", "TEST"}),
                            "action": "DIAGNOSE", "diagnosis": self.diagnosis, "record": note,
                            "response": response})
        if self.on_update:
            self.on_update(self)
        return response


class LivePublisher:
    """Upsert one live CPX encounter after every public action."""
    def __init__(self, api: str, password: str, fixture: dict, case_id: str, run_id: str, encounter_name: str):
        self.api, self.password = api, password
        self.fixture, self.case_id = fixture, case_id
        self.run_id, self.encounter_name = run_id, encounter_name
        self.token = ""
        self.errors: list[str] = []

    def __call__(self, trace: TraceClient, finalized: bool = False):
        try:
            from evaluate_submission import _encounter_from_remote, _json_request
            if not self.token:
                login = _json_request(self.api.rstrip("/") + "/api/login", "POST", {"password": self.password})
                self.token = login.get("token", "")
                if not self.token:
                    raise RuntimeError("CPX 서버 로그인 토큰을 받지 못했습니다")
            remote = {"status": "completed" if finalized else "running", "initial": trace.initial,
                      "events": trace.events, "record": trace.record, "diagnosis": trace.diagnosis,
                      "score": None, "session": None}
            encounter = _encounter_from_remote(self.case_id, remote, self.fixture, self.run_id,
                                               encounter_name=self.encounter_name, finalized=finalized)
            _json_request(self.api.rstrip("/") + "/api/admin/import", "POST", {"encounters": [encounter]}, self.token)
        except Exception as exc:
            msg = f"{type(exc).__name__}: {exc}"
            if not self.errors or self.errors[-1] != msg:
                self.errors.append(msg)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--submission", required=True)
    ap.add_argument("--devkit", required=True)
    ap.add_argument("--api-base", required=True)
    ap.add_argument("--dev-key", required=True)
    ap.add_argument("--case-id", required=True)
    ap.add_argument("--display-case-id", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fixture", required=True)
    ap.add_argument("--encounter-name", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result = {"case_id": args.case_id, "status": "failed", "events": []}
    try:
        sys.path.insert(0, str(Path(args.devkit).resolve()))
        from nova_sdk import Client  # type: ignore

        agent = load_agent(Path(args.submission).resolve())
        state = agent.prepare()
        client = Client(api_base=args.api_base, token=args.dev_key, sample=True, timeout=240)
        session = client.create_sample(args.case_id)
        initial = client.session()
        fixture_data = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
        fixture = fixture_data.get(args.display_case_id, fixture_data)
        run_id = args.encounter_name.rsplit("_", 1)[-1]
        publisher = LivePublisher(os.environ.get("NOVA_PUBLISH_API", ""), os.environ.get("NOVA_PUBLISH_PASSWORD", ""),
                                  fixture, args.display_case_id, run_id, args.encounter_name) if os.environ.get("NOVA_PUBLISH_API") else None
        trace = TraceClient(client, args.display_case_id, initial.get("initial") or session.get("initial") or {}, publisher)
        client.ready()
        if publisher:
            publisher(trace)
        value = agent.consult(trace, state)
        if publisher:
            publisher(trace, finalized=True)
        final_session = client.session()
        result.update({
            "case_id": args.display_case_id,
            "status": "completed",
            "initial": trace.initial,
            "events": trace.events,
            "record": trace.record,
            "diagnosis": trace.diagnosis,
            "consult_return": value,
            "session": final_session,
            "seconds": round(time.monotonic() - started, 2),
            "turns": sum(1 for e in trace.events if e.get("action") in {"SAY", "EXAM", "TEST"}),
            "score": final_session.get("score") or final_session.get("evaluation") or final_session.get("result"),
            "publish_errors": publisher.errors if publisher else [],
        })
    except Exception as exc:
        result.update({"status": "failed", "error": f"{type(exc).__name__}: {exc}", "seconds": round(time.monotonic() - started, 2)})
    (out / "remote-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    print("NOVA_RESULT " + json.dumps({k: result.get(k) for k in ("case_id", "status", "seconds", "turns", "score", "error")}, ensure_ascii=False, default=str))
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
