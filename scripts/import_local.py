"""로컬 판(results/sp_sim)의 증례와 진료 기록을 Supabase 판 DB 로 옮긴다. 다시 돌려도 같은 이름은 덮어써서 안전하다.

  .venv/bin/python cpx-sim/scripts/import_local.py https://<프로젝트>.supabase.co/functions/v1
  .venv/bin/python cpx-sim/scripts/import_local.py https://<프로젝트>.supabase.co/functions/v1 --cases-only   # 증례만

비밀번호는 ../.env 의 SP_WEB_PASSWORD 를 쓴다. 정답이 든 증례는 저장소(GitHub)가 아니라 DB 로만 간다.
"""
import glob, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import sp_sim as sim  # noqa: E402


def env(key):
    for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    sys.exit(f".env 에 {key} 가 없습니다")


def call(api, path, body, tok=None):
    req = urllib.request.Request(api + path, data=json.dumps(body, ensure_ascii=False).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + tok} if tok else {})})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=120).read())
    except urllib.error.HTTPError as e:
        sys.exit(f"{path} 실패 {e.code}: {e.read().decode()[:300]}")


def legacy_case(name, start):
    if start.get("case"):
        return start["case"]
    tail = name.rsplit("_환자", 1)
    return sim.ORDER[int(tail[1]) - 1] if len(tail) == 2 and tail[1].isdigit() else None


def enc_row(path, cases):
    name = os.path.basename(path)[:-6]
    ev = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    start = dict(next(e for e in ev if e.get("type") == "start"))
    cid = legacy_case(name, start)
    c = cases.get(cid) or {}
    if not (start.get("patient") or {}).get("opening"):  # 예전 기록은 시작 기록에 환자 정보가 없다
        start["patient"], start["vitals"] = c.get("patient") or {}, start.get("vitals") or c.get("vitals")
    start.setdefault("max_turns", sim.MAX_TURNS)
    start["case"] = cid
    events = [e for e in ev if e.get("type") in ("turn", "reject")]
    subs = [e for e in ev if e.get("type") == "submit"]
    for s in subs:
        sim.norm_accuracy(s.get("judge") or {})
    drafts = [e for e in ev if e.get("type") == "draft"]
    mp = os.path.join(sim.LOGDIR, name + ".meta.json")
    meta = json.load(open(mp, encoding="utf-8")) if os.path.exists(mp) else {}
    last, p = (subs[-1] if subs else None), start["patient"]
    return {"name": name, "cid": cid, "mode": start.get("mode") or "예선", "start": start, "events": events,
            "draft": {"soap": drafts[-1].get("soap"), "dx": drafts[-1].get("dx")} if drafts and not subs else None,
            "submits": subs, "meta": meta, "usage": (last or {}).get("usage") or {"calls": 0, "in": 0, "out": 0},
            "turns": sum(1 for e in events if e.get("type") == "turn"), "n_submits": len(subs),
            "cc": p.get("chief_complaint") or "", "who": f"{p.get('age')}세 {p.get('sex') or ''}".strip() if p.get("age") else "",
            "total": last.get("total") if last else None, "dx": last.get("dx") if last else None, "truth": last.get("truth") if last else None,
            "accuracy": (last.get("judge") or {}).get("accuracy") if last else None, "scores": last.get("scores") if last else None}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    api = [x for x in sys.argv[1:] if not x.startswith("--")][0].rstrip("/")
    tok = call(api, "/api/login", {"password": env("SP_WEB_PASSWORD")}).get("token")
    cases = {cid: sim.load_case(cid) for cid in sim.case_ids()}
    r = call(api, "/api/admin/import", {"cases": [{"cid": k, "data": v} for k, v in cases.items()]}, tok)
    print("증례", r.get("cases"), "개:", " ".join(cases))
    if "--cases-only" in sys.argv:  # 증례만 (배포판의 진료 기록은 건드리지 않음)
        return
    paths = sorted(glob.glob(os.path.join(sim.LOGDIR, "*.jsonl")))
    rows = [enc_row(p, cases) for p in paths]
    for i in range(0, len(rows), 3):
        call(api, "/api/admin/import", {"encounters": rows[i:i + 3]}, tok)
    print("진료 기록", len(rows), "개:", " ".join(r["name"] for r in rows))


if __name__ == "__main__":
    main()
