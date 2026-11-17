-- Tracking: what assistants and people asked for and what happened, in plain tables for analysis.

create table aircraft (
  id          text primary key,
  account     text not null,
  identity    text not null,              -- board UID where known, otherwise stack:board:name
  stack       text not null,
  firmware    text,
  version     text,
  board       text,
  craft_name  text,
  demo        boolean not null default false,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique (account, identity)
);

create table aircraft_connections (
  id          bigserial primary key,
  account     text not null,
  aircraft_id text references aircraft(id) on delete cascade,
  event       text not null check (event in ('connected', 'disconnected', 'reconnecting')),
  port        text,
  at          timestamptz not null default now()
);
create index aircraft_connections_by_aircraft on aircraft_connections (aircraft_id, at desc);

-- Every call an assistant made: what it sent, what it got back, and how long it took.
create table tool_calls (
  id           bigserial primary key,
  account      text not null,
  assistant    text not null,
  client_id    text,
  tool         text not null,
  input        jsonb not null,
  ok           boolean not null,
  error_code   text,
  output       jsonb,                      -- truncated to 8 KB; output_bytes has the full size
  output_bytes integer,
  duration_ms  integer not null,
  aircraft_id  text references aircraft(id) on delete set null,
  at           timestamptz not null default now()
);
create index tool_calls_by_account on tool_calls (account, at desc);
create index tool_calls_by_tool on tool_calls (tool, at desc);

-- Each state a proposal passes through: proposed, approved, done, failed, rejected, expired, cancelled.
create table proposal_events (
  id          bigserial primary key,
  proposal_id text not null,
  account     text not null,
  assistant   text,
  kind        text not null,
  status      text not null,
  level       smallint,
  needs       text[],
  reason      text,
  changes     jsonb,
  test        jsonb,
  result      jsonb,
  grant_id    text,
  aircraft_id text references aircraft(id) on delete set null,
  at          timestamptz not null default now()
);
create index proposal_events_by_proposal on proposal_events (proposal_id, at);
create index proposal_events_by_account on proposal_events (account, at desc);

-- Every write to an aircraft setting, by a person or through an approved proposal, with the readback.
create table setting_changes (
  id          bigserial primary key,
  account     text not null,
  aircraft_id text references aircraft(id) on delete set null,
  setting_id  text not null,
  before      jsonb,
  requested   jsonb,
  after       jsonb,
  ok          boolean not null,
  note        text,
  by_who      text not null,
  proposal_id text,
  at          timestamptz not null default now()
);
create index setting_changes_by_aircraft on setting_changes (aircraft_id, at desc);
create index setting_changes_by_setting on setting_changes (setting_id, at desc);

create table test_runs (
  id          bigserial primary key,
  account     text not null,
  aircraft_id text references aircraft(id) on delete set null,
  test_id     text not null,
  args        jsonb,
  ok          boolean,
  summary     text,
  by_who      text not null,
  proposal_id text,
  at          timestamptz not null default now()
);
create index test_runs_by_aircraft on test_runs (aircraft_id, at desc);

-- A sample of live readings every few seconds while an aircraft is connected.
create table telemetry_samples (
  id          bigserial primary key,
  account     text not null,
  aircraft_id text not null references aircraft(id) on delete cascade,
  armed       boolean,
  mode        text,
  voltage     real,
  current     real,
  remaining   smallint,
  cells       smallint,
  rssi        smallint,
  gps_fix     smallint,
  sats        smallint,
  roll        real,
  pitch       real,
  cpu_load    real,
  at          timestamptz not null default now()
);
create index telemetry_samples_by_aircraft on telemetry_samples (aircraft_id, at desc);

-- Ready-made views for analysis.
create view tool_usage_daily as
  select account, date_trunc('day', at) as day, tool, count(*) as calls,
         count(*) filter (where not ok) as errors, round(avg(duration_ms))::int as avg_ms,
         percentile_disc(0.95) within group (order by duration_ms) as p95_ms
  from tool_calls group by 1, 2, 3;

create view proposal_outcomes as
  select distinct on (proposal_id) proposal_id, account, assistant, kind, status as final_status, changes, test,
         (select min(at) from proposal_events e2 where e2.proposal_id = e.proposal_id) as proposed_at, at as decided_at
  from proposal_events e order by proposal_id, at desc, id desc;
