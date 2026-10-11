"""CPX 가상 환자 진료를 명령 한 줄씩 하는 도구 — API 키 없이 Claude Code 하위 에이전트(Haiku 등)가 의사가 될 때 쓴다.
agent_doctor.py 와 같은 서버·규칙·채점. 비밀번호는 .env(SP_WEB_PASSWORD·CPX_PASSWORD)에서 읽고 출력하지 않는다.

  python3 clinic_cli.py cases                                   # 환자 목록
  python3 clinic_cli.py start 1 --label "실험 라벨" --title "제목" --memo "메모"   # 진료 시작 → 진료 이름·첫마디·활력징후
  python3 clinic_cli.py say  <진료이름> "말 하나"                  # 질문·설명 (1턴)
  python3 clinic_cli.py exam <진료이름> "진찰 동작 하나"            # 진찰 (1턴)
  python3 clinic_cli.py submit <진료이름> <<'EOF'                  # 제출 → 점수
  {"dx": "주진단", "soap": {"S": "...", "O": "...", "A": "...", "P": "..."}}
  EOF
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_doctor import Clinic, dotenv, DEFAULT_API, WEB  # noqa: E402

TOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".clinic_token.json")


def clinic():
    api = os.environ.get("CPX_API") or DEFAULT_API
    if os.path.exists(TOK):
        t = json.load(open(TOK))
        if t.get("api") == api and time.time() - t.get("at", 0) < 20 * 3600:
            c = Clinic.__new__(Clinic); c.api, c.tok = api.rstrip("/"), t["tok"]
            return c
    pw = dotenv("CPX_PASSWORD") or dotenv("SP_WEB_PASSWORD")
    root_env = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")  # 연구 폴더 .env (어디서 실행해도)
    if not pw and os.path.exists(root_env):
        pw = next((l.split("=", 1)[1].strip() for l in open(root_env, encoding="utf-8") if l.startswith(("CPX_PASSWORD=", "SP_WEB_PASSWORD="))), "")
    c = Clinic(api, pw)
    json.dump({"api": api, "tok": c.tok, "at": time.time()}, open(TOK, "w"))
    os.chmod(TOK, 0o600)
    return c


def opt(args, k, d=""):
    return args[args.index(k) + 1] if k in args and args.index(k) + 1 < len(args) else d


def main(a):
    if len(a) < 2:
        print(__doc__); return
    c, cmd = clinic(), a[1]
    if cmd == "cases":
        for x in c.get("/api/cases")["cases"]:
            print(x["no"], x["cc"], x.get("level") or "")
    elif cmd == "start":
        cfg = c.get("/api/cases")
        case = next(x for x in cfg["cases"] if str(x["no"]) == a[2])
        meta = {"label": opt(a, "--label"), "title": opt(a, "--title") or "AI · Claude 하위 에이전트", "memo": opt(a, "--memo")}
        v = c.post("/api/start", {"cid": case["cid"], "mode": opt(a, "--mode", "예선"), **meta})
        p = v["patient"]
        print(f"진료 이름: {v['name']}\n환자: {p.get('name')} ({p.get('age')}세 {p.get('sex')})\n첫마디: {p.get('opening')}\n활력징후: {p.get('vitals')}\n"
              f"최대 {v['max_turns']}턴 · 말은 {cfg['maxlen']}자 이하·한 번에 하나만 · 예선이라 검사(TEST)는 못 하고 P에 계획으로 씀")
    elif cmd in ("say", "exam"):
        r = c.post("/api/act", {"name": a[2], "act": cmd.upper(), "text": a[3]})
        if r.get("ok"):
            print(f"[{r['turn']}턴] {'환자' if cmd == 'say' else '진찰 결과'}: {r['out']}")
        else:
            print(f"반려 (턴 차감 없음): {r.get('out')}")
    elif cmd == "submit":
        b = json.loads(sys.stdin.read())
        res = c.post("/api/submit", {"name": a[2], "soap": {k: str(b["soap"].get(k, "")) for k in "SOAP"}, "dx": b["dx"]})
        s = res["submit"]
        print(f"점수 {s['total']}/100 {s['scores']} · 주진단 정확도 {(s.get('judge') or {}).get('accuracy')} · 정답 {s.get('truth')} · {s.get('turns')}턴")
        print(f"결과 화면: {WEB}#c/{a[2]}/result")
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
