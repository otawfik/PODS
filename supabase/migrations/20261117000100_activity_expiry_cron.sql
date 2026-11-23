-- =============================================================================
-- Automatic activity expiry (pg_cron)
--
-- Until now an activity flipped to 'expired' (and its chat was cleared) only
-- when someone opened it after expires_at (expire_activity_if_needed). This
-- adds a job that does the same for every due activity once a minute, so
-- inboxes, badges and university feeds stop showing stale activities.
--
-- Behaviour matches the lazy path: chat messages are deleted at expiry.
-- (The roadmap's "keep chat 24 h after expiry" is a later change.)
-- expire_activity_if_needed stays as a belt-and-braces check on open.
-- =============================================================================

create function public.expire_due_activities()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.activities
       set status = 'expired'
     where status = 'active' and expires_at < now()
    returning id
  ), purged as (
    delete from public.messages m
     using expired e
     where m.activity_id = e.id
  )
  select count(*) into v_count from expired;
  return v_count;
end;
$$;

revoke execute on function public.expire_due_activities() from public, anon, authenticated;

-- Schedule it. pg_cron ships with Supabase; the guard lets this migration
-- also run on plain Postgres (local tests), where the job is simply skipped.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Named jobs are upserted, so re-running this is safe.
    perform cron.schedule(
      'pods-expire-activities',
      '* * * * *',
      'select public.expire_due_activities()'
    );
  else
    raise notice 'pg_cron not available: skipping schedule for expire_due_activities()';
  end if;
end;
$$;
