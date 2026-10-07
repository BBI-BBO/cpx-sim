# CPX 가상 환자

N.O.V.A. 2026 진단 에이전트 대회 예선 규정(SAY·EXAM·TEST, 30자·한 번에 하나, 50턴)으로 표준화 환자를 진료하고,
S·O·A·P 초진 기록을 제출하면 CPX 방식으로 채점하는 연습 도구입니다. 사람은 웹에서, AI 의사(Claude·GPT 등)는 아래 API로 진료합니다.

- 웹: **https://bbi-bbo.github.io/cpx-sim/** (비밀번호는 팀 채널에서. 한 번 들어오면 1일 유지)
- 환자 응답·반려 판정·채점은 서버가 gpt-6-luna 로 합니다 (팀 공용 키).
- 채점: 정보수집 25 · 진단추론 15 · 검사·추적 10 · 안전 15 · 의사소통 15 · 효율 20, SOAP 문장별·턴별 피드백

## 1. 웹에서 진료하기

1. 왼쪽 위에서 환자를 고르고 **새 진료** → 예선/본선.
2. **대화** 탭에서 대화·진찰(·검사)을 한 번에 하나씩. 묶은 질문이나 30자 초과는 반려(턴 차감 없음).
3. **SOAP 기록** 탭에 S·O·A·P와 주진단을 쓰고 제출 (쓰는 대로 자동 저장).
4. **결과** 탭: 점수·사용 턴, 영역별 점수, 대화와 SOAP 원문에 색 하이라이트 (초록 좋음 · 주황 아쉬움 · 빨강 틀림). 마우스를 올리면 피드백.

## 2. API: 대화하고 SOAP 제출하기

AI 의사나 직접 만든 코드가 진료할 때 씁니다. 웹과 같은 서버·규칙·채점이고, 기록은 웹 사이드바에 남아 결과 탭에서 똑같이 볼 수 있습니다.
이 절을 그대로 Claude Code·Claude(Haiku 등)·GPT 같은 도구 사용 에이전트에게 주면 직접 진료할 수 있습니다.

**주소** `https://yobrfksujprspfziukoa.supabase.co/functions/v1` — 모두 JSON. 로그인 말고는 `Authorization: Bearer <토큰>` 헤더가 필요합니다.

### 흐름

```
로그인 → 환자 목록 → 진료 시작 → [대화·진찰·검사] × 최대 50턴 → SOAP 제출 → 점수·피드백
POST /api/login   GET /api/cases   POST /api/start   POST /api/act            POST /api/submit
```

**① 로그인** `POST /api/login`
```json
요청 {"password": "팀 비밀번호"}
응답 {"ok": true, "token": "1791…a3f", "days": 1}
```

**② 환자 목록** `GET /api/cases`
```json
응답 {"cases": [{"no": 1, "cid": "A", "age": 20, "sex": "여", "cc": "심한 복통"}, …], "max_turns": 50, "maxlen": 30}
```

**③ 진료 시작** `POST /api/start` — 이후 모든 요청은 응답의 `name` 으로 이 진료를 가리킵니다.
```json
요청 {"cid": "A", "mode": "예선"}            // 본선이면 검사(TEST) 가능
응답 {"name": "20261007_152919_A",
      "patient": {"name": "김서연", "age": 20, "sex": "여", "cc": "심한 복통",
                  "opening": "저는 김서연이고 스무 살이에요. 배가 너무 아파서 왔어요.",
                  "vitals": "혈압: 고혈압(수치 미기재); 맥박: 빈맥(수치 미기재); …"},
      "turn": 0, "max_turns": 50, …}
```

**④ 한 턴** `POST /api/act` — 한 번에 하나씩.
```json
요청 {"name": "20261007_152919_A", "act": "SAY",  "text": "언제부터 아프셨어요?"}
요청 {"name": "20261007_152919_A", "act": "EXAM", "text": "배를 눌러 볼게요"}
요청 {"name": "20261007_152919_A", "act": "TEST", "text": "CBC 볼게요"}       // 본선만
응답 {"ok": true,  "out": "엿새 전부터 아팠어요.", "turn": 3, "rejected": 0}
응답 {"ok": true,  "out": "복부 촉진: 복부 전체에 압통이 있다.", "turn": 4, …}
응답 {"ok": false, "out": "반려: 한 번에 하나씩 물어봐 주세요 (턴 차감 없음)", "turn": 4, "rejected": 1}
```
| act | 뜻 | 규칙 |
|---|---|---|
| `SAY` | 질문·설명·공감 | 30자 이하, 한 번에 하나만 묻기. 인사·공감 뒤에 질문 하나는 괜찮음 |
| `EXAM` | 진찰 동작 하나 | 진찰 목록은 주지 않음. 묶으면 반려. 기록에 없는 진찰은 "특이 소견 없음" |
| `TEST` | 검사 하나 | 본선만 |

`ok: false` 는 반려(규칙 위반)나 불가(예선의 TEST, 턴 소진)이며 턴은 줄지 않습니다. `out` 에 이유가 있습니다.

**⑤ SOAP 제출** `POST /api/submit` — 진료가 끝나고 채점합니다 (30초~1분).
```json
요청 {"name": "20261007_152919_A",
      "soap": {"S": "20세 여성, 6일 전부터 배 전체 통증, 구토 반복, 발열 부인",
               "O": "고혈압·빈맥, 복부 전체 압통",
               "A": "급성 간헐성 포르피린증 의심 — 근거 … / 감별: 급성 위장염, …",
               "P": "소변 PBG·전해질, 수액·진통, 신경 증상 관찰, …"},
      "dx": "급성 간헐성 포르피린증"}
응답 {"name": "…", "done": true,
      "submit": {"total": 73, "scores": {"정보수집": 22, "진단추론": 12, "검사·추적": 8, "안전": 11, "의사소통": 6, "효율": 14},
                 "truth": "급성 간헐성 포르피린증 (E80.2)", "turns": 35, "rejected": 3,
                 "judge": {"accuracy": 100, "soap_sentences": […], "turn_notes": […], "checklist": […], "red_flags": […], "soap_top": […]},
                 "patient": {"good": […], "regret": […], "ppi": {…}}}}
```
SOAP 에는 대화·진찰로 실제로 얻은 것만 씁니다. 묻지 않은 것을 쓰면 '지어낸 기록'으로 깎입니다. 결과 화면은 `https://bbi-bbo.github.io/cpx-sim/#c/<name>/result`.

**그 밖**
| 요청 | 쓰임 |
|---|---|
| `GET /api/conv?name=` | 진료 전체 (대화, 쓰다 만 SOAP, 제출 결과) |
| `POST /api/draft` `{"name", "soap", "dx"}` | 제출 전 SOAP 저장 |
| `POST /api/record/update` `{"name", "title", "memo"}` | 제목·메모 (예: `"AI · claude-haiku-4-5"` 처럼 사람 기록과 구분) |
| `POST /api/record/rescore` `{"name", "soap", "dx"}` | 대화는 그대로 두고 SOAP 만 고쳐 다시 채점 |

curl 로 해 보기
```bash
API=https://yobrfksujprspfziukoa.supabase.co/functions/v1
TOK=$(curl -s -X POST $API/api/login -H 'Content-Type: application/json' -d "{\"password\":\"$CPX_PASSWORD\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
H=(-H "Authorization: Bearer $TOK" -H 'Content-Type: application/json')
curl -s -X POST $API/api/start "${H[@]}" -d '{"cid":"A","mode":"예선"}'
curl -s -X POST $API/api/act "${H[@]}" -d '{"name":"<start 가 준 name>","act":"SAY","text":"어디가 불편하세요?"}'
curl -s -X POST $API/api/submit "${H[@]}" -d '{"name":"<name>","soap":{"S":"…","O":"…","A":"…","P":"…"},"dx":"주진단"}'
```

### 예제: AI 의사 스크립트

`scripts/agent_doctor.py` 는 위 API로 AI 의사(Claude·GPT)를 붙이는 예제입니다. 파이썬 표준 라이브러리만 씁니다.
매 차례 규칙과 지금까지의 진료 기록을 주고 `SAY / EXAM / TEST / SUBMIT` 중 하나를 JSON 으로 받아 API에 보냅니다.
```bash
CPX_PASSWORD='팀 비밀번호' ANTHROPIC_API_KEY=sk-ant-... python3 scripts/agent_doctor.py --patient 1
CPX_PASSWORD='팀 비밀번호' OPENAI_API_KEY=sk-... python3 scripts/agent_doctor.py --patient all --model gpt-6-luna --quiet
```
`--patient 1`·`1,3`·`all`, `--mode 본선`, `--repeat N`, `--model` (기본 `claude-haiku-4-5-20251001`, `claude…` 면 Anthropic, 그 밖은 OpenAI 호환), `--quiet` (점수표만).

## 3. 구성·배포

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
