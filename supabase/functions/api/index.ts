// CPX 가상 환자 API — Supabase Edge Function (Deno). 로컬 판 tools/sp_web.py · tools/sp_sim.py 를 옮긴 것.
// 경로·응답 모양은 로컬 판과 같아서 화면(web/index.html)은 두 판에서 그대로 쓴다.
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
const MAX_MIN = Number(env("SP_MAX_MIN") || 0);       // 0 = 시간 제한 없음 (대회는 20)
const AUTH_DAYS = Number(env("SP_AUTH_DAYS") || 1);   // 한 번 들어오면 유지되는 날 수
const MODELS: Record<string, string> = {
  router: env("SP_ROUTER_MODEL") || "gpt-6-luna", patient: env("SP_PATIENT_MODEL") || "gpt-6-luna",
  judge: env("SP_JUDGE_MODEL") || "gpt-6-luna", build: env("SP_BUILD_MODEL") || "gpt-6-luna",
};
const EFFORT: Record<string, string> = { router: "none", patient: "none", judge: "medium", build: env("SP_BUILD_EFFORT") || "high" };
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
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GREET = new RegExp(P.GREET);

// ───────────── DB: REST(PostgREST) 가 기본. SP_DB_DIRECT=1 이면 직접 연결(postgres.js) ─────────────
// 실측(10/07): 이 환경에서는 요청마다 직접 연결을 새로 맺어 호출당 약 1초 → REST(0.3~0.5초)가 더 빠름
const DB_URL = env("SP_DB_DIRECT") === "1" ? env("SUPABASE_DB_URL") : "";
const sql: any = DB_URL ? postgres(DB_URL, { max: 4, prepare: false, idle_timeout: 30, connect_timeout: 8, onnotice: () => {} }) : null;
let useSql = !!sql;
const JSONB = new Set(["start", "events", "draft", "submits", "meta", "usage", "scores", "data"]);
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
    turns: R.events.filter((e: any) => e.type === "turn").length, n_submits: subs.length,
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
async function chat(role: string, messages: any[], json = false, maxTokens = 2000, U?: Usage): Promise<string> {
  if (!OPENAI_KEY) throw bad("서버에 SP_OPENAI_API_KEY 가 없습니다", 500);
  const body: any = { model: MODELS[role] || MODELS.patient, messages, max_completion_tokens: maxTokens };
  if (EFFORT[role]) body.reasoning_effort = EFFORT[role];
  if (json) body.response_format = { type: "json_object" };
  for (let a = 0; a < 3; a++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) {
      if (U) { U.calls++; U.in += j.usage?.prompt_tokens || 0; U.out += j.usage?.completion_tokens || 0; }
      return String(j.choices?.[0]?.message?.content || "").trim();
    }
    const msg = JSON.stringify(j.error || j);
    if (/insufficient_quota|no credits/i.test(msg)) throw bad("OpenAI 계정에 크레딧이 없습니다", 502);
    if (msg.includes("reasoning_effort") && body.reasoning_effort) { delete body.reasoning_effort; continue; }
    if (msg.includes("response_format") && body.response_format) { delete body.response_format; continue; }
    if (a === 2) throw bad("OpenAI 오류: " + msg.slice(0, 200), 502);
    await sleep(1500 * (a + 1));
  }
  return "";
}
async function cjson(role: string, messages: any[], maxTokens = 2000, U?: Usage): Promise<any> {
  const t = await chat(role, messages, true, maxTokens, U);
  const m = t.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : t); } catch { return {}; }
}

// ───────────── 채점 도구 (sp_sim.py 와 같음) ─────────────
const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
function normAccuracy(j: any) {
  const lv = String(j?.dx_level ?? "").trim(), band = P.DX_BAND[lv];
  if (band && typeof j.accuracy === "number") j.accuracy = Math.min(Math.max(j.accuracy, band[0]), band[1]);
  return j;
}
function scoreDomains(j: any, pf: any): Record<string, number> {
  const sub = j.sub || {}, out: Record<string, number> = {};
  for (const [d, parts] of Object.entries(P.SUB_MAX as Record<string, Record<string, number>>)) {
    let t = 0;
    for (const [k, mx] of Object.entries(parts)) t += Math.max(P.SUB_MIN[k] ?? 0, Math.min(mx, num((sub[d] || {})[k])));
    out[d] = t;
  }
  const ck = j.checklist || [];
  const wAll = ck.reduce((a: number, c: any) => a + (num(c.w ?? 1) || 1), 0);
  const wGot = ck.reduce((a: number, c: any) => a + (c.asked && c.tag !== "지어낸 기록" ? num(c.w ?? 1) || 1 : 0), 0);
  if (ck.length && wAll && wGot / wAll < 0.6) out["효율"] = Math.min(out["효율"], 10);  // 적게 물어 효율을 버는 것 방지
  const ppi = Object.values(pf?.ppi || {}).map((v) => Math.max(0, Math.min(3, num(v))));
  out["의사소통"] = ppi.length ? (ppi.reduce((a, b) => a + b, 0) / ppi.length) * 5 : 0;
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

// ───────────── 진료 엔진 (sp_sim.py Encounter 와 같음) ─────────────
const turnsOf = (R: any) => (R.events || []).filter((e: any) => e.type === "turn");
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
  return [`[시작] 환자: ${C.patient?.opening} / 활력징후: ${C.vitals ?? "None"}`,
    ...turns.map((e: any) => `[${e.turn}턴 ${e.act}] 의사: ${e.text}\n        → ${e.out}`)].join("\n");
}
function checkMsg(R: any): string | null {
  if ((R.submits || []).length) return "진료가 이미 끝났습니다.";
  if (MAX_MIN && elapsedSec(R) / 60 > MAX_MIN) return `시간 초과(${MAX_MIN}분). /제출 로 마무리하세요 (시간 초과는 무효 처리됩니다).`;
  if (turnsOf(R).length >= maxTurns(R)) return `${maxTurns(R)}턴을 모두 썼습니다. /제출 로 마무리하세요.`;
  return null;
}
function reject(R: any, act: string, text: string, why: string) {
  R.events.push({ type: "reject", act, text, why, time: kst() });
  return { ok: false, out: `반려: ${why} (턴 차감 없음)` };
}
// 감정으로 맺는 버릇 줄이기: 최근 대답 셋 중 하나라도 감정으로 끝났으면 이번엔 감정 말을 빼라고 덧붙인다 (sp_sim.emo_hint 와 같음)
function lastSentence(s: string) {
  const parts = (s || "").trim().split(/(?<=[.?!…])\s+/).filter((x) => x.trim());
  return parts.length ? parts[parts.length - 1] : "";
}
function emoHint(prevOuts: string[], text: string) {
  if (new RegExp(P.EMO_ASK).test(text || "")) return "";
  return prevOuts.slice(-3).some((o) => new RegExp(P.EMO_END).test(lastSentence(o))) ? P.EMO_HINT : "";
}
async function patientReply(R: any, C: any, text: string, U: Usage) {
  const p = C.patient || {};
  const qa = (C.qa || []).filter((x: any) => x?.q && x?.a).map((x: any) => `- ${x.q}: ${x.a}`).join("\n") || "(없음)";  // 출처·근거는 검수용, 환자에게 안 줌
  const persona = bullets(C.persona || {}) || bullets(C.acting || {}) || "(없음)";  // 자세한 페르소나, 없으면 예전 '연기' 칸
  // 환자가 잘못 알거나 모르는 것: 환자에게는 생각만 준다 (실제·확인 방법은 채점용)
  const beliefs = (C.beliefs || []).filter((x: any) => x?.belief).map((x: any) => `- (${x.kind || "짐작"}) ${x.belief}`).join("\n") || "(없음)";
  const sys = fmt(P.PATIENT_SYS, { name: p.name, age: p.age, sex: p.sex, cc: p.chief_complaint, persona, script: bullets(C.script || {}), qa, beliefs });
  const msgs: any[] = [{ role: "system", content: sys }, { role: "user", content: "(진료 시작)" }, { role: "assistant", content: p.opening || "" }];
  const turns = turnsOf(R);
  for (const e of turns.slice(-20)) {
    if (e.act === "SAY") msgs.push({ role: "user", content: e.text }, { role: "assistant", content: e.out });
    else msgs.push({ role: "user", content: `(${e.act}: ${e.text})` }, { role: "assistant", content: "네." });
  }
  const hint = emoHint(turns.filter((e: any) => e.act === "SAY").map((e: any) => e.out), text);
  if (hint) msgs.push({ role: "system", content: hint });
  msgs.push({ role: "user", content: text });
  const out = await chat("patient", msgs, false, 2000, U);
  return out.replace(new RegExp(`^\\s*(환자|${escRe(String(p.name))})\\s*[:：]\\s*`), "").trim().replace(/^["“”]+|["“”]+$/g, "");
}
async function say(R: any, C: any, text: string, U: Usage) {
  const m = checkMsg(R);
  if (m) return { ok: false, out: m };
  const len = [...text].length;
  if (len > P.MAXLEN) return reject(R, "SAY", text, `${len}자입니다. ${P.MAXLEN}자 이하로 줄여 주세요`);
  const core = text.replace(GREET, "").trim() || text;  // 앞의 인사·맞장구는 세지 않는다
  if ((core.match(/[?？]/g) || []).length >= 2) return reject(R, "SAY", text, "한 번에 하나씩 물어봐 주세요");
  const turns = turnsOf(R);
  const hist = turns.slice(-4).filter((e: any) => e.act === "SAY").map((e: any) => `의사: ${e.text}\n환자: ${e.out}`).join("\n");
  const r = await cjson("router", [{ role: "system", content: P.SAY_ROUTER }, { role: "user", content: `최근 대화:\n${hist || "(없음)"}\n\n의사의 말: ${core}` }], 2000, U);
  let items = parseInt(String(r.items ?? 1)); if (isNaN(items)) items = 1;
  if (items >= 2) return reject(R, "SAY", text, `한 번에 하나씩 물어봐 주세요 — ${r.why ?? ""}`.replace(/[ —]+$/, ""));
  const out = await patientReply(R, C, text, U);
  R.events.push({ type: "turn", turn: turns.length + 1, act: "SAY", text, out, time: kst() });
  return { ok: true, out, tip: r.exam_like ? " (진찰 결과가 필요하면 /진찰 로 요청하세요)" : "" };
}
async function act(R: any, C: any, kind: string, text: string, U: Usage) {
  const m = checkMsg(R);
  if (m) return { ok: false, out: m };
  let pool: any[], what: string, empty: string;
  if (kind === "EXAM") {
    pool = [...(C.exam || [])];
    if (C.vitals) pool.push({ id: "V", name: "활력징후 측정 (혈압·맥박·호흡·체온·산소포화도)", finding: C.vitals });
    what = "진찰"; empty = "특이 소견 없음";
  } else {
    if (R.mode !== "본선") return { ok: false, out: "예선에서는 검사(TEST)를 할 수 없습니다. 필요한 검사는 SOAP의 P에 계획으로 쓰세요. (턴 차감 없음)" };
    pool = [...(C.tests || [])]; what = "검사"; empty = "결과 없음";
  }
  const items = pool.map((x) => `${x.id}: ${x.name}`).join("\n") || "(없음)";
  const r = await cjson("router", [{ role: "system", content: fmt(P.ACT_ROUTER, { what, items }) }, { role: "user", content: text }], 2000, U);
  let n = parseInt(String(r.items ?? 1)); if (isNaN(n)) n = 1;
  if (n >= 2) return reject(R, kind, text, `${what === "진찰" ? "진찰은" : "검사는"} 한 번에 하나만 요청해 주세요 — ${r.why ?? ""}`.replace(/[ —]+$/, ""));
  const hit = pool.find((x) => x.id === r.id);
  const out = hit ? `${hit.name}: ${hit.finding || hit.result}` : `${r.label || text}: ${empty}`;
  R.events.push({ type: "turn", turn: turnsOf(R).length + 1, act: kind, text, id: r.id ?? null, out, time: kst() });
  return { ok: true, out };
}
async function submit(R: any, C: any, soap: Record<string, string>, dx: string, U: Usage, rescore = false) {
  const subs = R.submits || [], turns = turnsOf(R), rejected = rejectsOf(R);
  const mins = rescore && subs.length ? num(subs[0].minutes) : elapsedSec(R) / 60;
  const overtime = !!MAX_MIN && mins > MAX_MIN;
  const split: Record<string, string[]> = {};
  for (const k of "SOAP") split[k] = splitSentences(soap[k] || "");
  const numbered = [..."SOAP"].flatMap((k) => split[k].map((x, i) => `[${k}${i + 1}] ${x}`)).join("\n") || "(비어 있음)";
  const user = `[정답(최종 확진)] ${C.truth}\n[모범 답안: 검사 전(SAY+EXAM) 기준 초진 기록]\n${JSON.stringify(C.reference || {}, null, 1)}\n` +
    `[체크리스트]\n${JSON.stringify(C.checklist || [])}\n[이 증례에서 진찰로 얻을 수 있던 소견]\n${JSON.stringify(C.exam || [])}\n` +
    `[환자가 잘못 알거나 모르는 것]\n${JSON.stringify(C.beliefs || [])}\n` +
    `[진료 방식] 모드 ${R.mode} · 사용 ${turns.length}/${maxTurns(R)}턴 · 반려 ${rejected}회\n` +
    `[진료 기록]\n${transcript(C, turns)}\n\n[제출한 초진 기록 — 문장 조각별 번호]\n${numbered}\n주진단: ${dx}`;
  const p = C.patient || {}, acting = { ...(C.acting || {}), ...(C.persona || {}) };
  const prevPatient = rescore && subs.length ? subs.at(-1).patient : null;  // 대화는 그대로이므로 환자 설문은 처음 것을 쓴다
  const [j, pf] = await Promise.all([
    cjson("judge", [{ role: "system", content: P.JUDGE_SYS }, { role: "user", content: user }], 12000, U),
    prevPatient ? Promise.resolve(prevPatient) : cjson("judge", [
      { role: "system", content: fmt(P.PATIENT_FEEDBACK_SYS, { name: p.name, age: p.age, sex: p.sex, worry: (acting["걱정"] || []).join(" / "), expect: (acting["기대"] || []).join(" / ") }) },
      { role: "user", content: transcript(C, turns) }], 6000, U),
  ]);
  normAccuracy(j);
  const sev: Record<string, number> = { "⛔": 0, "🔴": 1, "🟡": 2, "⚪": 3 };
  for (const k of ["soap_top", "soap_more"]) if (Array.isArray(j[k])) j[k].sort((a: any, b: any) => (sev[String(a.sev ?? "").trim()] ?? 9) - (sev[String(b.sev ?? "").trim()] ?? 9));
  const scores = scoreDomains(j, pf);
  const total = overtime ? 0 : Object.values(scores).reduce((a, b) => a + b, 0);
  R.submits = [...subs, { type: "submit", total, scores, overtime, judge: j, patient: pf, soap, soap_split: split, dx, turns: turns.length, rejected,
    minutes: Math.round(mins * 10) / 10, truth: C.truth, usage: { ...U }, time: kst() }];
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
  if (subs.length && withRef) { try { v.reference = (await getCase(R.cid, true)).reference ?? null; } catch { v.reference = null; } }
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
      name: r.name, title: meta.title || "", memo: meta.memo || "", label: meta.label || "",
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
  const p = r.patient;
  Object.assign(r, { case_id: cid, pmcid, truth, status: "초안 (의학과 검수 전)",
    intro: intro || `${p.age}세 ${p.sex === "여" ? "여성" : "남성"}이 ${p.chief_complaint}(으)로 왔습니다.` });
  await db.caseUpsert(cid, r);
  forgetCases(cid);
  return r;
}
async function caseSave(cid: string, data: any) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("증례 형식이 잘못되었습니다");
  const p = data.patient || {};
  if (!data.truth) throw bad("정답(최종 진단)을 적어 주세요");
  if (!p.opening || !p.chief_complaint) throw bad("환자 첫마디와 주호소를 적어 주세요");
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
          exam: (c.exam || []).length, tests: (c.tests || []).length, checklist: (c.checklist || []).length,
          updated: `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` };
      }) });
    }
    if (path === "/api/admin/case") return reply(await getCase(safe(qp.cid)));
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
    const C = await getCase(cid), p = C.patient || {}, mode = b.mode === "본선" ? "본선" : "예선";
    const start = { type: "start", case: cid, pmcid: C.pmcid, mode, models: MODELS, patient: p, vitals: C.vitals, max_turns: P.MAX_TURNS, max_min: MAX_MIN, time: kst() };
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
    const kind = String(b.act || "SAY").toUpperCase(), text = String(b.text || "").trim();
    if (!text) return reply({ ok: false, out: "내용을 입력해 주세요." });
    const R = await getEnc(safe(b.name)), C = await getCase(R.cid, true);
    R.usage = R.usage || { calls: 0, in: 0, out: 0 };
    const r: any = kind === "EXAM" || kind === "TEST" ? await act(R, C, kind, text, R.usage) : await say(R, C, text, R.usage);
    await saveEnc(R);
    return reply({ ...r, act: kind === "EXAM" || kind === "TEST" ? kind : "SAY", turn: turnsOf(R).length, rejected: rejectsOf(R), elapsed_sec: elapsedSec(R) });
  }
  if (path === "/api/draft") {
    const R = await getEnc(safe(b.name));
    if ((R.submits || []).length) throw bad("이미 제출한 진료입니다");
    const soap = Object.fromEntries([..."SOAP"].map((k) => [k, String((b.soap || {})[k] ?? "")]));
    await db.encPatch(R.name, { draft: { soap, dx: String(b.dx || "").trim() } });
    return reply({ ok: true });
  }
  if (path === "/api/submit" || path === "/api/record/rescore") {
    const dx = String(b.dx || "").trim();
    if (!dx) throw bad("주진단을 적어 주세요.");
    const R = await getEnc(safe(b.name)), re = path === "/api/record/rescore";
    if (!re && (R.submits || []).length) throw bad("이미 제출한 진료입니다");
    if (re && !(R.submits || []).length) throw bad("아직 제출하지 않은 진료입니다");
    const C = await getCase(R.cid, true);
    R.usage = R.usage || { calls: 0, in: 0, out: 0 };
    const soap = Object.fromEntries([..."SOAP"].map((k) => [k, String((b.soap || {})[k] ?? "")]));
    await submit(R, C, soap, dx, R.usage, re);
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
    const encs = (b.encounters || []).map((e: any) => ({ ...e, name: safe(e.name) }));
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
