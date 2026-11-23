-- =============================================================================
-- Per-student cache for the recommend-pods Edge Function
--
-- One row per student: the last model ranking, the hash of the signals it
-- was computed from (interests, major, bio, pods, model), and when. The
-- function reuses it for 24 h while the hash matches, and calls the model at
-- most once per student per 30 s. This keeps LLM cost per student bounded.
--
-- Only the Edge Function (service role) reads or writes it; app users have
-- no access, so they can't plant their own "recommendations".
-- =============================================================================

create table public.pod_recommendations (
  profile_id      uuid primary key references public.profiles (id) on delete cascade,
  signals_key     text not null,
  model           text not null,
  recommendations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(recommendations) = 'array'),
  created_at      timestamptz not null default now()
);

alter table public.pod_recommendations enable row level security;
-- No policies: RLS denies every app user. The service role bypasses RLS.

revoke all on public.pod_recommendations from anon, authenticated;
grant select, insert, update, delete on public.pod_recommendations to service_role;
