-- Additive; preserves existing providers, encrypted credentials and quotas.
alter table freellmapi.providers
  add column health_status text not null default 'unchecked' check (health_status in ('unchecked','catalog_checked')),
  add column checked_at timestamptz,
  add column check_message text;
