-- =============================================================================
-- Reports and blocks (trust & safety; required by App Store guideline 1.2 and
-- Google Play's UGC policy)
--
-- 1. blocks: A blocks B. Enforced in the database, in both directions:
--      - neither sees the other's chat messages (messages SELECT policy, which
--        Supabase Realtime also applies to live messages);
--      - neither sees the other's university-wide activities, unless they are
--        already an approved participant (so they can still open and leave it);
--      - neither can request to join the other's activities, and pending
--        requests between the two are withdrawn when the block is created;
--      - neither gets a push notification about the other.
--    Pods, member lists and profiles stay readable: a block must not break a
--    shared pod. Approved participants are NOT removed from each other's
--    activities (roadmap decision 13: hosts cannot remove participants).
-- 2. reports: any user, pod, activity or message, with a reason from a fixed
--    list. The reported content is copied into the row when the report is
--    made, because activity chats are deleted at expiry. Clients can never
--    read reports. There is no admin UI yet: review them in the Supabase
--    dashboard (Table editor → reports, filter status = open) and set
--    `status` by hand.
--
-- Functions replaced here (same signatures, behaviour otherwise unchanged):
--   public.can_view_activity(uuid)           block check on the university branch
--   public.request_join_activity(uuid)       refuses a blocked pair
--   public._enqueue_notification(...)        drops recipients blocked with the actor
-- Policies replaced: "messages: read if in the room",
--   "activities: read if pod member or same university".
-- A later migration that replaces any of these must keep the block checks.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Blocks
-- ---------------------------------------------------------------------------

create table public.blocks (
  blocker_id  uuid not null references public.profiles (id) on delete cascade,
  blocked_id  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);

-- The primary key serves "who did I block"; this serves "who blocked me".
create index blocks_blocked_idx on public.blocks (blocked_id);

alter table public.blocks enable row level security;

-- You can see who you blocked, never who blocked you.
create policy "blocks: read own"
  on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

-- Writes go through block_user / unblock_user.
revoke all on public.blocks from anon, authenticated;
grant select on public.blocks to authenticated;

-- Is there a block between the current user and p_other, in either direction?
-- Used by the policies below, so `authenticated` must be able to execute it.
-- It only ever answers about pairs that include the caller.
create function public.is_blocked_with(p_other uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.blocks b
     where (b.blocker_id = (select auth.uid()) and b.blocked_id = p_other)
        or (b.blocker_id = p_other and b.blocked_id = (select auth.uid()))
  );
$$;

create function public.block_user(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if p_user_id is null then
    raise exception 'User not found';
  end if;
  if p_user_id = v_uid then
    raise exception 'You cannot block yourself';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'User not found';
  end if;

  insert into public.blocks (blocker_id, blocked_id)
  values (v_uid, p_user_id)
  on conflict do nothing;

  -- Withdraw pending join requests between the two, in both directions. The
  -- block already exists, so the notification trigger stays silent.
  update public.activities
     set pending_requests = array_remove(pending_requests, p_user_id)
   where host_id = v_uid and p_user_id = any (pending_requests);
  update public.activities
     set pending_requests = array_remove(pending_requests, v_uid)
   where host_id = p_user_id and v_uid = any (pending_requests);
end;
$$;

create function public.unblock_user(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  delete from public.blocks where blocker_id = v_uid and blocked_id = p_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Blocks hide content in both directions
-- ---------------------------------------------------------------------------

-- messages: in the room, and not written by someone you have a block with.
drop policy "messages: read if in the room" on public.messages;
create policy "messages: read if in the room"
  on public.messages for select to authenticated
  using (
    (
      (activity_id is not null and public.is_activity_participant(activity_id))
      or (pod_id is not null and public.is_pod_member(pod_id))
    )
    and not public.is_blocked_with(sender_id)
  );

-- activities: the university-wide branch skips hosts you have a block with,
-- unless you already hold a spot. Pod members still see their pod's activities.
drop policy "activities: read if pod member or same university" on public.activities;
create policy "activities: read if pod member or same university"
  on public.activities for select to authenticated
  using (
    public.is_pod_member(pod_id)
    or (
      visibility = 'university'
      and university <> ''
      and university = public.current_university()
      and (
        not public.is_blocked_with(host_id)
        or (select auth.uid()) = any (participants)
      )
    )
  );

-- Same test as the policy above.
create or replace function public.can_view_activity(p_activity_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.activities a
    where a.id = p_activity_id
      and (
        public.is_pod_member(a.pod_id)
        or (
          a.visibility = 'university'
          and a.university <> ''
          and a.university = public.current_university()
          and (
            not public.is_blocked_with(a.host_id)
            or (select auth.uid()) = any (a.participants)
          )
        )
      )
  );
$$;

-- As in the initial schema, plus: no new request when there is a block
-- between the caller and the host (reported as "not found", so the host's
-- block is not revealed).
create or replace function public.request_join_activity(p_activity_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_act public.activities%rowtype;
begin
  if not public.can_view_activity(p_activity_id) then
    raise exception 'Activity not found';
  end if;
  select * into v_act from public.activities where id = p_activity_id for update;
  if public.is_blocked_with(v_act.host_id) and not (v_uid = any (v_act.participants)) then
    raise exception 'Activity not found';
  end if;
  -- Also in 20261122000000_rpc_guards.sql; repeated because this definition
  -- runs later and replaces that one.
  if v_act.status <> 'active' or v_act.expires_at < now() then
    raise exception 'This activity has ended';
  end if;
  if v_act.auto_approve then
    perform public._approve_participant(p_activity_id, v_uid);
    return;
  end if;
  if v_uid = any (v_act.participants) or v_uid = any (v_act.pending_requests) then
    return;
  end if;
  update public.activities
     set pending_requests = array_append(pending_requests, v_uid)
   where id = p_activity_id;
end;
$$;

-- As in 20261118000100, plus: recipients who have a block with the actor (in
-- either direction) are dropped. Every push event names the other person as
-- its actor, so this one filter covers all five event types.
create or replace function public._enqueue_notification(
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
   where r is not null
     and r is distinct from p_actor_id
     and not exists (
       select 1 from public.blocks b
        where (b.blocker_id = r and b.blocked_id = p_actor_id)
           or (b.blocker_id = p_actor_id and b.blocked_id = r)
     );
  if cardinality(v_recipients) = 0 then
    return;
  end if;
  insert into public.notification_outbox
    (type, activity_id, pod_id, actor_id, recipient_ids, payload)
  values
    (p_type, p_activity_id, p_pod_id, p_actor_id, v_recipients, p_payload);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table public.reports (
  id                uuid primary key default gen_random_uuid(),
  -- Kept (as null) if the reporter later deletes their account.
  reporter_id       uuid references public.profiles (id) on delete set null,
  target_type       text not null check (target_type in ('user', 'pod', 'activity', 'message')),
  target_id         uuid not null,
  reason            text not null check (reason in (
                      'harassment', 'hate', 'sexual', 'violence', 'self_harm',
                      'spam', 'impersonation', 'other')),
  details           text not null default '' check (length(details) <= 1000),
  status            text not null default 'open'
                      check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at        timestamptz not null default now(),
  -- Who the report is about: the user, the message sender, the activity
  -- host or the pod creator. No foreign key, so the report outlives them.
  reported_user_id  uuid,
  -- The content as it was when reported (activity chats are deleted at
  -- expiry). message: { message, senderName, activityId, podId, sentAt };
  -- activity: { title, hostName, podId }; pod: { name, description };
  -- user: { displayName, bio }.
  snapshot          jsonb not null default '{}'
);

create index reports_open_idx on public.reports (created_at) where status = 'open';
create index reports_reporter_idx on public.reports (reporter_id, created_at desc);

-- No policies: clients never read or write reports directly.
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant select, update on public.reports to service_role;

-- File a report. The target must be something the caller can see. Reporting
-- the same thing again while the first report is still open returns that
-- report. At most 20 new reports per user per 24 hours.
create function public.report_content(
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_details text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_details text := trim(coalesce(p_details, ''));
  v_reported uuid;
  v_snapshot jsonb;
  v_id uuid;
begin
  if p_target_type is null
     or p_target_type not in ('user', 'pod', 'activity', 'message') then
    raise exception 'Unknown report type';
  end if;
  if p_reason is null or p_reason not in (
    'harassment', 'hate', 'sexual', 'violence', 'self_harm',
    'spam', 'impersonation', 'other') then
    raise exception 'Choose a reason for the report';
  end if;
  if length(v_details) > 1000 then
    raise exception 'Details must be 1000 characters or fewer';
  end if;

  if p_target_type = 'user' then
    select p.id, jsonb_build_object('displayName', p.display_name, 'bio', p.bio)
      into v_reported, v_snapshot
      from public.profiles p where p.id = p_target_id;
  elsif p_target_type = 'pod' then
    select p.created_by, jsonb_build_object('name', p.name, 'description', p.description)
      into v_reported, v_snapshot
      from public.pods p
     where p.id = p_target_id
       and (p.visibility = 'public' or v_uid = any (p.members));
  elsif p_target_type = 'activity' then
    select a.host_id,
           jsonb_build_object('title', a.title, 'hostName', a.host_name, 'podId', a.pod_id)
      into v_reported, v_snapshot
      from public.activities a
     where a.id = p_target_id and public.can_view_activity(a.id);
  else
    -- Room membership only (not the block filter), so a message can still be
    -- reported after its sender was blocked.
    select m.sender_id,
           jsonb_build_object('message', m.message, 'senderName', m.sender_name,
                              'activityId', m.activity_id, 'podId', m.pod_id,
                              'sentAt', m.created_at)
      into v_reported, v_snapshot
      from public.messages m
     where m.id = p_target_id
       and (
         (m.activity_id is not null and public.is_activity_participant(m.activity_id))
         or (m.pod_id is not null and public.is_pod_member(m.pod_id))
       );
  end if;
  if v_snapshot is null then
    raise exception 'That content is no longer available';
  end if;
  if p_target_type in ('user', 'message') and v_reported = v_uid then
    raise exception 'You cannot report yourself';
  end if;

  -- One at a time per reporter, so the checks below cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  select r.id into v_id
    from public.reports r
   where r.reporter_id = v_uid and r.target_type = p_target_type
     and r.target_id = p_target_id and r.status = 'open';
  if found then
    return v_id;
  end if;

  if (select count(*) from public.reports r
       where r.reporter_id = v_uid
         and r.created_at > now() - interval '24 hours') >= 20 then
    raise exception 'You have reached the daily report limit. Try again tomorrow.';
  end if;

  insert into public.reports
    (reporter_id, target_type, target_id, reason, details, reported_user_id, snapshot)
  values
    (v_uid, p_target_type, p_target_id, p_reason, v_details, v_reported, v_snapshot)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function permissions. Supabase grants EXECUTE on new public functions to
-- anon/authenticated by default, so revoke explicitly. (The three replaced
-- functions keep the privileges they already had.)
-- ---------------------------------------------------------------------------

revoke execute on function public.is_blocked_with(uuid) from public, anon;
revoke execute on function public.block_user(uuid) from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
revoke execute on function public.report_content(text, uuid, text, text) from public, anon;
grant  execute on function public.is_blocked_with(uuid) to authenticated;
grant  execute on function public.block_user(uuid) to authenticated;
grant  execute on function public.unblock_user(uuid) to authenticated;
grant  execute on function public.report_content(text, uuid, text, text) to authenticated;
