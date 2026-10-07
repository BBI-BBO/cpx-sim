"""AI 의사(Claude·GPT 등)가 CPX 가상 환자와 진료하고 SOAP 를 제출하는 예제. 사람이 웹에서 하는 것과 같은 API·규칙·채점 (README 2절).

  CPX_PASSWORD=... ANTHROPIC_API_KEY=... python3 scripts/agent_doctor.py --patient 1                 # Claude Haiku (기본)
  CPX_PASSWORD=... OPENAI_API_KEY=... python3 scripts/agent_doctor.py --patient all --model gpt-6-luna --quiet

  --patient 1,3 | all   여러 환자를 차례로, --repeat N 번씩. 끝나면 점수표를 보여 준다.
  --mode 본선           검사(TEST)까지 허용
  --model              claude… 로 시작하면 Anthropic, 그 밖은 OpenAI 호환 (--base-url·--key-env 로 다른 서버도)
  --api URL            진료 서버 (기본: 팀 배포판. 로컬 판은 http://127.0.0.1:8765)

파이썬 표준 라이브러리만 쓴다. 키는 환경변수나 현재 폴더의 .env 에서 읽는다.
진료 기록은 웹 사이드바에 'AI · 모델 이름' 제목으로 남고, 결과 화면 주소를 마지막에 출력한다.
"""
import argparse, getpass, json, os, re, sys, time, urllib.error, urllib.request

DEFAULT_API = "https://yobrfksujprspfziukoa.supabase.co/functions/v1"
WEB = "https://lhc0312.github.io/cpx-sim/"

DOCTOR_SYS = """당신은 의사국가시험 CPX 응시자(의사)입니다. 가상 표준화 환자를 진료하고 초진 기록(SOAP)과 주진단을 제출합니다.

규칙 (N.O.V.A. 2026 예선 진료 규정)
- 차례마다 행동 하나만, JSON 하나로만 답합니다. JSON 밖의 글은 쓰지 않습니다.
  {{"act": "SAY", "text": "환자에게 할 말"}}            질문·설명·공감. {maxlen}자 이하, 한 번에 하나만 묻기 (1턴)
  {{"act": "EXAM", "text": "진찰 동작 하나"}}           예: "배를 눌러 볼게요" (1턴)
  {{"act": "TEST", "text": "검사 하나"}}                {test_rule} (1턴)
  {{"act": "SUBMIT", "soap": {{"S": "...", "O": "...", "A": "...", "P": "..."}}, "dx": "주진단 1개"}}   진료 끝 (0턴)
- 최대 {max_turns}턴. 두 가지를 한꺼번에 묻거나({maxlen}자 초과 포함) 진찰·검사를 묶으면 반려되고 턴은 줄지 않습니다.
- 진찰·검사 목록은 주지 않습니다. 필요한 것을 하나씩 문장으로 요청합니다.
- SOAP 에는 대화·진찰(·검사)로 실제로 얻은 것만 씁니다. 묻지 않은 것을 쓰면 '지어낸 기록'으로 감점됩니다.
  S: 환자가 말한 것 · O: 활력징후·진찰 소견 · A: 주진단 가설·근거·감별진단 · P: 검사·처치·안전 조치·추적·설명
- 채점: 정보수집 25 · 진단추론 15 · 검사·추적 10 · 안전 15(놓치면 위험한 것 확인) · 의사소통 15(환자 설문) · 효율 20
- 환자에게 인사하고, 열린 질문으로 시작해 좁혀 가고, 공감하고, 마무리에 설명과 안전망을 주는 것이 좋은 진료입니다."""


# ───────────── 설정·HTTP ─────────────
def dotenv(key):
    if os.environ.get(key):
        return os.environ[key]
    for p in (".env", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")):
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    return ""


def http(url, body=None, headers=None, timeout=300):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json", "User-Agent": "cpx-sim-agent/1.0", **(headers or {})})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{e.code} {e.read().decode(errors='ignore')[:300]}") from None


class Clinic:
    """진료 서버 (팀 배포판 또는 로컬 판). 사람이 쓰는 웹과 같은 API."""

    def __init__(self, api, password):
        self.api = api.rstrip("/")
        self.tok = http(self.api + "/api/login", {"password": password}).get("token", "")

    def get(self, path):
        return http(self.api + path, headers={"Authorization": "Bearer " + self.tok} if self.tok else {})

    def post(self, path, body):
        return http(self.api + path, body, headers={"Authorization": "Bearer " + self.tok} if self.tok else {})


# ───────────── 의사 모델 ─────────────
class Doctor:
    """OpenAI 호환(GPT·gpt-oss·Groq 등) 또는 Anthropic(Claude). 대화 전체를 매번 보낸다."""

    def __init__(self, model, base_url=None, key_env=None, effort=None):
        self.model, self.effort = model, effort
        self.claude = model.startswith("claude")
        self.base = (base_url or ("https://api.anthropic.com/v1" if self.claude else "https://api.openai.com/v1")).rstrip("/")
        self.key = dotenv(key_env or ("ANTHROPIC_API_KEY" if self.claude else "OPENAI_API_KEY"))
        if not self.key:
            sys.exit(f"{key_env or ('ANTHROPIC_API_KEY' if self.claude else 'OPENAI_API_KEY')} 가 없습니다 (환경변수나 .env)")
        self.usage = {"calls": 0, "in": 0, "out": 0}

    def __call__(self, system, messages):
        for attempt in range(30):
            try:
                if self.claude:
                    r = http(self.base + "/messages", {"model": self.model, "max_tokens": 4000, "system": system, "messages": messages},
                             {"x-api-key": self.key, "anthropic-version": "2023-06-01"})
                    self.usage["in"] += r.get("usage", {}).get("input_tokens", 0)
                    self.usage["out"] += r.get("usage", {}).get("output_tokens", 0)
                    text = "".join(b.get("text", "") for b in r.get("content", []) if b.get("type") == "text")
                else:
                    body = {"model": self.model, "messages": [{"role": "system", "content": system}] + messages,
                            "response_format": {"type": "json_object"}}
                    if self.effort:
                        body["reasoning_effort"] = self.effort
                    r = http(self.base + "/chat/completions", body, {"Authorization": "Bearer " + self.key})
                    self.usage["in"] += r.get("usage", {}).get("prompt_tokens", 0)
                    self.usage["out"] += r.get("usage", {}).get("completion_tokens", 0)
                    text = r["choices"][0]["message"].get("content") or ""
                self.usage["calls"] += 1
                return text.strip()
            except RuntimeError as e:
                limited = str(e).startswith("429")
                if attempt >= (29 if limited else 3):
                    raise
                m = re.search(r"try again in ([\d.]+)\s*(ms|s)", str(e))
                wait = (float(m.group(1)) / (1000 if m.group(2) == "ms" else 1) + 1) if m else (2 * (attempt + 1) + (10 if limited else 0))
                time.sleep(min(wait, 60))


def parse_action(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        a = json.loads(m.group(0) if m else text)
    except Exception:
        return None
    act = str(a.get("act", "")).upper()
    if act in ("SAY", "EXAM", "TEST") and str(a.get("text", "")).strip():
        return {"act": act, "text": str(a["text"]).strip()}
    if act == "SUBMIT" and str(a.get("dx", "")).strip():
        soap = a.get("soap") or {}
        return {"act": "SUBMIT", "soap": {k: str(soap.get(k, "")) for k in "SOAP"}, "dx": str(a["dx"]).strip()}
    return None


# ───────────── 진료 한 번 ─────────────
def encounter(clinic, doctor, cfg, case, mode, quiet=False):
    say = (lambda *a: None) if quiet else print
    v = clinic.post("/api/start", {"cid": case["cid"], "mode": mode})
    name, p, max_turns = v["name"], v["patient"], v["max_turns"]
    clinic.post("/api/record/update", {"name": name, "title": f"AI · {doctor.model}", "memo": f"scripts/agent_doctor.py · {mode}"})
    system = DOCTOR_SYS.format(maxlen=cfg["maxlen"], max_turns=max_turns,
                               test_rule="본선이므로 쓸 수 있습니다" if mode == "본선" else "예선이라 쓸 수 없습니다. 필요한 검사는 P에 계획으로")
    say(f"\n━━ 환자 {case['no']} · {p.get('name')} ({p.get('age')}세 {p.get('sex')}) · {mode} · {doctor.model}")
    say(f"환자: {p.get('opening')}\n활력징후: {p.get('vitals')}")
    log = [f"[시작] 환자 첫마디: \"{p.get('opening')}\" / 활력징후: {p.get('vitals')}"]
    turn, bad_streak, action, note = 0, 0, None, ""

    def prompt(extra):  # 매번 지금까지의 진료 기록 전체를 짧은 줄로 보낸다 (모델 답 JSON 은 다시 보내지 않음)
        return [{"role": "user", "content": "[지금까지의 진료]\n" + "\n".join(log) + f"\n\n남은 턴: {max_turns - turn}. {extra}"}]
    while True:
        must_submit = turn >= max_turns or bad_streak >= 6
        extra = (note + " " if note else "") + ("이제 진료를 끝낼 때입니다. SUBMIT JSON 만 내세요." if must_submit else "다음 행동을 JSON 하나로 내세요.")
        try:
            raw = doctor(system, prompt(extra))
        except RuntimeError as e:
            sys.exit(f"의사 모델 호출 실패: {e}\n제출하지 않은 진료 {name} 이(가) 남아 있습니다 (웹에서 이어 하거나 삭제).")
        action, note = parse_action(raw), ""
        if action is None:
            bad_streak += 1
            note = "(방금 답은 JSON 형식이 맞지 않았습니다. 규칙의 네 가지 중 하나를 JSON 하나로만 내세요.)"
            if bad_streak >= 10:
                action = {"act": "SUBMIT", "soap": {k: "" for k in "SOAP"}, "dx": "판단 불가"}
            else:
                continue
        if action["act"] == "SUBMIT":
            break
        if must_submit:  # 끝내라고 했는데 계속 묻는 경우
            note, bad_streak = "(더 이상 진료할 수 없습니다.)", bad_streak + 1
            continue
        r = clinic.post("/api/act", {"name": name, "act": action["act"], "text": action["text"]})
        if r.get("ok"):
            turn, bad_streak = r["turn"], 0
            obs = f"환자: {r['out']}" if r["act"] == "SAY" else f"{'진찰' if r['act'] == 'EXAM' else '검사'} 결과: {r['out']}"
            log.append(f"[{turn}턴 {action['act']}] 의사: {action['text']} → {obs}")
            say(f"[{turn:>2}턴 {action['act']}] {action['text']}\n        {obs}")
        else:
            bad_streak += 1
            obs = f"안 됨 (턴 차감 없음): {r.get('out')}"
            log.append(f"[안 됨 {action['act']}] 의사: {action['text']} → {r.get('out')}")
            say(f"[반려 {action['act']}] {action['text']}\n        {obs}")
    say(f"[제출] 주진단: {action['dx']}")
    for k in "SOAP":
        say(f"  {k}: {action['soap'][k]}")
    res = clinic.post("/api/submit", {"name": name, "soap": action["soap"], "dx": action["dx"]})
    sub = res["submit"]
    acc = (sub.get("judge") or {}).get("accuracy")
    say(f"→ 점수 {sub['total']}/100  {sub['scores']}  주진단 정확도 {acc}  정답: {sub.get('truth')}")
    say(f"   결과 화면: {WEB}#c/{name}/result")
    return {"name": name, "no": case["no"], "cc": case["cc"], "total": sub["total"], "scores": sub["scores"], "acc": acc,
            "dx": action["dx"], "truth": sub.get("truth"), "turns": sub.get("turns"), "rejected": sub.get("rejected")}


def main():
    ap = argparse.ArgumentParser(description="AI 의사가 CPX 가상 환자를 진료하고 SOAP 를 제출한다")
    ap.add_argument("--patient", default="1", help="환자 번호 (1, 1,3, all)")
    ap.add_argument("--model", default="claude-haiku-4-5-20251001", help="claude-haiku-4-5-20251001, gpt-6-luna …")
    ap.add_argument("--mode", default="예선", choices=["예선", "본선"])
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--base-url", help="OpenAI 호환 서버 주소 (예: https://api.groq.com/openai/v1)")
    ap.add_argument("--key-env", help="의사 모델 키가 든 환경변수 이름 (기본 OPENAI_API_KEY / ANTHROPIC_API_KEY)")
    ap.add_argument("--effort", help="추론 모델의 reasoning_effort (none·low·medium·high)")
    ap.add_argument("--api", default=os.environ.get("CPX_API") or DEFAULT_API, help="진료 서버 주소")
    ap.add_argument("--quiet", action="store_true", help="대화를 찍지 않고 점수만")
    a = ap.parse_args()
    pw = dotenv("CPX_PASSWORD") or dotenv("SP_WEB_PASSWORD") or getpass.getpass("진료 서버 비밀번호: ")
    clinic, doctor = Clinic(a.api, pw), Doctor(a.model, a.base_url, a.key_env, a.effort)
    cfg = clinic.get("/api/cases")
    cases = cfg["cases"] if a.patient == "all" else [c for c in cfg["cases"] if str(c["no"]) in a.patient.split(",")]
    if not cases:
        sys.exit("그런 환자가 없습니다. 있는 환자: " + ", ".join(f"{c['no']} {c['cc']}" for c in cfg["cases"]))
    rows = [encounter(clinic, doctor, cfg, c, a.mode, a.quiet) for c in cases for _ in range(a.repeat)]
    if len(rows) > 1 or a.quiet:
        print(f"\n━━ {doctor.model} · {a.mode} · {len(rows)}회")
        print(f"{'환자':<14}{'점수':>5}  {'정보':>4}{'추론':>4}{'검사':>4}{'안전':>4}{'소통':>4}{'효율':>4}  {'턴':>3}  주진단 → 정답")
        for r in rows:
            s = r["scores"]
            print(f"{str(r['no']) + ' ' + r['cc']:<14}{r['total']:>5}  {s['정보수집']:>4}{s['진단추론']:>4}{s['검사·추적']:>4}{s['안전']:>4}"
                  f"{s['의사소통']:>4}{s['효율']:>4}  {r['turns']:>3}  {r['dx']} → {r['truth']}")
        print(f"평균 {sum(r['total'] for r in rows) / len(rows):.1f}점 · 의사 모델 사용 {doctor.usage}")


if __name__ == "__main__":
    main()
