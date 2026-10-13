"""로컬 ZIP 평가 서버를 키와 함께 띄운다: ~/.nova_keys(NOVA_DEV_KEY·NOVA_API_BASE·OPENAI_API_KEY)와 .env(SP_WEB_PASSWORD)를 읽어
공식 샘플 서버 실행 + CPX 웹 자동 게시를 켠다. 키는 출력하지 않는다."""
import os
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for f in (Path.home() / ".nova_keys", ROOT / ".env"):
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
os.environ.setdefault("NOVA_SAMPLE_API", os.environ.get("NOVA_API_BASE", "https://nova.snubhai.org"))
os.environ.setdefault("CPX_API", "https://yobrfksujprspfziukoa.supabase.co/functions/v1")
sys.argv = [str(ROOT / "scripts/submission_server.py"), "--devkit", str(Path.home() / "Downloads/nova-devkit")]
sys.path.insert(0, str(ROOT / "scripts"))
runpy.run_path(sys.argv[0], run_name="__main__")
