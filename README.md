# CPX 가상 환자

N.O.V.A. 2026 진단 에이전트 대회 예선 규정(SAY·EXAM·TEST, 30자·한 번에 하나, 50턴)으로 표준화 환자와 진료하고,
S·O·A·P 초진 기록을 제출하면 CPX 방식으로 채점하는 연습 도구입니다. 팀 공유용.

- 화면: `web/index.html` → GitHub Pages
- 엔진·API: `supabase/functions/api` (Deno) → Supabase Edge Function. 모델은 gpt-6-luna.
- 자료: Supabase Postgres (`supabase/schema.sql`). 증례 정답·모범 답안은 DB 에만 있고 이 저장소에는 없습니다.
- 접속: 비밀번호 하나(팀 공용). 한 번 들어오면 1일 유지.

## 배포

`main` 에 올리면 `.github/workflows/deploy.yml` 이 DB 표·함수·비밀값을 Supabase 에 배포하고 화면을 Pages 로 올립니다.
저장소 Settings → Secrets and variables → Actions 에 다음을 넣어 둡니다.

| 이름 | 내용 |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase 계정 Access Token |
| `SUPABASE_PROJECT_REF` | 프로젝트 주소 `https://<ref>.supabase.co` 의 `<ref>` |
| `SP_OPENAI_API_KEY` | OpenAI API 키 |
| `SP_WEB_PASSWORD` | 팀 공용 접속 비밀번호 |

## 고칠 때

프롬프트·규칙은 연구 폴더의 `tools/sp_sim.py`·`tools/sp_build_cases.py`, 화면은 `tools/sp_web.html` 이 원본입니다.
고친 뒤 `tools/export_cpx_sim.py` 를 돌리면 `prompts.ts` 와 `web/index.html` 이 그대로 따라옵니다.
