# CPX 가상 환자

N.O.V.A. 2026 진단 에이전트 대회 예선 규정(SAY·EXAM·TEST, 30자·한 번에 하나, 50턴)으로 표준화 환자를 진료하고,
S·O·A·P 초진 기록을 제출하면 CPX 방식으로 채점하는 연습 도구입니다. 사람이 웹에서 할 수도 있고, GPT·Claude 같은 AI 의사를 붙일 수도 있습니다.

- 웹: **https://lhc0312.github.io/cpx-sim/** (비밀번호는 팀 채널에서. 한 번 들어오면 1일 유지)
- 환자 응답·반려 판정·채점: gpt-6-luna (서버 쪽, 팀 공용 키)
- 채점: 정보수집 25 · 진단추론 15 · 검사·추적 10 · 안전 15 · 의사소통 15 · 효율 20, SOAP 문장별·턴별 피드백

## 1. 사람이 진료하기

1. 웹에 들어가 왼쪽 위에서 환자를 고르고 **새 진료** → 예선/본선.
2. **대화** 탭에서 대화·진찰(·검사)을 한 번에 하나씩. 묶은 질문이나 30자 초과는 반려(턴 차감 없음).
3. **SOAP 기록** 탭에 S·O·A·P와 주진단을 쓰고 제출 (쓰는 대로 자동 저장).
4. **결과** 탭: 점수·사용 턴, 영역별 점수, 대화와 SOAP 원문에 색 하이라이트 (초록 좋음 · 주황 아쉬움 · 빨강 틀림). 마우스를 올리면 피드백.

## 2. AI 의사로 진료하기 (GPT · Claude · gpt-oss)

`scripts/agent_doctor.py` 가 AI 의사를 진료 서버에 붙입니다. 사람과 같은 API·규칙·채점이고, 기록은 웹 사이드바에
`AI · 모델 이름` 제목으로 남아 결과 탭에서 똑같이 볼 수 있습니다. 파이썬 3.9 이상, 설치할 패키지는 없습니다.

```bash
git clone https://github.com/LHC0312/cpx-sim && cd cpx-sim
export CPX_PASSWORD='팀 비밀번호'
```

GPT (OpenAI)
```bash
OPENAI_API_KEY=sk-... python3 scripts/agent_doctor.py --patient 1 --model gpt-6-luna
```

Claude (Anthropic)
```bash
ANTHROPIC_API_KEY=sk-ant-... python3 scripts/agent_doctor.py --patient 1 --model claude-opus-5-5
```

대회 의사 모델 gpt-oss-20b (Groq 같은 OpenAI 호환 서버)
```bash
GROQ_API_KEY=gsk_... python3 scripts/agent_doctor.py --patient 1 --model openai/gpt-oss-20b \
  --base-url https://api.groq.com/openai/v1 --key-env GROQ_API_KEY
```

여러 환자·여러 번 돌려 점수표 보기
```bash
OPENAI_API_KEY=sk-... python3 scripts/agent_doctor.py --patient all --repeat 3 --model gpt-6-luna --quiet
```

| 옵션 | 뜻 |
|---|---|
| `--patient 1` · `1,3` · `all` | 진료할 환자 번호 (웹의 환자 번호와 같음) |
| `--model` | `claude…` 로 시작하면 Anthropic, 아니면 OpenAI 호환 API |
| `--mode 본선` | 검사(TEST)까지 허용 (기본 예선) |
| `--repeat N` | 환자마다 N번 |
| `--base-url` · `--key-env` | OpenAI 호환 서버 주소와 키가 든 환경변수 이름 |
| `--effort` | 추론 모델의 reasoning_effort |
| `--api` | 진료 서버 (기본 팀 배포판, 로컬 판은 `http://127.0.0.1:8765`) |
| `--quiet` | 대화를 찍지 않고 점수만 |

어떻게 도는가: 매 차례 AI 의사에게 규칙과 지금까지의 진료 기록을 주고 `SAY / EXAM / TEST / SUBMIT` 중 하나를 JSON 으로 받습니다.
반려되면 이유를 기록에 붙여 다시 고르게 하고, 턴을 다 쓰면 SOAP 제출을 요청합니다. 키는 환경변수나 현재 폴더의 `.env` 에서 읽습니다.
의사 모델 비용은 각자 키로 나가고, 환자·채점 비용은 서버 키로 나갑니다 (진료 1회 약 $0.005).
Groq 무료 등급은 분당 토큰 한도가 있어 진료 1회에 10분 넘게 걸릴 수 있습니다 (한도 안내만큼 기다렸다 다시 보냄).

## 3. API (다른 에이전트·Claude Code·직접 만든 코드에서)

주소 `https://yobrfksujprspfziukoa.supabase.co/functions/v1`. 로그인 말고는 모두 `Authorization: Bearer <토큰>` 이 필요합니다.
이 절을 Claude Code 같은 도구 사용 에이전트에게 주면 직접 진료할 수 있습니다.

| 요청 | 보내는 것 | 받는 것 |
|---|---|---|
| `POST /api/login` | `{"password"}` | `{"token", "days"}` |
| `GET /api/cases` | | `{"cases": [{"no", "cid", "age", "sex", "cc"}], "max_turns", "maxlen"}` |
| `POST /api/start` | `{"cid": "A", "mode": "예선"}` | 진료: `{"name", "patient": {"opening", "vitals", …}, "max_turns", …}` |
| `POST /api/act` | `{"name", "act": "SAY｜EXAM｜TEST", "text"}` | `{"ok", "out", "turn", "rejected"}` — `ok: false` 면 반려·불가 (턴 차감 없음, `out` 에 이유) |
| `POST /api/submit` | `{"name", "soap": {"S", "O", "A", "P"}, "dx"}` | 진료 + `submit`: `total`, `scores`, `judge` (문장별 `soap_sentences`, 턴별 `turn_notes`, `checklist`, `red_flags` …) |
| `GET /api/conv?name=` | | 진료 전체 (대화, 쓰다 만 SOAP, 제출 결과) |
| `POST /api/record/update` | `{"name", "title", "memo"}` | 제목·메모 |

```bash
API=https://yobrfksujprspfziukoa.supabase.co/functions/v1
TOK=$(curl -s -X POST $API/api/login -H 'Content-Type: application/json' -d "{\"password\":\"$CPX_PASSWORD\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -X POST $API/api/start -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"cid":"A","mode":"예선"}'
curl -s -X POST $API/api/act -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"name":"<start 가 준 name>","act":"SAY","text":"어디가 불편하세요?"}'
curl -s -X POST $API/api/submit -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"name":"<name>","soap":{"S":"...","O":"...","A":"...","P":"..."},"dx":"주진단"}'
```

## 4. 구성·배포

- 화면: `web/index.html` → GitHub Pages
- 엔진·API: `supabase/functions/api` (Deno) → Supabase Edge Function
- 자료: Supabase Postgres (`supabase/schema.sql`). 증례 정답·모범 답안은 DB 에만 있고 이 저장소에는 없습니다.

`main` 에 올리면 `.github/workflows/deploy.yml` 이 DB 표·함수·비밀값을 Supabase 에 배포하고 화면을 Pages 로 올립니다.
저장소 Settings → Secrets and variables → Actions 에 다음이 있어야 합니다.

| 이름 | 내용 |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase 계정 Access Token |
| `SUPABASE_PROJECT_REF` | 프로젝트 주소 `https://<ref>.supabase.co` 의 `<ref>` |
| `SP_OPENAI_API_KEY` | 서버가 쓰는 OpenAI API 키 |
| `SP_WEB_PASSWORD` | 팀 공용 접속 비밀번호 |

프롬프트·규칙은 연구 폴더의 `tools/sp_sim.py`·`tools/sp_build_cases.py`, 화면은 `tools/sp_web.html` 이 원본입니다.
고친 뒤 `tools/export_cpx_sim.py` 를 돌리면 `prompts.ts` 와 `web/index.html` 이 그대로 따라옵니다.
