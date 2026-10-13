"""서버 채점(judge)이 비어 정확도가 없는 제출 진료를 같은 기록으로 다시 채점한다.
  python3 scripts/rescore_failed.py "v4 Haiku+DB" ..."""
import sys, urllib.parse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from clinic_cli import clinic

c = clinic()
for r in c.get("/api/history")["rows"]:
    if r.get("label") in sys.argv[1:] and r.get("total") is not None and r.get("accuracy") is None:
        s = c.get("/api/conv?name=" + urllib.parse.quote(r["name"]))["submit"]
        v = c.post("/api/record/rescore", {"name": r["name"], "dx": s["dx"], "soap": s["soap"], "soap_fields": s["soap_fields"]})
        t = v.get("submit") or {}
        print(r["case"], "→", t.get("total"), (t.get("judge") or {}).get("accuracy"))
