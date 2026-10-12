-- CPX 가상 환자 DB. 배포 워크플로가 매번 실행한다 (여러 번 실행해도 안전).
-- 모든 표에 RLS 를 켜고 정책은 두지 않는다 → 공개 키(anon)로는 못 읽고, Edge Function 의 서비스 키로만 읽고 쓴다.

create table if not exists public.cases (
  cid        text primary key,              -- 증례 키 (A, B, …)
  data       jsonb not null,                -- 증례 패키지 (대본·진찰·검사·모범 답안·체크리스트·정답)
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                    -- 휴지통
);

create table if not exists public.case_history (  -- 증례를 저장할 때마다 이전 판
  id       bigserial primary key,
  cid      text not null,
  data     jsonb not null,
  saved_at timestamptz not null default now()
);

create table if not exists public.encounters (  -- 진료 한 번
  name       text primary key,              -- 20261007_134922_B (시각_증례)
  cid        text not null,
  mode       text not null default '예선',
  start      jsonb not null,                -- 시작 때 환자·활력징후·규칙
  events     jsonb not null default '[]'::jsonb,   -- 턴·반려
  draft      jsonb,                         -- 쓰다 만 SOAP
  submits    jsonb not null default '[]'::jsonb,   -- 제출·재채점 결과
  meta       jsonb not null default '{}'::jsonb,   -- 제목·메모
  usage      jsonb not null default '{"calls":0,"in":0,"out":0}'::jsonb,
  turns      int not null default 0,        -- 아래는 목록용 요약
  n_submits  int not null default 0,
  cc         text,
  who        text,
  total      int,
  dx         text,
  truth      text,
  accuracy   numeric,
  scores     jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists encounters_cid_idx on public.encounters (cid);

create table if not exists public.login_fails (
  ip       text primary key,
  n        int not null default 0,
  until_ts timestamptz
);

alter table public.cases        enable row level security;
alter table public.case_history enable row level security;
alter table public.encounters   enable row level security;
alter table public.login_fails  enable row level security;
