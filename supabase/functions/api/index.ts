// CPX 가상 환자 API — Supabase Edge Function (Deno). 이 저장소가 원본이다 (예전 로컬 판 tools/sp_web.py · sp_sim.py 에서 옮겨 왔음).
// 가상 환자(SAY)·진찰 판정(EXAM)과 턴·반려 규칙은 NOVA 2026 개발 키트 nova_local.py 와 같게 맞춘다.
// 증례는 대회 형식 {start_information, patient_script, exam_results} (+ model_record·truth) 을 읽고, 예전 형식은 caseFacts() 가 바꿔 읽는다.
// 함수 비밀값: SP_OPENAI_API_KEY, SP_WEB_PASSWORD (GitHub Secrets → 배포 워크플로가 넣음)
// 자동으로 주어지는 값: SUPABASE_URL·서비스 키 (REST), SUPABASE_DB_URL (SP_DB_DIRECT=1 일 때만). 표마다 RLS 를 켜 두어 공개 키로는 못 읽음
import * as P from "./prompts.ts";
import postgres from "npm:postgres@3.4.5";

const env = (k: string) => Deno.env.get(k) ?? "";
const OPENAI_KEY = env("SP_OPENAI_API_KEY"), PASSWORD = env("SP_WEB_PASSWORD");
const SB_URL = env("SUPABASE_URL");
// 서비스 키: 예전 방식(JWT) 또는 새 방식(sb_secret_…, SUPABASE_SECRET_KEYS 는 {"이름": "키"} JSON)
const SB_KEY = env("SUPABASE_SERVICE_ROLE_KEY") || (() => {
  try { return Object.values(JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}"))[0] as string || ""; } catch { return ""; }
})() || env("SUPABASE_SECRET_KEY");
const SB_HEAD: Record<string, string> = SB_KEY.startsWith("sb_") ? { apikey: SB_KEY } : { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const MAX_MIN = Number(env("SP_MAX_MIN") || 30);      // NOVA 공개 샘플 진료 제한: 증례당 30분
const AUTH_DAYS = Number(env("SP_AUTH_DAYS") || 1);   // 한 번 들어오면 유지되는 날 수
const MODELS: Record<string, string> = {
  router: env("SP_ROUTER_MODEL") || "gpt-6-luna", patient: env("SP_PATIENT_MODEL") || "gpt-6-luna",
  examiner: env("SP_EXAMINER_MODEL") || env("SP_PATIENT_MODEL") || "gpt-6-luna",
  judge: env("SP_JUDGE_MODEL") || "gpt-6-luna", build: env("SP_BUILD_MODEL") || "gpt-6-luna",
};
const EFFORT: Record<string, string> = { router: "none", patient: "none", examiner: "none", judge: "medium", build: env("SP_BUILD_EFFORT") || "high" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class HttpError extends Error {
  code: number;
  constructor(msg: string, code = 400) { super(msg); this.code = code; }
}
const bad = (m: string, code = 400) => new HttpError(m, code);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = encodeURIComponent;

// 시각: 로컬 판처럼 한국 시각, 시간대 표시 없는 ISO ("2026-10-07T13:49:22")
const kst = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19);
const stamp = () => kst().replace(/[-:]/g, "").replace("T", "_");
const tms = (s: string) => Date.parse(s && s.length === 19 ? s + "Z" : s);
const SAFE = /^[\p{L}\p{N}_.\-]+$/u;
function safe(name: unknown): string {
  const n = String(name ?? "").split("/").pop() || "";
  if (!SAFE.test(n)) throw bad("이름 형식이 잘못되었습니다");
  return n;
}
// 파이썬 str.format 과 같은 자리 채우기 ({key}, {{ }})
const fmt = (t: string, v: Record<string, unknown>) =>
  t.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, k) => (m === "{{" ? "{" : m === "}}" ? "}" : String(v[k] ?? "None")));

// ───────────── DB: REST(PostgREST) 가 기본. SP_DB_DIRECT=1 이면 직접 연결(postgres.js) ─────────────
// 실측(10/07): 이 환경에서는 요청마다 직접 연결을 새로 맺어 호출당 약 1초 → REST(0.3~0.5초)가 더 빠름
const DB_URL = env("SP_DB_DIRECT") === "1" ? env("SUPABASE_DB_URL") : "";
const sql: any = DB_URL ? postgres(DB_URL, { max: 4, prepare: false, idle_timeout: 30, connect_timeout: 8, onnotice: () => {} }) : null;
let useSql = !!sql;
const JSONB = new Set(["start", "events", "draft", "submits", "meta", "usage", "scores", "data"]);
const SOAP_FIELDS: Record<string, string[]> = {
  S: ["cc", "hpi", "pmh", "fh", "sh", "ros"],
  O: ["exam", "tests"],
  A: ["evidence", "differential"],
  P: ["tests", "treatment", "disposition", "follow_up", "education"],
};
function normalizeSoapFields(input: any, soap: Record<string, string>) {
  const out: Record<string, Record<string, string>> = {};
  for (const [section, fields] of Object.entries(SOAP_FIELDS)) {
    out[section] = {};
    for (const field of fields) {
      const value = input?.[section]?.[field];
      out[section][field] = value == null ? "" : String(value);
    }
  }
  return out;
}
function soapInput(body: any) {
  const rawFields = body.note || body.soap_fields || {};
  const rawSoap = body.soap || {};
  const soap: Record<string, string> = {};
  for (const section of ["S", "O", "A", "P"]) {
    const value = rawSoap[section];
    soap[section] = typeof value === "string" ? value : Object.values(rawFields?.[section] || {}).filter(Boolean).join("\n");
  }
  return { soap, soapFields: normalizeSoapFields(rawFields, soap) };
}
const wrap = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSONB.has(k) && v !== null && v !== undefined ? sql.json(v) : v]));
const connErr = (e: any) => /connect|ECONN|ETIMEDOUT|getaddrinfo|network|CONNECTION|socket|TLS/i.test(`${e?.code ?? ""} ${e?.message ?? e}`);
async function both<T>(viaSql: () => Promise<T>, viaRest: () => Promise<T>): Promise<T> {
  if (useSql) {
    try { return await viaSql(); } catch (e) {
      if (!connErr(e)) throw e;
      console.error("DB 직접 연결 실패, REST 로 전환:", e);
      useSql = false;
    }
  }
  return await viaRest();
}
async function rest(method: string, path: string, body?: unknown, prefer = "return=representation"): Promise<any> {
  if (!SB_KEY) throw new Error("함수 환경에 Supabase 서비스 키가 없습니다");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { ...SB_HEAD, "Content-Type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`DB 오류 ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const ENC_LIST = "name,cid,mode,meta,turns,cc,who,total,dx,truth,accuracy,scores,n_submits";
const ENC_UPSERT_COLS = ["cid", "mode", "start", "events", "draft", "submits", "meta", "usage", "turns", "n_submits", "cc", "who", "total", "dx", "truth", "accuracy", "scores"];
const db = {
  encGet: (name: string) => both(
    async () => (await sql`select * from encounters where name = ${name} and deleted_at is null`)[0] ?? null,
    async () => (await rest("GET", `encounters?name=eq.${q(name)}&deleted_at=is.null&select=*`))[0] ?? null),
  encPatch: (name: string, patch: Record<string, unknown>) => both(
    async () => { await sql`update encounters set ${sql(wrap({ ...patch, updated_at: new Date() }))} where name = ${name}`; },
    async () => { await rest("PATCH", `encounters?name=eq.${q(name)}`, { ...patch, updated_at: new Date().toISOString() }, "return=minimal"); }),
  encInsert: (row: Record<string, unknown>) => both(
    async () => { await sql`insert into encounters ${sql(wrap(row))}`; },
    async () => { await rest("POST", "encounters", row, "return=minimal"); }),
  encList: () => both(
    async () => await sql`select ${sql(ENC_LIST.split(","))} from encounters where deleted_at is null order by name desc`,
    async () => await rest("GET", `encounters?deleted_at=is.null&select=${ENC_LIST}&order=name.desc`)),
  encUpsert: (rows: any[]) => both(
    async () => {
      for (const r of rows) {
        await sql`insert into encounters ${sql(wrap(r))} on conflict (name) do update set
          ${sql(Object.fromEntries(ENC_UPSERT_COLS.filter((c) => c in r).map((c) => [c, wrap({ [c]: r[c] })[c]])))}, updated_at = now()`;
      }
    },
    async () => { await rest("POST", "encounters", rows, "resolution=merge-duplicates,return=minimal"); }),
  caseRow: (cid: string) => both(
    async () => (await sql`select data, updated_at, deleted_at from cases where cid = ${cid}`)[0] ?? null,
    async () => (await rest("GET", `cases?cid=eq.${q(cid)}&select=data,updated_at,deleted_at`))[0] ?? null),
  caseList: () => both(
    async () => await sql`select cid, data, updated_at from cases where deleted_at is null`,
    async () => await rest("GET", "cases?deleted_at=is.null&select=cid,data,updated_at")),
  caseCids: () => both(
    async () => (await sql`select cid from cases`).map((r: any) => r.cid),
    async () => (await rest("GET", "cases?select=cid")).map((r: any) => r.cid)),
  caseUpsert: (cid: string, data: unknown) => both(
    async () => { await sql`insert into cases (cid, data, updated_at) values (${cid}, ${sql.json(data)}, now())
                            on conflict (cid) do update set data = excluded.data, updated_at = now()`; },
    async () => { await rest("POST", "cases", { cid, data, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal"); }),
  caseDelete: (cid: string) => both(
    async () => { await sql`update cases set deleted_at = now() where cid = ${cid}`; },
    async () => { await rest("PATCH", `cases?cid=eq.${q(cid)}`, { deleted_at: new Date().toISOString() }, "return=minimal"); }),
  caseHistory: (cid: string, data: unknown) => both(
    async () => { await sql`insert into case_history (cid, data) values (${cid}, ${sql.json(data)})`; },
    async () => { await rest("POST", "case_history", { cid, data }, "return=minimal"); }),
  failGet: (ip: string) => both(
    async () => (await sql`select n, until_ts from login_fails where ip = ${ip}`)[0] ?? null,
    async () => (await rest("GET", `login_fails?ip=eq.${q(ip)}&select=n,until_ts`))[0] ?? null),
  failDel: (ip: string) => both(
    async () => { await sql`delete from login_fails where ip = ${ip}`; },
    async () => { await rest("DELETE", `login_fails?ip=eq.${q(ip)}`, undefined, "return=minimal"); }),
  failSet: (ip: string, n: number, until: string | null) => both(
    async () => { await sql`insert into login_fails (ip, n, until_ts) values (${ip}, ${n}, ${until})
                            on conflict (ip) do update set n = excluded.n, until_ts = excluded.until_ts`; },
    async () => { await rest("POST", "login_fails", { ip, n, until_ts: until }, "resolution=merge-duplicates,return=minimal"); }),
};

// 증례는 자주 안 바뀌므로 함수 메모리에 1분 기억 (고치면 바로 지움)
const CASE_TTL = 60e3;
const caseMemo = new Map<string, { t: number; row: any }>();
let listMemo: { t: number; rows: any[] } | null = null;
function forgetCases(cid?: string) { if (cid) caseMemo.delete(cid); else caseMemo.clear(); listMemo = null; }

async function getEnc(name: string): Promise<any> {
  const R = await db.encGet(name);
  if (!R) throw bad("기록이 없습니다", 404);
  return R;
}
async function saveEnc(R: any, extra: Record<string, unknown> = {}) {
  const subs = R.submits || [], last = subs.at(-1);
  await db.encPatch(R.name, {
    events: R.events, draft: R.draft ?? null, submits: subs, meta: R.meta || {}, usage: R.usage,
    turns: R.events.filter((e: any) => e.type === "turn" || (e.type === "reject" && e.consumes_turn)).length, n_submits: subs.length,
    total: last ? last.total : null, dx: last ? last.dx : null, truth: last ? last.truth : null,
    accuracy: last ? (last.judge || {}).accuracy ?? null : null, scores: last ? last.scores : null, ...extra,
  });
}
async function getCase(cid: string, includeDeleted = false): Promise<any> {
  let m = caseMemo.get(cid);
  if (!m || Date.now() - m.t > CASE_TTL) { m = { t: Date.now(), row: await db.caseRow(cid) }; caseMemo.set(cid, m); }
  if (!m.row || (!includeDeleted && m.row.deleted_at)) throw bad("증례가 없습니다", 404);
  return m.row.data;
}
function cidKey(c: string): [number, number, number, string] {
  const i = P.ORDER.indexOf(c);
  return [i >= 0 ? 0 : 1, i >= 0 ? i : 0, c.length, c];
}
function sortCids(ids: string[]) {
  return ids.sort((a, b) => {
    const x = cidKey(a), y = cidKey(b);
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
}
async function liveCases(): Promise<any[]> {
  if (listMemo && Date.now() - listMemo.t < CASE_TTL) return listMemo.rows;
  const rows = await db.caseList();
  const order = sortCids(rows.map((r: any) => r.cid));
  listMemo = { t: Date.now(), rows: order.map((cid) => rows.find((r: any) => r.cid === cid)) };
  return listMemo.rows;
}
const casesPayload = (rows: any[]) => ({
  cases: rows.map((r: any, i: number) => ({ no: i + 1, cid: r.cid, age: r.data.patient?.age, sex: r.data.patient?.sex, cc: r.data.patient?.chief_complaint, level: r.data.difficulty || "" })),
  max_turns: P.MAX_TURNS, max_min: MAX_MIN, maxlen: P.MAXLEN,
});

// ───────────── OpenAI ─────────────
type Usage = { calls: number; in: number; out: number };
// effort: 역할 기본값 대신 쓸 추론 강도, timeoutMs: 한 번 부르는 데 기다릴 최대 시간 (넘으면 빈 답)
type ChatOpt = { effort?: string; timeoutMs?: number; signal?: AbortSignal };
type ChatOut = { text: string; finish: string };
async function chatFull(role: string, messages: any[], json = false, maxTokens = 2000, U?: Usage, opt: ChatOpt = {}): Promise<ChatOut> {
  if (!OPENAI_KEY) throw bad("서버에 SP_OPENAI_API_KEY 가 없습니다", 500);
  const body: any = { model: MODELS[role] || MODELS.patient, messages, max_completion_tokens: maxTokens };
  const effort = opt.effort ?? EFFORT[role];
  if (effort) body.reasoning_effort = effort;
  if (json) body.response_format = { type: "json_object" };
  const until = opt.timeoutMs ? Date.now() + opt.timeoutMs : 0;
  for (let a = 0; a < 3; a++) {
    const left = until ? until - Date.now() : 0;
    if (until && left < 1000) return { text: "", finish: "timeout" };
    let r: Response;
    try {
      r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
        ...(until || opt.signal ? { signal: AbortSignal.any([...(until ? [AbortSignal.timeout(left)] : []), ...(opt.signal ? [opt.signal] : [])]) } : {}),
      });
    } catch (e) {
      if (opt.signal?.aborted) return { text: "", finish: "aborted" };
      if (until && Date.now() >= until - 1000) return { text: "", finish: "timeout" };
      if (a === 2) throw bad("OpenAI 연결 오류: " + String((e as Error)?.message || e).slice(0, 200), 502);
      await sleep(1500 * (a + 1)); continue;
    }
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) {
      if (U) { U.calls++; U.in += j.usage?.prompt_tokens || 0; U.out += j.usage?.completion_tokens || 0; }
      const c = j.choices?.[0];
      return { text: String(c?.message?.content || "").trim(), finish: String(c?.finish_reason || "") };
    }
    const msg = JSON.stringify(j.error || j);
    if (/insufficient_quota|no credits/i.test(msg)) throw bad("OpenAI 계정에 크레딧이 없습니다", 502);
    if (msg.includes("reasoning_effort") && body.reasoning_effort) { delete body.reasoning_effort; continue; }
    if (msg.includes("response_format") && body.response_format) { delete body.response_format; continue; }
    if (a === 2) throw bad("OpenAI 오류: " + msg.slice(0, 200), 502);
    await sleep(1500 * (a + 1));
  }
  return { text: "", finish: "error" };
}
async function chat(role: string, messages: any[], json = false, maxTokens = 2000, U?: Usage): Promise<string> {
  return (await chatFull(role, messages, json, maxTokens, U)).text;
}
function parseJsonObj(t: string): any {
  const m = t.match(/\{[\s\S]*\}/);
  try { const v = JSON.parse(m ? m[0] : t); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
async function cjson(role: string, messages: any[], maxTokens = 2000, U?: Usage): Promise<any> {
  return parseJsonObj(await chat(role, messages, true, maxTokens, U));
}
// 채점처럼 출력이 긴 JSON 호출. 추론에 토큰을 다 써서 빈 답(finish=length)이 오거나 JSON 이 깨지거나 늦어지면
// 추론 강도를 낮춘 예비 호출(low)을 부른다: 본 호출이 일찍 실패하면 바로, hedgeMs 가 지나도 안 끝나면 나란히.
// 먼저 제대로 온 답을 쓰고 나머지는 끊는다. 둘 다 실패하거나 deadline 이 지나면 {} (호출한 쪽이 '채점 실패'로 남긴다)
async function cjsonRetry(role: string, messages: any[], maxTokens: number, U: Usage, deadline: number, ok: (j: any) => boolean, hedgeMs = 0): Promise<any> {
  const stop = new AbortController();
  const call = async (effort: string): Promise<any> => {
    const left = deadline - Date.now();
    if (left < 5e3) return null;
    try {
      const out = await chatFull(role, messages, true, maxTokens, U, { effort, timeoutMs: left, signal: stop.signal });
      const j = parseJsonObj(out.text);
      if (ok(j)) return j;
      if (!stop.signal.aborted) console.error(`${role} 빈 답/깨진 JSON (finish=${out.finish}, effort=${effort}, ${out.text.length}자)`);
    } catch (e) { if (!stop.signal.aborted) console.error(`${role} 호출 실패 (effort=${effort}):`, e); }
    return null;
  };
  const main = call(EFFORT[role] || "medium");
  let backup: Promise<any> | null = null;
  const startBackup = () => (backup ??= deadline - Date.now() > 25e3 ? call("low") : Promise.resolve(null));
  let res: any = null;
  if (!hedgeMs) {
    res = (await main) ?? (await startBackup());
  } else {
    const early = await Promise.race([main, sleep(hedgeMs).then(() => undefined)]);
    if (early) res = early;
    else if (early === null) res = await startBackup();
    else {
      const b = startBackup();
      res = await new Promise<any>((done) => {  // 먼저 성공한 쪽, 둘 다 실패면 null
        let n = 2;
        for (const pr of [main, b]) pr.then((v) => { if (v) done(v); else if (--n === 0) done(null); });
      });
    }
  }
  stop.abort();
  return res || {};
}

// ───────────── 채점 도구 (sp_sim.py 와 같음) ─────────────
const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
// 주진단 5점 척도(dx_score)를 기준으로 dx_level·accuracy 를 맞춘다. 예전 채점(dx_score 없음)은 dx_level 에서 점수를 거꾸로 채운다.
function normAccuracy(j: any) {
  if (!j || typeof j !== "object") return j;
  let ds = Math.round(num(j.dx_score));
  if (!P.DX_SCALE[ds]) {
    const lv = String(j.dx_level ?? "").trim();
    ds = Number(Object.keys(P.DX_SCALE).find((k) => P.DX_SCALE[+k][0] === lv) ?? 0);
  }
  if (P.DX_SCALE[ds]) { j.dx_score = ds; j.dx_level = P.DX_SCALE[ds][0]; }
  const band = P.DX_BAND[String(j.dx_level ?? "").trim()];
  if (band) j.accuracy = typeof j.accuracy === "number" ? Math.min(Math.max(j.accuracy, band[0]), band[1]) : Math.round((band[0] + band[1]) / 2);
  return j;
}
// 채점 모델의 분류에서 정해지는 세부 점수는 프로그램이 계산한다 (같은 분류면 같은 점수)
//  - 진단추론.주진단 = 5점 척도 환산 (5→6, 4→4.5, 3→3, 2→1.5, 1→0)
//  - 정보수집.기록 = 7 × 핵심 grounded ÷ (핵심 grounded + missed)  (ACI-Bench 식 기록 사실 대조. 묻지 않고 쓴 것은 grounded 가 아님)
//  - 안전.지어낸 기록 감점 = fabricated 1건당 -1, 최대 -3
function applyRubric(j: any) {
  if (!j || typeof j !== "object") return j;
  normAccuracy(j);
  const put = (d: string, k: string, v: number) => {  // j.sub 은 쓸 값이 있을 때만 만든다 (빈 채점 = '채점 실패' 판정 유지)
    if (!j.sub || typeof j.sub !== "object") j.sub = {};
    j.sub[d] = { ...(j.sub[d] || {}), [k]: Math.round(v * 2) / 2 };
  };
  if (P.DX_SCALE[j.dx_score]) put("진단추론", "주진단", P.DX_SCALE[j.dx_score][1]);
  const rf = j.record_facts;
  if (rf && typeof rf === "object") {
    const arr = (x: unknown) => (Array.isArray(x) ? x.filter((y) => y && typeof y === "object") : []);
    const g = arr(rf.grounded), f = arr(rf.fabricated), m = arr(rf.missed);
    rf.grounded = g; rf.fabricated = f; rf.missed = m;
    const gKey = g.some((x: any) => typeof x.key === "boolean") ? g.filter((x: any) => x.key === true).length : g.length;
    put("정보수집", "기록", gKey + m.length ? (7 * gKey) / (gKey + m.length) : g.length ? 7 : 0);
    put("안전", "지어낸 기록 감점", -Math.min(3, f.length));
  }
  return j;
}
function scoreDomains(j: any, pf: any, usage?: Usage): Record<string, number> {
  const sub = j.sub || {}, out: Record<string, number> = {};
  for (const [d, parts] of Object.entries(P.SUB_MAX as Record<string, Record<string, number>>)) {
    let t = 0;
    for (const [k, mx] of Object.entries(parts)) t += Math.max(P.SUB_MIN[k] ?? 0, Math.min(mx, num((sub[d] || {})[k])));
    out[d] = t;
  }
  // 효율의 모델 비용 10점: Doctor 호출 수 기준 (대회 샘플 검증 4판으로 확인: 7회→18.9, 55회→14.7, 90회→8.4). 사용량 정보가 없으면 중간값 5.
  const calls = num(usage?.calls);
  out["효율"] = (out["효율"] || 0) + (calls > 0 ? Math.max(0, Math.min(10, 10 - (calls - 7) / 8.5)) : 5);
  const ck = j.checklist || [];
  const wAll = ck.reduce((a: number, c: any) => a + (num(c.w ?? 1) || 1), 0);
  const wGot = ck.reduce((a: number, c: any) => a + (c.asked && c.tag !== "지어낸 기록" ? num(c.w ?? 1) || 1 : 0), 0);
  const ppi = Object.values(pf?.ppi || {}).map((v) => Math.max(0, Math.min(3, num(v))));
  // 의사소통 15 = 환자 설문(PPI) 9 + 교육 항목을 실제 SAY로 말한 비율 6 (대회: 필요한 설명을 실제로 했는가)
  const ppiPart = ppi.length ? (ppi.reduce((a, b) => a + b, 0) / ppi.length) * 3 : 0;
  const edu = Array.isArray(j.edu) ? j.edu.filter((x: any) => x && typeof x === "object") : [];
  const eduPart = edu.length ? (6 * edu.filter((x: any) => x.said === true).length) / edu.length : ppiPart * (6 / 9);
  const legacy = ppiPart + eduPart;
  const cs = (sub as any)["의사소통"];
  if (cs && typeof cs === "object") {   // 채점 모델의 CPX 의사소통 항목(대회 정의) 60% + 환자 설문·교육 항목 40%
    const CM: Record<string, number> = P.COMM_MAX || {};
    let t = 0;
    for (const [k, mx] of Object.entries(CM)) t += Math.max(0, Math.min(mx, num(cs[k])));
    out["의사소통"] = 0.6 * t + 0.4 * legacy;
  } else out["의사소통"] = legacy;
  const res: Record<string, number> = {};
  for (const [d, mx] of P.DOMAINS as [string, number][]) res[d] = Math.max(0, Math.min(mx, Math.round(out[d] || 0)));
  return res;
}
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (let line of (text || "").split(/[\r\n]+/)) {
    line = line.replace(/^\s*(?:[-•·*]|\d+[.)])\s+/, "").trim();
    const ch = [...line];
    let buf = "", depth = 0;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i], nxt = ch[i + 1] ?? "", prv = i ? ch[i - 1] : "";
      if ("([{（".includes(c)) depth++;
      else if (")]}）".includes(c)) depth = Math.max(0, depth - 1);
      const cut = depth === 0 && (";；".includes(c) || (",，".includes(c) && !(/\d/.test(prv) && /\d/.test(nxt))) ||
        (".。!?".includes(c) && (!nxt || nxt === " ")));
      if (cut) { if (".。!?".includes(c)) buf += c; if (buf.trim()) out.push(buf.trim()); buf = ""; }
      else buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}
function bullets(d: Record<string, any>) {
  const out: string[] = [];
  for (const [k, v] of Object.entries(d || {})) {
    const vals = (Array.isArray(v) ? v : [v]).filter((x) => x && !String(x).includes("기록 없음"));
    if (vals.length) out.push(`${k}: ` + vals.map(String).join(" / "));
  }
  return out.join("\n");
}

// ───────────── 증례 형식: 대회 형식 하나로 읽기 ─────────────
// 대회 형식: {start_information: {opening, vital_signs}, patient_script: "대본 한 덩어리", exam_results: [{exam, result}]}
//            + 선택 model_record {S, O, A, P, diagnosis} · truth.
// 예전 형식(PMC 로 만든 A~G: script 칸별 목록·qa·beliefs·exam·vitals)은 그 글을 그대로 이어 붙여 읽는다 (새 사실을 만들지 않음).
// scripts/convert_cases.py 가 같은 규칙으로 저장된 증례를 대회 형식으로 바꾼다. 둘을 함께 고칠 것.
type ExamRow = { exam: string; result: string };
type CaseFacts = { start_information: { opening: string; vital_signs: string }; patient_script: string; profile: string; exam_results: ExamRow[]; unified: boolean };
const txt = (v: unknown) => (v == null ? "" : String(v)).trim();
const lineList = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map(txt).filter(Boolean);
const NOT_FACT_KEYS = /성격|말투|말버릇|감정|예시/;  // 연기 지시라 대본(환자가 아는 사실)에 넣지 않음
function legacyScript(C: any): string {
  const sc = C.script || {};
  const sample = lineList(sc["공개 샘플 대본"]);
  if (sample.length) return sample.join("\n\n");  // 예전 NOVA 샘플 변환본: 원문 대본만 (qa 는 모범 기록에서 온 것이라 환자 지식이 아님)
  const out: string[] = [];
  const opening = txt(C.patient?.opening);
  if (opening) out.push(opening);
  for (const [k, v] of Object.entries(sc)) { const xs = lineList(v); if (xs.length) out.push(`${k}: ${xs.join(" / ")}`); }
  const qa = (C.qa || []).filter((x: any) => txt(x?.q) && txt(x?.a)).map((x: any) => `- ${txt(x.q)}: ${txt(x.a)}`);
  if (qa.length) out.push("자주 묻는 것:\n" + qa.join("\n"));
  const persona = Object.entries(C.persona || {}).filter(([k]) => !NOT_FACT_KEYS.test(k))
    .map(([k, v]) => [k, lineList(v).join(" / ")]).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  if (persona.length) out.push("나에 대해:\n" + persona.join("\n"));
  const acting = C.acting || {}, worry = lineList(acting["걱정"]), expect = lineList(acting["기대"]);
  if (worry.length) out.push(`걱정: ${worry.join(" / ")}`);
  if (expect.length) out.push(`바라는 것: ${expect.join(" / ")}`);
  const beliefs = (C.beliefs || []).filter((x: any) => txt(x?.belief)).map((x: any) => `- (${txt(x.kind) || "짐작"}) ${txt(x.belief)}`);
  if (beliefs.length) out.push("내 생각·들은 말:\n" + beliefs.join("\n"));
  return out.join("\n\n");
}
function legacyExams(C: any): ExamRow[] {
  const rows = (C.exam || []).map((x: any) => ({ exam: txt(x?.name ?? x?.exam), result: txt(x?.finding ?? x?.result) })).filter((r: ExamRow) => r.exam && r.result);
  const vit = txt(C.vitals);  // 예전 엔진은 활력징후를 진찰 한 줄로 따로 붙였다
  if (vit && !rows.some((r: ExamRow) => /활력|vital/i.test(r.exam))) rows.unshift({ exam: "활력징후 측정 (Vital signs)", result: vit.replace(/\s*\n+\s*/g, ", ") });
  return rows;
}
// 선택 칸 patient_profile (AgentClinic Patient_Actor 와 같은 구조): 있으면 가상 환자에게 줄 때만 대본 뒤에 "추가 정보"로 붙인다
// (patientReply). 가상 환자 규칙(PATIENT_RULES)과 사실 묶음 {"시작 정보", "대본"} 은 개발 키트 그대로 두고 대본 글만 늘어난다.
// patient_script 칸 자체에는 섞지 않는다 (편집 화면·변환 스크립트가 다시 저장해도 두 번 붙지 않게).
const PROFILE_LABEL: Record<string, string> = {
  demographics: "인적 사항", history: "현병력", symptoms: "증상", primary_symptom: "주된 증상", secondary_symptoms: "동반 증상",
  past_medical_history: "과거력", medications: "복용 약", current_medications: "복용 약", drug_history: "약물력", allergies: "알레르기", family_history: "가족력", social_history: "사회력",
  review_of_systems: "계통 문진",
};
function profileText(pp: unknown): string {
  if (!pp || typeof pp !== "object" || Array.isArray(pp)) return txt(pp);
  const out: string[] = [];
  const walk = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v)) { walk(v as Record<string, unknown>); continue; }
      const val = lineList(v).join(" / ");
      if (val) out.push(`- ${PROFILE_LABEL[k.toLowerCase()] || k}: ${val}`);
    }
  };
  walk(pp as Record<string, unknown>);
  return out.length ? "추가 정보(환자 프로필):\n" + out.join("\n") : "";
}
function caseFacts(C: any): CaseFacts {
  const si = C?.start_information || {};
  const script = txt(C?.patient_script);
  const exams: ExamRow[] = Array.isArray(C?.exam_results)
    ? C.exam_results.map((r: any) => ({ exam: txt(r?.exam), result: txt(r?.result) })).filter((r: ExamRow) => r.exam && r.result) : [];
  return {
    start_information: { opening: txt(si.opening) || txt(C?.patient?.opening), vital_signs: txt(si.vital_signs) || txt(C?.vitals) },
    patient_script: script || legacyScript(C || {}),
    profile: profileText(C?.patient_profile),
    exam_results: exams.length ? exams : legacyExams(C || {}),
    unified: !!script && exams.length > 0,
  };
}
const caseTruth = (C: any) => txt(C?.truth) || txt(C?.model_record?.diagnosis);

// ───────────── 진료 엔진 (sp_sim.py Encounter 와 같음) ─────────────
// NOVA 규칙상 빈 내용·30자 초과·잘못된 EXAM도 1턴을 사용한다. 반려 이벤트에
// consumes_turn을 남겨 화면의 반려 표시와 실제 턴 수를 동시에 보존한다.
const turnsOf = (R: any) => (R.events || []).filter((e: any) => e.type === "turn" || (e.type === "reject" && e.consumes_turn));
const rejectsOf = (R: any) => (R.events || []).filter((e: any) => e.type === "reject").length;
const maxTurns = (R: any) => R.start?.max_turns || P.MAX_TURNS;
function elapsedSec(R: any, now = Date.now() + 9 * 3600e3): number {
  const subs = R.submits || [];
  if (subs.length) return Math.round(num(subs[0].minutes) * 60);
  const t0 = tms(R.start?.time), ev = R.events || [];
  if (!t0) return 0;
  const last = ev.length ? tms(ev.at(-1).time) : t0, gap = now - last;
  return Math.max(0, Math.round((last - t0 + (gap < 10 * 60e3 ? gap : 0)) / 1000));  // 10분 넘게 쉰 시간은 빼고 셈
}
function transcript(C: any, turns: any[]) {
  const F = caseFacts(C);
  return [`[시작] 환자: ${F.start_information.opening} / 활력징후: ${F.start_information.vital_signs || "None"}`,
    ...turns.map((e: any) => `[${e.turn}턴 ${e.act}] 의사: ${e.text}\n        → ${e.out ?? `반려(${e.code || "규칙 위반"}): ${e.why}`}`)].join("\n");
}
function checkMsg(R: any): string | null {
  if ((R.submits || []).length) return "진료가 이미 끝났습니다.";
  if (MAX_MIN && elapsedSec(R) / 60 > MAX_MIN) return `시간 초과(${MAX_MIN}분). /제출 로 마무리하세요 (시간 초과는 무효 처리됩니다).`;
  if (turnsOf(R).length >= maxTurns(R)) return `${maxTurns(R)}턴을 모두 썼습니다. /제출 로 마무리하세요.`;
  return null;
}
// 반려. code 는 개발 키트·대회 서버의 오류 코드 (EMPTY_CONTENT, CONTENT_TOO_LONG, EXAM_NOT_SPECIFIC, EXAM_NOT_RECOGNIZED 는 1턴 사용)
function reject(R: any, act: string, text: string, why: string, code: string) {
  const consumesTurn = P.TURN_USING_REFUSALS.includes(code);
  const turn = turnsOf(R).length + (consumesTurn ? 1 : 0);
  R.events.push({ type: "reject", act, text, why, code, turn: consumesTurn ? turn : undefined, consumes_turn: consumesTurn, time: kst() });
  return { ok: false, code, out: `반려: ${why} (${consumesTurn ? "1턴 사용" : "턴 차감 없음"})` };
}
// 모델 답에서 첫 JSON 객체 (nova_local.first_json 과 같음)
function firstJson(text: string): any {
  const t = text || "";
  for (let i = t.indexOf("{"); i >= 0; i = t.indexOf("{", i + 1)) {
    for (let j = t.indexOf("}", i); j >= 0; j = t.indexOf("}", j + 1)) {
      try { const v = JSON.parse(t.slice(i, j + 1)); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* 더 긴 조각으로 */ }
    }
  }
  return null;
}
const nfc = (s: unknown) => String(s ?? "").normalize("NFC");
// 가상 환자: 시작 정보 + 대본만 알고, 지금까지의 SAY 대화와 이번 의사 말을 JSON 으로 받는다 (nova_local.Simulator.patient 와 같음)
async function patientReply(R: any, F: CaseFacts, utterance: string, U: Usage): Promise<{ out: string; effective: string }> {
  const conversation = turnsOf(R).filter((e: any) => e.type === "turn" && e.act === "SAY")
    .map((e: any) => ({ doctor: e.effective || e.text, patient: e.out }));
  const facts = { "시작 정보": F.start_information, "대본": [F.patient_script, F.profile].filter(Boolean).join("\n\n") };
  const msgs = [{ role: "system", content: P.PATIENT_RULES + "\n\n" + JSON.stringify(facts) },
    { role: "user", content: JSON.stringify({ "대화": conversation, "의사": utterance }) }];
  let text = "";
  for (let a = 0; a < 2; a++) {  // 대회 서버처럼 두 번까지
    text = await chat("patient", msgs, true, 2048, U);
    const j = firstJson(text);
    if (j && typeof j.content === "string" && j.content.trim()) {
      const eff = nfc(j.effective_content);
      return { out: nfc(j.content).trim(), effective: eff.trim() && utterance.includes(eff) ? eff : utterance };
    }
  }
  if (text.trim() && !text.trimStart().startsWith("{")) return { out: nfc(text).trim(), effective: utterance };
  throw bad("가상 환자 응답이 올바르지 않습니다 (PATIENT_RESPONSE_INVALID). 턴은 쓰지 않았으니 다시 보내 주세요.", 503);
}
// 진찰 판정: 요청을 진찰표 한 행에 대응. 없으면 too_broad / not_exam / unlisted (nova_local.Simulator.examine 과 같음)
const bigrams = (s: string) => { const t = s.toLowerCase().replace(/\s+/g, ""); const g = new Set<string>(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
function closestRow(request: string, rows: Record<string, any>): string {
  const want = bigrams(request);
  let best = 0, code = "";
  for (const [c, row] of Object.entries(rows)) {
    const g = bigrams(row.exam), inter = [...want].filter((x) => g.has(x)).length, uni = new Set([...want, ...g]).size;
    const sc = inter / Math.max(1, uni);
    if (sc > best) { best = sc; code = c; }
  }
  return best >= 0.2 ? code : "unlisted";
}
const maneuverKey = (s: string) => nfc(s).toLowerCase().replace(/[\s·,./()[\]\-]+/g, "");
async function examine(R: any, F: CaseFacts, request: string, U: Usage):
  Promise<{ out: string; row: string | null; exam: string; key?: string } | { code: string; why: string }> {
  const rows: Record<string, any> = {};
  F.exam_results.forEach((r, i) => { rows[`r${String(i + 1).padStart(2, "0")}`] = r; });
  const table = Object.entries(rows).map(([c, r]) => `${c} | ${r.exam}`).join("\n");
  const msgs = [{ role: "system", content: P.EXAMINER_RULES + "\n\n진찰표 (id | 진찰):\n" + table },
    { role: "user", content: JSON.stringify({ request }) }];
  let outcome: string | null = null, maneuver = "";
  for (let a = 0; a < 2; a++) {
    const j = firstJson(await chat("examiner", msgs, true, 2048, U)) || {};
    let id = j.id;
    if (Array.isArray(id) && id.length === 1) id = id[0];
    if (typeof id === "string" && rows[id]) { outcome = id; break; }
    if (id == null && ["too_broad", "unlisted", "not_exam"].includes(j.reason)) { outcome = j.reason; maneuver = String(j.maneuver || ""); break; }
  }
  outcome ??= closestRow(request, rows);  // 판정 모델이 형식을 못 지키면 이름이 가장 비슷한 행
  if (outcome === "not_exam") return { code: "EXAM_NOT_RECOGNIZED", why: "신체진찰 동작으로 인식하지 못했습니다" };
  if (outcome === "too_broad") return { code: "EXAM_NOT_SPECIFIC", why: "진찰 동작 하나를 구체적으로 요청해 주세요 (전신·부위 전체·여러 동작 묶음은 안 됨)" };
  if (outcome === "unlisted") return await writeFinding(R, F, request, maneuver || request, U);
  return { out: rows[outcome].result, row: outcome, exam: rows[outcome].exam };
}
// 진찰표에 없는 실제 진찰: 진찰표와 같은 형식의 소견을 한 번 지어내고, 이 진료에서 같은 진찰을 다시 하면 같은 답
async function writeFinding(R: any, F: CaseFacts, request: string, maneuver: string, U: Usage) {
  const key = maneuverKey(maneuver);
  const prev = (R.events || []).find((e: any) => e.type === "turn" && e.act === "EXAM" && e.written_key === key);
  if (prev) return { out: prev.out, row: null, exam: maneuver, key };
  const table = F.exam_results.map((r) => `${r.exam} | ${r.result}`).join("\n");
  const msgs = [{ role: "system", content: P.EXAM_RESULT_RULES + "\n\n시작 정보: " + JSON.stringify(F.start_information) + "\n\n진찰표 (진찰 | 결과):\n" + table },
    { role: "user", content: JSON.stringify({ request, maneuver }) }];
  for (let a = 0; a < 2; a++) {
    const result = nfc((firstJson(await chat("examiner", msgs, true, 2048, U)) || {}).result).trim();
    if (result && [...result].length <= 200 && !result.includes("\n") && !P.VAGUE_RESULTS.includes(result.replace(/\s+/g, ""))) {
      return { out: result, row: null, exam: maneuver, key };
    }
  }
  throw bad("진찰 판정 응답이 올바르지 않습니다 (EXAMINER_RESPONSE_INVALID). 턴은 쓰지 않았으니 다시 보내 주세요.", 503);
}
// 공통 입력 검사: 빈 내용·30자(NFC) 초과는 1턴 사용
function inputError(R: any, kind: string, text: string) {
  if (!text.trim()) return reject(R, kind, text, "내용이 비어 있습니다", "EMPTY_CONTENT");
  const len = [...text].length;
  if (len > P.MAXLEN) return reject(R, kind, text, `${len}자입니다. ${P.MAXLEN}자 이하로 줄여 주세요`, "CONTENT_TOO_LONG");
  return null;
}
async function say(R: any, C: any, text: string, U: Usage) {
  const m = checkMsg(R);
  if (m) return { ok: false, out: m, code: "TURN_LIMIT_REACHED" };
  const u = nfc(text);
  const err = inputError(R, "SAY", u);
  if (err) return err;
  const { out, effective } = await patientReply(R, caseFacts(C), u, U);
  R.events.push({ type: "turn", turn: turnsOf(R).length + 1, act: "SAY", text: u, out, ...(effective !== u ? { effective } : {}), time: kst() });
  return { ok: true, out };
}
async function act(R: any, C: any, kind: string, text: string, U: Usage) {
  const m = checkMsg(R);
  if (m) return { ok: false, out: m, code: "TURN_LIMIT_REACHED" };
  const u = nfc(text);
  if (kind === "TEST" && R.mode !== "본선") return { ok: false, code: "ACTION_NOT_AVAILABLE", out: "예선에서는 검사(TEST)를 할 수 없습니다. 필요한 검사는 SOAP의 P에 계획으로 쓰세요. (턴 차감 없음)" };
  const err = inputError(R, kind, u);
  if (err) return err;
  if (kind === "EXAM") {
    const r = await examine(R, caseFacts(C), u, U);
    if ("code" in r) return reject(R, "EXAM", u, r.why, r.code);
    R.events.push({ type: "turn", turn: turnsOf(R).length + 1, act: "EXAM", text: u, id: r.row, exam: r.exam, ...(r.key ? { written_key: r.key } : {}), out: r.out, time: kst() });
    return { ok: true, out: r.out };
  }
  // 본선 TEST: 개발 키트에는 없는 행동이라 예전 규칙 그대로 (검사 목록 한 줄, 없으면 턴 차감 없이 반려)
  const pool = [...(C.tests || [])];
  const items = pool.map((x) => `${x.id}: ${x.name}`).join("\n") || "(없음)";
  const r = await cjson("router", [{ role: "system", content: fmt(P.ACT_ROUTER, { what: "검사", items }) }, { role: "user", content: u }], 2000, U);
  let n = parseInt(String(r.items ?? 1)); if (isNaN(n)) n = 1;
  if (n >= 2) return reject(R, kind, u, `검사는 한 번에 하나만 요청해 주세요 — ${r.why ?? ""}`.replace(/[ —]+$/, ""), "TEST_NOT_SPECIFIC");
  const hit = pool.find((x) => x.id === r.id);
  if (!hit) return reject(R, kind, u, "대회에서 제공하지 않는 검사입니다", "TEST_NOT_AVAILABLE");
  const out = `${hit.name}: ${hit.finding || hit.result}`;
  R.events.push({ type: "turn", turn: turnsOf(R).length + 1, act: kind, text: u, id: r.id ?? null, out, time: kst() });
  return { ok: true, out };
}
// 채점은 네 갈래로 나눠 동시에 부른다 (긴 SOAP·40턴 넘는 진료에서 한 번에 다 내라고 하면 추론만 하다 토큰이 끝나 빈 답이 왔다).
//  core = 점수·체크리스트·기록 사실·red flag·영역별 이유, fb = SOAP 피드백(soap_top·soap_more·good·unnecessary),
//  sents = 문장 조각별 평가, turns = 턴별 평가. 점수는 core 만으로 정해지고 나머지는 실패해도 점수는 남는다.
// 함수 실행 시간 한도(약 150초) 안에 끝나도록 전체 채점에 쓸 시간을 정해 두고, 그 안에서만 다시 부른다.
const JUDGE_BUDGET_MS = Number(env("SP_JUDGE_BUDGET_SEC") || 130) * 1000;
const JUDGE_PART: Record<string, string> = {
  core: "\n\n[이번 호출에서 낼 것] 위 출력 형식에서 soap_sentences·turn_notes·soap_top·soap_more·good·unnecessary 는 빼고 나머지 키(dx_score·dx_level·accuracy·accuracy_note·sub·record_facts·reasons·checklist·red_flags·edu)를 모두 답합니다. " +
    "SOAP 피드백·문장별·턴별 평가는 다른 채점위원이 따로 합니다.",
  fb: "\n\n[이번 호출에서 낼 것] 위 루브릭 중 [SOAP 피드백]만 합니다. 점수·체크리스트·문장별·턴별 평가는 다른 채점위원이 따로 합니다.\n" +
    "출력 형식의 soap_top·soap_more·good·unnecessary 네 키만 JSON으로 답합니다.",
  sents: "\n\n[이번 호출에서 낼 것] 위 루브릭 중 [문장별 평가]만 합니다. 점수·체크리스트·피드백은 다른 채점위원이 따로 합니다.\n" +
    "[문장 조각별 번호]의 모든 조각을 빠짐없이 순서대로 판정해 {\"soap_sentences\": [{\"id\": \"S1\", \"verdict\": \"good|warn|bad\", \"tag\": \"...\", \"note\": \"한 줄\"}]} 하나만 JSON으로 답합니다. note 는 짧게 씁니다.",
  turns: "\n\n[이번 호출에서 낼 것] 위 루브릭 중 [턴별 평가]만 합니다. 점수·체크리스트·피드백은 다른 채점위원이 따로 합니다.\n" +
    "진료 기록의 모든 의사 턴을 순서대로 판정해 {\"turn_notes\": [{\"turn\": 1, \"verdict\": \"good|warn|bad\", \"note\": \"한 줄\"}]} 하나만 JSON으로 답합니다. note 는 짧게 씁니다.",
};
const JUDGE_TOKENS: Record<string, number> = { core: 16000, fb: 10000, sents: 16000, turns: 10000 };
// 점수를 정하는 core 가 이 시간 안에 안 끝나면 추론 강도 low 예비 호출을 나란히 띄운다 (먼저 온 답을 씀)
const JUDGE_HEDGE_MS = Number(env("SP_JUDGE_HEDGE_SEC") || 75) * 1000;
const JUDGE_OK: Record<string, (j: any) => boolean> = {
  core: (j) => !!j && (typeof j.sub === "object" && !!j.sub || (Array.isArray(j.checklist) && j.checklist.length > 0)),
  fb: (j) => Array.isArray(j?.soap_top) || Array.isArray(j?.soap_more),
  sents: (j) => Array.isArray(j?.soap_sentences),
  turns: (j) => Array.isArray(j?.turn_notes),
};
async function submit(R: any, C: any, soap: Record<string, string>, soapFields: Record<string, any>, dx: string, U: Usage, rescore = false) {
  const t0 = Date.now(), deadline = t0 + JUDGE_BUDGET_MS;
  const subs = R.submits || [], turns = turnsOf(R), rejected = rejectsOf(R);
  const mins = rescore && subs.length ? num(subs[0].minutes) : elapsedSec(R) / 60;
  const overtime = !!MAX_MIN && mins > MAX_MIN;
  const split: Record<string, string[]> = {};
  for (const k of "SOAP") split[k] = splitSentences(soap[k] || "");
  const numbered = [..."SOAP"].flatMap((k) => split[k].map((x, i) => `[${k}${i + 1}] ${x}`)).join("\n") || "(비어 있음)";
  const F = caseFacts(C), truth = caseTruth(C), tr = transcript(C, turns);
  const ref = `[정답(최종 확진)] ${truth}\n[모범 답안: 검사 전(SAY+EXAM) 기준 초진 기록]\n${JSON.stringify(C.reference || C.model_record || {}, null, 1)}\n`;
  const ck = `[체크리스트]\n${JSON.stringify(C.checklist || [])}\n`;
  const exam = `[이 증례에서 진찰로 얻을 수 있던 소견]\n${JSON.stringify(F.exam_results)}\n[환자가 잘못 알거나 모르는 것]\n${JSON.stringify(C.beliefs || [])}\n`;
  const mode = `[진료 방식] 모드 ${R.mode} · 사용 ${turns.length}/${maxTurns(R)}턴 · 반려 ${rejected}회\n`;
  // 개발 키트·ZIP 에서 들여온 진료는 사용량 기록이 없다 (0회). 그때는 없는 값으로 효율을 깎지 않게 알려 준다
  const usage = U.calls > 0
    ? `[모델 사용량] 호출 ${U.calls}회 · 입력 ${U.in}토큰 · 출력 ${U.out}토큰. 효율 점수에서 불필요한 호출·출력과 행동 턴 비용을 함께 고려하되, 필요한 임상 추론 호출은 불이익을 주지 마세요.\n`
    : `[모델 사용량] 기록 없음 (외부에서 들여온 진료). 효율은 턴 수·반려·질문의 중복과 순서로만 매기고, 사용량을 이유로 깎지 않습니다.\n`;
  const fields = `[제출한 초진 기록 — 공식 필드별 JSON]\n${JSON.stringify(soapFields, null, 1)}\n`;
  const user: Record<string, string> = {
    core: ref + ck + exam + mode + usage + `[진료 기록]\n${tr}\n\n` + fields + `주진단: ${dx}`,
    fb: ref + ck + exam + `[진료 기록]\n${tr}\n\n` + fields + `주진단: ${dx}`,
    sents: ref + exam + `[진료 기록]\n${tr}\n\n[문장 조각별 번호]\n${numbered}\n주진단: ${dx}`,
    turns: ref + ck + exam + mode + `[진료 기록]\n${tr}\n주진단: ${dx}`,
  };
  const p = C.patient || {}, acting = { ...(C.acting || {}), ...(C.persona || {}) };
  // 대화는 그대로이므로 환자 설문은 처음 것을 쓴다. 단 ZIP·NOVA 실행에서 들여온 기록처럼 설문이 비어 있으면 새로 받는다
  const last = rescore && subs.length ? subs.at(-1).patient : null;
  const prevPatient = last && last.ppi && Object.keys(last.ppi).length ? last : null;
  // 채점 호출 사용량은 진료(의사) 사용량과 따로 센다 — 섞이면 다시 채점할 때마다 효율 근거가 부풀었다
  const JU: Usage = { calls: 0, in: 0, out: 0 };
  const part = (k: string) => cjsonRetry("judge", [{ role: "system", content: P.JUDGE_SYS + JUDGE_PART[k] }, { role: "user", content: user[k] }], JUDGE_TOKENS[k], JU, deadline, JUDGE_OK[k], k === "core" ? JUDGE_HEDGE_MS : 0)
    .catch((e) => { console.error(`채점(${k}) 실패:`, e); return {}; });
  const [core, jf, js, jt, pf] = await Promise.all([
    part("core"), part("fb"), part("sents"), part("turns"),
    prevPatient ? Promise.resolve(prevPatient) : cjsonRetry("judge", [
      { role: "system", content: fmt(P.PATIENT_FEEDBACK_SYS, { name: p.name, age: p.age, sex: p.sex, worry: (acting["걱정"] || []).join(" / "), expect: (acting["기대"] || []).join(" / ") }) },
      { role: "user", content: tr }], 6000, JU, deadline, (j) => !!j?.ppi && typeof j.ppi === "object" && Object.keys(j.ppi).length > 0).catch(() => ({})),
  ]);
  const j: any = { ...core };
  for (const k of ["soap_sentences", "turn_notes", "soap_top", "soap_more", "good", "unnecessary"]) delete j[k];
  if (JUDGE_OK.fb(jf)) for (const k of ["soap_top", "soap_more", "good", "unnecessary"]) if (Array.isArray(jf[k])) j[k] = jf[k];
  if (JUDGE_OK.sents(js)) j.soap_sentences = js.soap_sentences;
  if (JUDGE_OK.turns(jt)) j.turn_notes = jt.turn_notes;
  applyRubric(j);
  const sev: Record<string, number> = { "⛔": 0, "🔴": 1, "🟡": 2, "⚪": 3 };
  for (const k of ["soap_top", "soap_more"]) if (Array.isArray(j[k])) j[k].sort((a: any, b: any) => (sev[String(a.sev ?? "").trim()] ?? 9) - (sev[String(b.sev ?? "").trim()] ?? 9));
  // 채점 모델이 빈 답을 주면 0점이 아니라 '채점 실패'로 남긴다 (평균에 섞이지 않게 total=null, 화면에 다시 채점 단추)
  const judgeError = !JUDGE_OK.core(core) ? "채점 모델 응답이 비어 있습니다" : "";
  const scores = judgeError ? {} : scoreDomains(j, pf, U);
  const total = judgeError ? null : overtime ? 0 : Object.values(scores).reduce((a, b) => a + b, 0);
  // 대회 보정 점수: 대회 샘플 검증 점수와 짝지어 맞춘 영역별 선형 보정 (P.CAL = {영역: [기울기, 절편]})
  const scoresCal: Record<string, number> = {};
  if (!judgeError) for (const [d, mx] of P.DOMAINS as [string, number][]) {
    const [a, b] = (P.CAL || {})[d] || [1, 0];
    scoresCal[d] = Math.round(Math.max(0, Math.min(mx, a * (scores[d] ?? 0) + b)) * 10) / 10;
  }
  const totalCal = judgeError ? null : overtime ? 0 : Math.round(Object.values(scoresCal).reduce((a, b) => a + b, 0) * 10) / 10;
  const parts: Record<string, any> = { fb: jf, sents: js, turns: jt };
  const judgeMiss = Object.keys(parts).filter((k) => !JUDGE_OK[k](parts[k]));
  R.submits = [...subs, { type: "submit", total, scores, total_cal: totalCal, scores_cal: scoresCal, cal_version: P.CAL_VERSION, overtime, judge: j, patient: pf, soap, soap_fields: soapFields, soap_split: split, dx, turns: turns.length, rejected,
    minutes: Math.round(mins * 10) / 10, truth, usage: { ...U }, judge_usage: JU, judge_sec: Math.round((Date.now() - t0) / 100) / 10, time: kst(),
    ...(judgeError ? { judge_error: judgeError } : {}), ...(judgeMiss.length ? { judge_missing: judgeMiss } : {}) }];
  R.draft = null;
}

// ───────────── 화면에 주는 모양 (sp_web.py 와 같음) ─────────────
async function convView(R: any, withRef = true) {
  const subs = R.submits || [];
  for (const s of subs) normAccuracy(s.judge || {});
  const p = R.start?.patient || {};
  const v: any = {
    name: R.name, case: R.cid, mode: R.mode, meta: R.meta || {},
    patient: { name: p.name, age: p.age, sex: p.sex, cc: p.chief_complaint, opening: p.opening, vitals: R.start?.vitals },
    events: R.events || [], turn: turnsOf(R).length, rejected: rejectsOf(R), max_turns: maxTurns(R), max_min: MAX_MIN, maxlen: P.MAXLEN,
    elapsed_sec: elapsedSec(R), done: subs.length > 0, submit: subs.at(-1) ?? null,
    submits: subs.map((x: any) => ({ time: x.time, total: x.total, dx: x.dx })), draft: subs.length ? null : R.draft ?? null,
  };
  if (subs.length && withRef) {
    try { const C = await getCase(R.cid, true); v.reference = C.reference ?? null; v.model_record = C.model_record ?? null; } catch { v.reference = null; }
  }
  return v;
}
// 실험 라벨(가설 묶음) · 제목 · 메모(가설·바꾼 것·결과). 요청에 들어 있는 칸만 고친다 (title·memo 만 보내도 라벨은 그대로)
const META_MAX: Record<string, number> = { label: 60, title: 100, memo: 2000 };
function cleanMeta(b: any) {
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(META_MAX)) if (b && k in b) out[k] = String(b[k] ?? "").trim().slice(0, n);
  return out;
}
async function history() {
  const rows = await db.encList();
  return rows.map((r: any) => {
    const m = /^(\d{8})_(\d{6})_/.exec(r.name), meta = r.meta || {}, n = r.n_submits || 0;
    return {
      name: r.name, title: meta.title || "", memo: meta.memo || "", label: meta.label || "", official: meta.official || null,
      when: m ? `${m[1].slice(4, 6)}/${m[1].slice(6)} ${m[2].slice(0, 2)}:${m[2].slice(2, 4)}` : r.name,
      case: r.cid, who: r.who || "", mode: r.mode, turns: r.turns || 0, status: n ? "제출" : "진행 중",
      total: n ? r.total : null, dx: n ? r.dx : null, truth: n ? r.truth : null, rescored: Math.max(0, n - 1),
      cc: r.cc || "", live: !n, accuracy: n && r.accuracy != null ? Number(r.accuracy) : null, scores: n ? r.scores : null,
    };
  });
}

// ───────────── 증례 (만들기·고치기·지우기) ─────────────
const BLANK_SCRIPT = ["현병력", "동반증상", "없는증상", "과거력", "약", "알레르기", "가족력", "사회력", "여성력", "이전진료"];
async function nextCid() {
  const used = new Set(await db.caseCids());
  for (let n = 1; n < 703; n++) {
    let s = "", k = n;
    while (k) { const r = (k - 1) % 26; k = Math.floor((k - 1) / 26); s = String.fromCharCode(65 + r) + s; }
    if (!used.has(s)) return s;
  }
  throw bad("증례 키를 더 만들 수 없습니다");
}
function setName(r: any, cid: string) {
  const p = (r.patient = r.patient || {});
  const pool = P.POOL[p.sex] || P.POOL["여"];
  const nw = P.NAMES[cid] || pool[[...cid].reduce((a, c) => a + (c.codePointAt(0) || 0), 0) % pool.length];
  if (p.name && p.name !== nw) p.opening = String(p.opening || "").split(p.name).join(nw);
  p.name = nw;
}
function articleText(xml: string) {
  return xml.replace(/<ref-list>[\s\S]*?<\/ref-list>/g, " ").replace(/<\/(p|title|sec|caption|tr)>/g, "\n").replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
async function buildCase(cid: string, pmcid: string, truth: string, intro: string) {
  pmcid = pmcid.trim().toUpperCase();
  if (!/^PMC\d{5,9}$/.test(pmcid)) throw bad("PMC 번호 형식이 아닙니다 (예: PMC11512492)");
  const xml = await (await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`)).text();
  if (xml.length < 2000) throw bad(`${pmcid} 원문을 받지 못했습니다 (전문 공개 논문인지 확인)`);
  const U: Usage = { calls: 0, in: 0, out: 0 };
  const r = await cjson("build", [{ role: "system", content: P.BUILD_SYS }, { role: "user", content: `확진명(truth): ${truth}\n\n원문:\n${articleText(xml)}` }], 20000, U);
  if (!r.patient) throw bad("증례 패키지를 만들지 못했습니다 (모델 응답이 비어 있음)", 502);
  setName(r, cid);
  const F = caseFacts(r);  // 새 증례도 대회 형식 칸을 같이 둔다
  Object.assign(r, { start_information: F.start_information, patient_script: F.patient_script, exam_results: F.exam_results });
  const p = r.patient;
  Object.assign(r, { case_id: cid, pmcid, truth, status: "초안 (의학과 검수 전)",
    intro: intro || `${p.age}세 ${p.sex === "여" ? "여성" : "남성"}이 ${p.chief_complaint}(으)로 왔습니다.` });
  await db.caseUpsert(cid, r);
  forgetCases(cid);
  return r;
}
async function caseSave(cid: string, data: any) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("증례 형식이 잘못되었습니다");
  for (const k of Object.keys(data)) if (k.startsWith("_")) delete data[k];  // _unsaved·_derived 같은 화면용 칸
  const p = (data.patient = data.patient || {}), si = data.start_information;
  if (si && typeof si === "object") {  // 예전 칸도 같은 값으로 (예전 판 화면·스크립트 호환)
    if (txt(si.opening)) p.opening = txt(si.opening);
    if (si.vital_signs != null) data.vitals = txt(si.vital_signs);
  }
  if (data.exam_results != null && !Array.isArray(data.exam_results)) throw bad("진찰 결과표(exam_results)는 [{exam, result}] 목록이어야 합니다");
  if (data.patient_script != null && typeof data.patient_script !== "string") throw bad("환자 대본(patient_script)은 글 한 덩어리여야 합니다");
  if (data.patient_profile != null && (typeof data.patient_profile !== "object" || Array.isArray(data.patient_profile))) throw bad("환자 프로필(patient_profile)은 {항목: 내용} 객체여야 합니다");
  if (!caseTruth(data)) throw bad("정답(최종 진단)을 적어 주세요");
  if (!data.truth) data.truth = caseTruth(data);
  if (!caseFacts(data).start_information.opening || !p.chief_complaint) throw bad("환자 첫마디와 주호소를 적어 주세요");
  const old = await db.caseRow(cid);
  if (old && old.deleted_at) throw bad("지운 증례입니다");
  if (old) await db.caseHistory(cid, old.data);  // 이전 판 보관
  data.case_id = cid;
  await db.caseUpsert(cid, data);
  forgetCases(cid);
  return data;
}

// ───────────── 비밀번호 (토큰 = 만료시각.HMAC) ─────────────
const te = new TextEncoder();
let HKEY: CryptoKey | null = null;
async function hmacHex(msg: string) {
  HKEY ??= await crypto.subtle.importKey("raw", te.encode(PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", HKEY, te.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameStr(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function makeToken() {
  const exp = String(Math.floor(Date.now() / 1000) + AUTH_DAYS * 86400);
  return `${exp}.${await hmacHex("sp-web:" + exp)}`;
}
async function authed(req: Request) {
  if (!PASSWORD) return true;
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  const tok = h.slice(7).trim(), i = tok.indexOf(".");
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  if (i < 1 || !/^\d+$/.test(exp) || +exp < Date.now() / 1000) return false;
  return sameStr(sig, await hmacHex("sp-web:" + exp));
}
async function login(ip: string, given: string): Promise<string | null> {
  const now = Date.now();
  const f = await db.failGet(ip);
  const until = f?.until_ts ? new Date(f.until_ts).getTime() : 0;
  if (until > now) return `너무 많이 틀렸습니다. ${Math.floor((until - now) / 60000) + 1}분 뒤에 다시 해 주세요.`;
  if (sameStr(String(given ?? ""), PASSWORD)) {
    if (f) await db.failDel(ip);
    return null;
  }
  await sleep(1000);
  const n = (f?.n || 0) + 1;  // 같은 IP 에서 10번 틀리면 10분 잠금
  await db.failSet(ip, n >= 10 ? 0 : n, n >= 10 ? new Date(now + 600e3).toISOString() : null);
  return "비밀번호가 틀렸습니다.";
}

// ───────────── 경로 ─────────────
const reply = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname.replace(/^\/functions\/v1/, "");
  if (!path.startsWith("/api/")) path = "/api" + path;  // 함수 이름(api) 뒤의 경로
  const qp = Object.fromEntries(url.searchParams);
  if (req.method === "GET") {
    if (path === "/api/auth") return reply({ ok: await authed(req), required: !!PASSWORD, days: AUTH_DAYS });
    if (path === "/api/boot") {  // 첫 화면에 필요한 것 한 번에: 로그인 확인 + 환자 + 진료 목록
      if (!(await authed(req))) return reply({ ok: false, required: !!PASSWORD, days: AUTH_DAYS });
      const [rows, hist] = await Promise.all([liveCases(), history()]);
      return reply({ ok: true, required: !!PASSWORD, days: AUTH_DAYS, ...casesPayload(rows), history: hist });
    }
    if (!(await authed(req))) throw bad("비밀번호를 입력해 주세요.", 401);
    if (path === "/api/cases") return reply(casesPayload(await liveCases()));
    if (path === "/api/history") return reply({ rows: await history() });
    if (path === "/api/conv") return reply(await convView(await getEnc(safe(qp.name))));
    if (path === "/api/admin/cases") {
      const rows = await liveCases();
      return reply({ rows: rows.map((r: any, i: number) => {
        const c = r.data, p = c.patient || {}, d = new Date(new Date(r.updated_at).getTime() + 9 * 3600e3);
        return { no: i + 1, cid: r.cid, who: `${p.age ?? ""}세 ${p.sex ?? ""}`, cc: p.chief_complaint, truth: c.truth, pmcid: c.pmcid, status: c.status || "", level: c.difficulty || "",
          exam: caseFacts(c).exam_results.length, tests: (c.tests || []).length, checklist: (c.checklist || []).length, format: caseFacts(c).unified ? "대회 형식" : "예전 형식",
          updated: `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` };
      }) });
    }
    if (path === "/api/admin/case") {  // 예전 형식이면 대회 형식으로 읽은 결과를 _derived 로 같이 준다 (편집 화면에서 채워 저장)
      const C = await getCase(safe(qp.cid)), F = caseFacts(C);
      return reply(F.unified ? C : { ...C, _derived: { start_information: F.start_information, patient_script: F.patient_script, exam_results: F.exam_results } });
    }
    throw bad("없는 주소", 404);
  }
  if (req.method !== "POST") throw bad("없는 주소", 404);
  const b: any = await req.json().catch(() => ({}));
  if (path === "/api/login") {
    if (!PASSWORD) return reply({ ok: true });
    const ip = (req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
    const err = await login(ip, b.password);
    if (err) throw bad(err, 401);
    return reply({ ok: true, token: await makeToken(), days: AUTH_DAYS });
  }
  if (path === "/api/logout") return reply({ ok: true });
  if (!(await authed(req))) throw bad("비밀번호를 입력해 주세요.", 401);

  // 진료: 시작 · 한 턴 · 쓰다 만 SOAP · 제출 (모두 기록 이름 name 으로, 제출 전이면 언제든 이어서)
  if (path === "/api/start") {
    const ids = (await liveCases()).map((r: any) => r.cid);
    const cid = ids.includes(b.cid) ? b.cid : ids[(parseInt(b.no) || 1) - 1];
    if (!cid) throw bad("증례가 없습니다", 404);
    const C = await getCase(cid), F = caseFacts(C), mode = b.mode === "본선" ? "본선" : "예선";
    const p = { ...(C.patient || {}), opening: F.start_information.opening };  // 의사가 처음 받는 것: 시작 정보(첫마디·활력징후)뿐
    const start = { type: "start", case: cid, pmcid: C.pmcid, mode, models: MODELS, patient: p, vitals: F.start_information.vital_signs, max_turns: P.MAX_TURNS, max_min: MAX_MIN, time: kst() };
    let name = `${stamp()}_${cid}`;
    for (let i = 2; ; i++) {
      try {
        await db.encInsert({ name, cid, mode, start, events: [], submits: [], meta: cleanMeta(b), usage: { calls: 0, in: 0, out: 0 },
          turns: 0, n_submits: 0, cc: p.chief_complaint || "", who: p.age ? `${p.age}세 ${p.sex || ""}`.trim() : "" });
        break;
      } catch (e) {
        if (i > 5 || !/409|duplicate|23505/.test(`${(e as any)?.code ?? ""} ${e}`)) throw e;
        name = `${stamp()}_${cid}_${i}`;
      }
    }
    return reply(await convView(await getEnc(name)));
  }
  if (path === "/api/act") {
    const kind = String(b.act || "SAY").toUpperCase(), text = String(b.text ?? "");  // 대회처럼 공백도 글자 수에 넣는다
    const R = await getEnc(safe(b.name)), C = await getCase(R.cid, true);
    R.usage = R.usage || { calls: 0, in: 0, out: 0 };
    const r: any = kind === "EXAM" || kind === "TEST" ? await act(R, C, kind, text, R.usage) : await say(R, C, text, R.usage);
    await saveEnc(R);
    return reply({ ...r, act: kind === "EXAM" || kind === "TEST" ? kind : "SAY", turn: turnsOf(R).length, turns_remaining: Math.max(0, maxTurns(R) - turnsOf(R).length), rejected: rejectsOf(R), elapsed_sec: elapsedSec(R) });
  }
  if (path === "/api/draft") {
    const R = await getEnc(safe(b.name));
    if ((R.submits || []).length) throw bad("이미 제출한 진료입니다");
    const { soap, soapFields } = soapInput(b);
    await db.encPatch(R.name, { draft: { soap, soap_fields: soapFields, dx: String(b.diagnosis || b.dx || "").trim() } });
    return reply({ ok: true });
  }
  if (path === "/api/submit" || path === "/api/record/rescore") {
    const dx = String(b.diagnosis || b.dx || "").trim();
    if (!dx) throw bad("주진단을 적어 주세요.");
    const R = await getEnc(safe(b.name)), re = path === "/api/record/rescore";
    if (!re && (R.submits || []).length) throw bad("이미 제출한 진료입니다");
    if (re && !(R.submits || []).length) throw bad("아직 제출하지 않은 진료입니다");
    const C = await getCase(R.cid, true);
    R.usage = R.usage || { calls: 0, in: 0, out: 0 };
    if (re && b.usage && typeof b.usage === "object") R.usage = { calls: num(b.usage.calls), in: num(b.usage.in), out: num(b.usage.out) };  // 개발 키트 실행의 사용량
    const { soap, soapFields } = soapInput(b);
    await submit(R, C, soap, soapFields, dx, R.usage, re);
    await saveEnc(R);
    return reply(await convView(R));
  }
  // 진료 기록 고치기·지우기
  if (path === "/api/record/update") {
    const R = await getEnc(safe(b.name));
    R.meta = { ...(R.meta || {}), ...cleanMeta(b), updated: stamp() };
    await db.encPatch(R.name, { meta: R.meta });
    return reply({ ok: true, meta: R.meta });
  }
  // 대회 결과(샘플 검증·공식 평가)를 실험 라벨 단위로 기록: 같은 라벨의 모든 진료 meta.official 에 넣는다
  if (path === "/api/label/official") {
    const label = String(b.label || "").trim().slice(0, 60);
    if (!label) throw bad("라벨이 없습니다");
    const num = (v: any, mx: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= mx ? Math.round(n * 1000) / 1000 : null; };
    const scores: Record<string, number | null> = {};
    for (const [d, mx] of P.DOMAINS as [string, number][]) scores[d] = num(b.scores?.[d], mx);
    const official = b.clear ? null : { total: num(b.total, 100), scores, kind: String(b.kind || "샘플 검증").slice(0, 20),
                                        when: String(b.when || "").slice(0, 30), note: String(b.note || "").slice(0, 300), updated: stamp() };
    const rows = (await db.encList()).filter((r: any) => (r.meta || {}).label === label);
    if (!rows.length) throw bad("그 라벨의 진료가 없습니다", 404);
    for (const r of rows) await db.encPatch(r.name, { meta: { ...(r.meta || {}), official } });
    return reply({ ok: true, n: rows.length, official });
  }
  if (path === "/api/record/delete") {
    const R = await getEnc(safe(b.name));
    await db.encPatch(R.name, { deleted_at: new Date() });  // 휴지통 (되살릴 수 있음)
    return reply({ ok: true });
  }
  // 증례 만들기·고치기·지우기
  if (path === "/api/admin/case/create") {
    const truth = String(b.truth || "").trim();
    if (!truth) throw bad("정답(최종 진단)을 적어 주세요");
    const cid = await nextCid();
    if (String(b.pmcid || "").trim()) return reply(await buildCase(cid, String(b.pmcid), truth, String(b.intro || "").trim()));
    return reply({ patient: { name: "", age: "", sex: "여", opening: "", chief_complaint: "" }, vitals: "",
      script: Object.fromEntries(BLANK_SCRIPT.map((k) => [k, []])), acting: { "성격·말투": "", "걱정": [], "기대": [], "감정": "" }, exam: [], tests: [],
      reference: { S: [], O: [], A: { main: "", rationale: [], ddx: [] }, P: { tests: [], treatment: [], safety: [], followup: [] }, red_flags: [], communication: [] },
      checklist: [], truth, pmcid: "", intro: "", status: "작성 중", case_id: cid, _unsaved: true });
  }
  if (path === "/api/admin/case/save") return reply({ ok: true, case: await caseSave(safe(b.cid), b.data) });
  if (path === "/api/admin/case/delete") {
    const cid = safe(b.cid);
    const row = await db.caseRow(cid);
    if (!row || row.deleted_at) throw bad("증례가 없습니다", 404);
    await db.caseDelete(cid);
    forgetCases(cid);
    return reply({ ok: true });
  }
  // 로컬 판 자료 옮기기 (scripts/import_local.py)
  if (path === "/api/admin/import") {
    const cases = (b.cases || []).map((c: any) => ({ cid: safe(c.cid), data: c.data, updated_at: new Date().toISOString() }));
    // 실험 라벨·제목·메모(meta)도 같이 저장해 사이드바에서 라벨별로 묶인다 (ZIP 평가는 ZIP 이름이 라벨)
    const encs = (b.encounters || []).map((e: any) => ({ ...e, name: safe(e.name), meta: e.meta && typeof e.meta === "object" ? { ...e.meta, ...cleanMeta(e.meta) } : {} }));
    for (const c of cases) await db.caseUpsert(c.cid, c.data);
    if (encs.length) await db.encUpsert(encs);
    forgetCases();
    return reply({ ok: true, cases: cases.length, encounters: encs.length });
  }
  throw bad("없는 주소", 404);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    return await handle(req);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error(e);
    return reply({ error: String((e as Error)?.message || e).trim() || "오류" }, code);
  }
});
