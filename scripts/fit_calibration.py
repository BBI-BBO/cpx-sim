"""우리 채점기 영역 점수 → 대회 샘플 검증 점수 보정식 맞추기.

같은 버전·같은 공개 샘플 3증례를 우리 채점기로 채점한 평균(ours)과 대회 샘플 검증 영역 점수(official)를 비교한다.
보정의 주 수단은 채점 기준(루브릭)을 대회 정의에 맞추는 것이고, 이 스크립트는 그 결과를 점검한다.
  1) 버전 순서·영역별 변화 방향이 대회와 같은지 (같지 않으면 숫자 보정이 아니라 기준을 고친다)
  2) 영역마다 남는 수준 차이를 상수 하나(b)로만 맞추고(a=1 고정, 곱하기 보정 없음),
     --holdout 버전(맞출 때 쓰지 않은 대회 점수)으로 오차를 확인한다.
--write 는 holdout 오차를 본 뒤에만 쓴다 (prompts.ts 의 CAL·CAL_VERSION). 배포는 하지 않는다.

  python3 scripts/fit_calibration.py ours.json official.json [--write]
  ours.json      {"v5": {"정보수집": 18.3, ...}, "v6c": {...}, "1.4.0": {...}}
  official.json  {"v5": {"정보수집": 11.35, ...}, "v6c": {...}}
"""
import json
import re
import sys
from pathlib import Path

DOMAINS = [("정보수집", 25), ("진단추론", 15), ("검사·추적", 10), ("안전", 15), ("의사소통", 15), ("효율", 20)]
PROMPTS = Path(__file__).resolve().parent.parent / 'supabase/functions/api/prompts.ts'


def fit(pairs):
    """상수 하나만: 대회 - 우리 의 평균 (기울기는 1로 고정)"""
    if not pairs:
        return 1.0, 0.0
    return 1.0, sum(y - x for x, y in pairs) / len(pairs)


def main():
    ours = json.loads(Path(sys.argv[1]).read_text())
    official = json.loads(Path(sys.argv[2]).read_text())
    holdout = [a.split('=', 1)[1] for a in sys.argv if a.startswith('--holdout=')]
    holdout = holdout[0].split(',') if holdout else []
    shared = [v for v in official if v in ours and v not in holdout]
    cal = {}
    print(f"맞출 때 쓴 버전: {shared} · 확인용 버전: {[v for v in holdout if v in official and v in ours]}")
    # 1) 순서·방향 점검 (보정 전)
    vs = [v for v in official if v in ours]
    for i, v1 in enumerate(vs):
        for v2 in vs[i + 1:]:
            print(f"\n[{v1} → {v2}] 우리 변화 / 대회 변화")
            for d, _ in DOMAINS:
                do, dr = ours[v2][d] - ours[v1][d], official[v2][d] - official[v1][d]
                same = '같음' if (do * dr > 0 or (abs(do) < 0.5 and abs(dr) < 0.5)) else '다름 ← 기준 점검'
                print(f"  {d}: {do:+.1f} / {dr:+.1f}  {same}")
            to, tr = sum(ours[v2].values()) - sum(ours[v1].values()), sum(official[v2].values()) - sum(official[v1].values())
            print(f"  총점: {to:+.1f} / {tr:+.1f}  {'같음' if to * tr > 0 else '다름'}")
    for d, mx in DOMAINS:
        a, b = fit([(ours[v][d], official[v][d]) for v in shared])
        cal[d] = [round(a, 3), round(b, 3)]
    print("보정식 (대회 ≈ a·우리 + b):")
    for d, _ in DOMAINS:
        print(f"  {d}: a={cal[d][0]} b={cal[d][1]}")
    print("\n버전별 우리 → 보정 (대회 실제)")
    for v, sc in ours.items():
        raw = sum(sc[d] for d, _ in DOMAINS)
        adj = {d: max(0, min(mx, cal[d][0] * sc[d] + cal[d][1])) for d, mx in DOMAINS}
        real = official.get(v)
        line = ' · '.join(f"{d} {adj[d]:.1f}" + (f"({real[d]})" if real else '') for d, _ in DOMAINS)
        print(f"  {v}: 우리 {raw:.1f} → 보정 {sum(adj.values()):.1f}" + (f" (대회 {sum(real.values()):.1f})" if real else '') + f"\n      {line}")
    errs = []
    for v in holdout:
        if v in official and v in ours:
            for d, mx in DOMAINS:
                errs.append(abs(max(0, min(mx, ours[v][d] + cal[d][1])) - official[v][d]))
    if errs:
        print(f"\n확인용 버전 영역 평균 오차: {sum(errs) / len(errs):.2f}점")
    if '--write' in sys.argv:
        if not errs:
            sys.exit('확인용(holdout) 대회 점수 없이 보정값을 쓰지 않습니다.')
        version = 'fit:' + '+'.join(shared)
        text = PROMPTS.read_text()
        text = re.sub(r'export const CAL: any = .*?;\n', f'export const CAL: any = {json.dumps(cal, ensure_ascii=False)};\n', text)
        text = re.sub(r'export const CAL_VERSION: any = .*?;\n', f'export const CAL_VERSION: any = {json.dumps(version)};\n', text)
        PROMPTS.write_text(text)
        print(f"\nprompts.ts 에 썼습니다 ({version}). 배포는 main push 로 따로.")


if __name__ == '__main__':
    main()
