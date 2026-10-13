"""cpx-sim 진료 기록을 실험 라벨별로 모아 주진단 정확도·점수·턴을 요약한다.

  python3 scripts/eval_summary.py "v4 Haiku+DB" "v4 Haiku 단독"
라벨마다 증례별 마지막 제출 진료 하나를 센다. 주진단 정확도는 서버 채점(judge.accuracy) 그대로.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from clinic_cli import clinic  # noqa: E402


def main(labels):
    rows = clinic().get("/api/history")["rows"]
    out = {}
    for lab in labels:
        done = {}
        for r in sorted((r for r in rows if r.get("label") == lab), key=lambda r: r["name"]):
            if r.get("total") is not None:
                done[r["case"]] = r
        live = sum(1 for r in rows if r.get("label") == lab and r.get("total") is None)
        acc = [r.get("accuracy") for r in done.values()]
        n = len(done)
        print(f"\n■ {lab}: 제출 {n} · 진행 중 {live}")
        if n:
            print(f"  평균 점수 {sum(r['total'] for r in done.values()) / n:.1f} · 평균 턴 {sum(r['turns'] for r in done.values()) / n:.1f}"
                  f" · 정확도 분포 {json.dumps({str(a): acc.count(a) for a in sorted(set(acc), key=str)}, ensure_ascii=False)}")
        for c, r in sorted(done.items()):
            print(f"  {c[-3:]} {r['cc'][:12]:<12} 정확도 {r.get('accuracy')} · {r['total']}점 · {r['turns']}턴 · dx={r.get('dx')} | 정답={r.get('truth')}")
        out[lab] = list(done.values())
    return out


if __name__ == "__main__":
    main(sys.argv[1:])
