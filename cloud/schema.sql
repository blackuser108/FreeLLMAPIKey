-- Private, dedicated schema. No provider keys or API keys enter the Data API.
-- Apply once via Supabase migrations. Application login is provisioned separately.
create schema freellmapi;
revoke all on schema freellmapi from public, anon, authenticated;

create table freellmapi.access_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(label) between 1 and 80),
  digest text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table freellmapi.providers (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('groq','cerebras','google','nvidia','mistral','openrouter','huggingface','cohere','cloudflare','zhipu','llmtr')),
  label text not null check (length(label) between 1 and 80),
  secret jsonb not null,
  models text[] not null check (cardinality(models) between 1 and 100),
  enabled boolean not null default true,
  free_confirmed boolean not null default false,
  priority integer not null default 100 check (priority between 1 and 1000),
  rpm integer not null default 10 check (rpm between 1 and 10000),
  rpd integer not null default 100 check (rpd between 1 and 1000000),
  tpm integer not null default 10000 check (tpm between 1 and 10000000),
  tpd integer not null default 100000 check (tpd between 1 and 100000000),
  concurrency integer not null default 1 check (concurrency between 1 and 10),
  cooldown_until timestamptz not null default '-infinity',
  last_used_at timestamptz not null default '-infinity',
  last_status integer,
  created_at timestamptz not null default now()
);
create table freellmapi.attempts (
  id uuid primary key,
  provider_id uuid not null references freellmapi.providers(id) on delete cascade,
  model text not null,
  reserved_tokens integer not null check (reserved_tokens > 0),
  used_tokens integer,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  status integer
);
create index attempts_provider_time on freellmapi.attempts(provider_id, created_at desc);
create index attempts_expiry on freellmapi.attempts(expires_at) where finished_at is null;
create table freellmapi.rate_buckets (
  id text primary key,
  window_start timestamptz not null,
  count integer not null
);
create table freellmapi.maintenance (
  id boolean primary key default true check (id),
  last_run timestamptz not null default '-infinity'
);
insert into freellmapi.maintenance(id) values(true);

-- Defense in depth, including if this schema is accidentally exposed later.
alter table freellmapi.access_keys enable row level security;
alter table freellmapi.providers enable row level security;
alter table freellmapi.attempts enable row level security;
alter table freellmapi.rate_buckets enable row level security;
alter table freellmapi.maintenance enable row level security;
revoke all on all tables in schema freellmapi from public, anon, authenticated;

-- One restricted application role, no public API grants and no SECURITY DEFINER.
-- Provisioning supplies the password outside Git and grants only this schema.
