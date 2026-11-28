-- =============================================================================
-- Push notifications (Expo Push API)
--
-- 1. push_tokens: one row per device. Users register/unregister their own
--    tokens through RPCs and can read only their own rows.
-- 2. notification_outbox: one row per event, written by triggers on
--    public.activities. The triggers diff OLD/NEW arrays, so every path that
--    changes a request (request_join_activity, approve_join_request,
--    reject_join_request, create_activity, auto-approve) is covered without
--    touching those RPCs. Events:
--      join_request        someone asked to join        → the host
--      participant_joined  someone joined (auto-approve) → the host
--      request_approved    the host let you in           → the requester
--      request_declined    the host declined you         → the requester
--      new_activity        a member posted an activity   → the other pod members
--    The person who caused an event never gets a push about it.
-- 3. Delivery: after each outbox insert (and once a minute from pg_cron as a
--    retry sweep) pg_net POSTs an empty "kick" to the send-push Edge Function,
--    which claims pending rows (claim_push_notifications), sends them to Expo
--    and marks them sent. pg_net only sends after the transaction commits.
--
-- A notification problem never rolls back the user's action: the enqueue
-- trigger and the kick both swallow their own errors (as warnings).
--
-- One-time setup on a Supabase project (see README "Push notifications"):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random secret>', 'push_webhook_secret');
--   supabase secrets set PUSH_WEBHOOK_SECRET=<same random secret>
--   supabase functions deploy send-push --no-verify-jwt
-- Until both vault secrets exist the kick is a no-op and events wait in the
-- outbox.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Device tokens
-- ---------------------------------------------------------------------------

create table public.push_tokens (
  token       text primary key
    check (length(token) <= 255 and token ~ '^Expo(nent)?PushToken\[.+\]$'),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  platform    text not null check (platform in ('ios', 'android')),
  updated_at  timestamptz not null default now()
);

create index push_tokens_profile_idx on public.push_tokens (profile_id);

alter table public.push_tokens enable row level security;

create policy "push_tokens: read own"
  on public.push_tokens for select to authenticated
  using (profile_id = (select auth.uid()));

-- Writes go through the RPCs below.
revoke all on public.push_tokens from anon, authenticated;
grant select on public.push_tokens to authenticated;
grant select, delete on public.push_tokens to service_role;

-- Save this device's token for the caller. A token that belonged to another
-- account (someone else signed in on this phone before) moves to the caller.
-- Keeps each user's 10 most recently used devices.
create function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[.+\]$' or length(p_token) > 255 then
    raise exception 'Invalid push token';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'Invalid platform';
  end if;

  insert into public.push_tokens (token, profile_id, platform, updated_at)
  values (p_token, v_uid, p_platform, now())
  on conflict (token) do update
    set profile_id = excluded.profile_id,
        platform = excluded.platform,
        updated_at = now();

  delete from public.push_tokens
   where profile_id = v_uid
     and token not in (
       select token from public.push_tokens
        where profile_id = v_uid
        order by updated_at desc
        limit 10
     );
end;
$$;

-- Forget this device (on sign-out). Only the caller's own token is removed.
create function public.unregister_push_token(p_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  delete from public.push_tokens where token = p_token and profile_id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------

create table public.notification_outbox (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in (
                   'join_request', 'participant_joined', 'request_approved',
                   'request_declined', 'new_activity')),
  activity_id    uuid references public.activities (id) on delete cascade,
  pod_id         uuid references public.pods (id) on delete cascade,
  actor_id       uuid references public.profiles (id) on delete set null,
  recipient_ids  uuid[] not null check (cardinality(recipient_ids) > 0),
  -- Text for the message, captured when the event happened:
  -- { activityTitle, podName, actorName }
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  attempts       integer not null default 0,
  sent_at        timestamptz,
  last_error     text
);

create index notification_outbox_pending_idx
  on public.notification_outbox (created_at) where sent_at is null;

-- No policies: clients never see the outbox. The Edge Function uses the
-- service role.
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon, authenticated;
grant select, update, delete on public.notification_outbox to service_role;

-- Internal: add one event, minus the actor and duplicates.
create function public._enqueue_notification(
  p_type text,
  p_activity_id uuid,
  p_pod_id uuid,
  p_actor_id uuid,
  p_recipients uuid[],
  p_payload jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_recipients uuid[];
begin
  select coalesce(array_agg(distinct r), '{}')
    into v_recipients
    from unnest(p_recipients) as r
   where r is not null and r is distinct from p_actor_id;
  if cardinality(v_recipients) = 0 then
    return;
  end if;
  insert into public.notification_outbox
    (type, activity_id, pod_id, actor_id, recipient_ids, payload)
  values
    (p_type, p_activity_id, p_pod_id, p_actor_id, v_recipients, p_payload);
end;
$$;

-- Trigger: turn activity changes into outbox rows.
create function public.enqueue_activity_notifications()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  -- Who made the change (null for jobs run outside a user session).
  v_actor uuid := auth.uid();
  v_uid uuid;
  v_pod_name text;
  v_members uuid[];
  v_name text;
begin
  begin
    if tg_op = 'INSERT' then
      select name, members into v_pod_name, v_members
        from public.pods where id = new.pod_id;
      perform public._enqueue_notification(
        'new_activity', new.id, new.pod_id, new.host_id,
        array_remove(v_members, new.host_id),
        jsonb_build_object('activityTitle', new.title, 'podName', v_pod_name,
                           'actorName', new.host_name)
      );
      return null;
    end if;

    -- UPDATE of pending_requests / participants. Nothing for ended activities.
    if new.status <> 'active' or old.status <> 'active' then
      return null;
    end if;

    -- New requests → host.
    for v_uid in
      select unnest(new.pending_requests) except select unnest(old.pending_requests)
    loop
      select display_name into v_name from public.profiles where id = v_uid;
      perform public._enqueue_notification(
        'join_request', new.id, new.pod_id, v_uid, array[new.host_id],
        jsonb_build_object('activityTitle', new.title, 'actorName', v_name)
      );
    end loop;

    -- New participants: let in by someone else → requester; joined on their
    -- own (auto-approve) → host.
    for v_uid in
      select unnest(new.participants) except select unnest(old.participants)
    loop
      if v_actor is distinct from v_uid then
        perform public._enqueue_notification(
          'request_approved', new.id, new.pod_id, v_actor, array[v_uid],
          jsonb_build_object('activityTitle', new.title, 'actorName', new.host_name)
        );
      else
        select display_name into v_name from public.profiles where id = v_uid;
        perform public._enqueue_notification(
          'participant_joined', new.id, new.pod_id, v_uid, array[new.host_id],
          jsonb_build_object('activityTitle', new.title, 'actorName', v_name)
        );
      end if;
    end loop;

    -- Requests removed without joining → requester. (A requester who
    -- withdraws their own request is the actor, so _enqueue drops them.)
    for v_uid in
      (select unnest(old.pending_requests) except select unnest(new.pending_requests))
      except select unnest(new.participants)
    loop
      perform public._enqueue_notification(
        'request_declined', new.id, new.pod_id, v_actor, array[v_uid],
        jsonb_build_object('activityTitle', new.title, 'actorName', new.host_name)
      );
    end loop;
  exception when others then
    -- Never let a notification problem undo the join/approve/create.
    raise warning 'enqueue_activity_notifications failed: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger activities_notify_insert
  after insert on public.activities
  for each row execute function public.enqueue_activity_notifications();

create trigger activities_notify_update
  after update of pending_requests, participants on public.activities
  for each row execute function public.enqueue_activity_notifications();

-- ---------------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------------

-- POST an empty body to the send-push Edge Function if anything is waiting.
-- Needs pg_net and the vault secrets project_url + push_webhook_secret;
-- without them (e.g. in local tests) it does nothing.
create function public.kick_push_delivery()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return;
  end if;
  if not exists (
    select 1 from public.notification_outbox where sent_at is null and attempts < 5
  ) then
    return;
  end if;
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_webhook_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/send-push',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_secret
    ),
    timeout_milliseconds := 10000
  );
exception when others then
  raise warning 'kick_push_delivery failed: %', sqlerrm;
end;
$$;

create function public.kick_push_delivery_trigger()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.kick_push_delivery();
  return null;
end;
$$;

create trigger notification_outbox_kick
  after insert on public.notification_outbox
  for each statement execute function public.kick_push_delivery_trigger();

-- Called by the Edge Function (service role): lease up to p_limit pending
-- notifications for 2 minutes and return them with their recipients' tokens.
-- Rows that fail are retried when the lease runs out, at most 5 attempts.
create function public.claim_push_notifications(p_limit integer default 100)
returns table (
  id uuid,
  type text,
  activity_id uuid,
  pod_id uuid,
  payload jsonb,
  tokens text[]
)
language sql security definer set search_path = ''
as $$
  with picked as (
    select o.id
      from public.notification_outbox o
     where o.sent_at is null
       and o.attempts < 5
       and (o.claimed_at is null or o.claimed_at < now() - interval '2 minutes')
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update skip locked
  ), claimed as (
    update public.notification_outbox o
       set claimed_at = now(), attempts = o.attempts + 1
      from picked
     where o.id = picked.id
    returning o.*
  )
  select c.id, c.type, c.activity_id, c.pod_id, c.payload,
         coalesce(
           (select array_agg(t.token order by t.token)
              from public.push_tokens t
             where t.profile_id = any (c.recipient_ids)),
           '{}'
         )
    from claimed c
   order by c.created_at;
$$;

-- ---------------------------------------------------------------------------
-- Function permissions. Supabase grants EXECUTE on new public functions to
-- anon/authenticated by default, so revoke explicitly.
-- ---------------------------------------------------------------------------

revoke execute on function public.register_push_token(text, text) from public, anon;
revoke execute on function public.unregister_push_token(text) from public, anon;
grant  execute on function public.register_push_token(text, text) to authenticated;
grant  execute on function public.unregister_push_token(text) to authenticated;

revoke execute on function public._enqueue_notification(text, uuid, uuid, uuid, uuid[], jsonb)
  from public, anon, authenticated;
revoke execute on function public.enqueue_activity_notifications() from public, anon, authenticated;
revoke execute on function public.kick_push_delivery() from public, anon, authenticated;
revoke execute on function public.kick_push_delivery_trigger() from public, anon, authenticated;
revoke execute on function public.claim_push_notifications(integer) from public, anon, authenticated;
grant  execute on function public.claim_push_notifications(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Extensions and schedule. Guarded like 20261117000100 so this migration
-- also runs on plain Postgres (local tests).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  else
    raise notice 'pg_net not available: push delivery kicks are skipped';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Retry sweep, plus pruning delivered/abandoned rows after a week.
    perform cron.schedule(
      'pods-push-delivery',
      '* * * * *',
      $job$
        select public.kick_push_delivery();
        delete from public.notification_outbox where created_at < now() - interval '7 days';
      $job$
    );
  else
    raise notice 'pg_cron not available: skipping schedule for kick_push_delivery()';
  end if;
end;
$$;
