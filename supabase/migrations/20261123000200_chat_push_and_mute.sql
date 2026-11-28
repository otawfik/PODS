-- =============================================================================
-- Chat message pushes and per-pod mute
-- (builds on 20261118000100_push_notifications.sql)
--
-- 1. pod_mutes: one row per (pod, member) who muted the pod. Users read only
--    their own rows and change them through set_pod_mute().
--    A muted pod sends that user no `new_activity` and no pod-chat pushes.
--    Direct notifications still arrive: a join request to a host, a decision
--    on your own request, and messages in an activity chat you joined.
--    The mute is applied by a BEFORE INSERT trigger on notification_outbox,
--    so it holds for every function that writes those events.
--
-- 2. chat_message: a new row in public.messages notifies the other people in
--    the room (activity chat → the other participants of an active activity;
--    pod chat → the other pod members). The sender is never notified.
--
--    Collapse rule (chat is high volume): a recipient gets no new chat
--    notification for a room while they already have one for that room that
--    is either still waiting to be sent, or was queued in the last 2 minutes.
--    So each person hears from a busy chat at most once every 2 minutes per
--    room, and the push shows the first message of that burst. Message
--    inserts in one room are serialized with an advisory lock so two
--    simultaneous messages cannot both slip past the check.
--
--    As with the activity triggers, a notification problem never rolls back
--    the message: the trigger swallows its own errors (as warnings).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Per-pod mute
-- ---------------------------------------------------------------------------

create table public.pod_mutes (
  pod_id      uuid not null references public.pods (id) on delete cascade,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (pod_id, profile_id)
);

create index pod_mutes_profile_idx on public.pod_mutes (profile_id);

alter table public.pod_mutes enable row level security;

create policy "pod_mutes: read own"
  on public.pod_mutes for select to authenticated
  using (profile_id = (select auth.uid()));

-- Writes go through set_pod_mute(). (Supabase grants ALL on new public
-- tables to anon/authenticated by default.)
revoke all on public.pod_mutes from anon, authenticated;
grant select on public.pod_mutes to authenticated;

-- Mute or unmute a pod for the caller. Only members can mute.
create function public.set_pod_mute(p_pod_id uuid, p_muted boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if p_muted is null then
    raise exception 'Choose muted or unmuted';
  end if;
  if not exists (
    select 1 from public.pods where id = p_pod_id and v_uid = any (members)
  ) then
    raise exception 'You are not a member of this pod';
  end if;

  if p_muted then
    insert into public.pod_mutes (pod_id, profile_id)
    values (p_pod_id, v_uid)
    on conflict do nothing;
  else
    delete from public.pod_mutes where pod_id = p_pod_id and profile_id = v_uid;
  end if;
end;
$$;

-- Leaving (or being removed from) a pod forgets the mute, so rejoining
-- starts unmuted.
create function public.clear_mutes_of_former_members()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.pod_mutes
   where pod_id = new.id and profile_id <> all (new.members);
  return null;
end;
$$;

create trigger pods_clear_mutes
  after update of members on public.pods
  for each row execute function public.clear_mutes_of_former_members();

-- ---------------------------------------------------------------------------
-- Outbox: new type, and the mute filter
-- ---------------------------------------------------------------------------

alter table public.notification_outbox
  drop constraint notification_outbox_type_check;
alter table public.notification_outbox
  add constraint notification_outbox_type_check check (type in (
    'join_request', 'participant_joined', 'request_approved',
    'request_declined', 'new_activity', 'chat_message'));

-- Finds a recipient's latest chat notification for a room (collapse rule).
-- A chat row has exactly one of activity_id / pod_id.
create index notification_outbox_chat_room_idx
  on public.notification_outbox ((coalesce(activity_id, pod_id)), created_at desc)
  where type = 'chat_message';

-- Drop muted recipients from pod-wide events before the row is stored; skip
-- the row when nobody is left. Pod-wide events are `new_activity` and pod
-- chat (a chat_message without an activity).
create function public.apply_pod_mutes_to_outbox()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.pod_id is null
     or not (new.type = 'new_activity'
             or (new.type = 'chat_message' and new.activity_id is null)) then
    return new;
  end if;

  select coalesce(array_agg(r), '{}')
    into new.recipient_ids
    from unnest(new.recipient_ids) as r
   where not exists (
     select 1 from public.pod_mutes m
      where m.pod_id = new.pod_id and m.profile_id = r
   );
  if cardinality(new.recipient_ids) = 0 then
    return null;
  end if;
  return new;
end;
$$;

create trigger notification_outbox_apply_mutes
  before insert on public.notification_outbox
  for each row execute function public.apply_pod_mutes_to_outbox();

-- ---------------------------------------------------------------------------
-- Chat messages → outbox
-- ---------------------------------------------------------------------------

create function public.enqueue_chat_notification()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_room uuid := coalesce(new.activity_id, new.pod_id);
  v_members uuid[];
  v_recipients uuid[];
  v_payload jsonb;
  v_title text;
begin
  begin
    if new.activity_id is not null then
      select participants, title into v_members, v_title
        from public.activities
       where id = new.activity_id and status = 'active';
      v_payload := jsonb_build_object('activityTitle', v_title);
    else
      select members, name into v_members, v_title
        from public.pods where id = new.pod_id;
      v_payload := jsonb_build_object('podName', v_title);
    end if;
    if v_members is null then
      return null;
    end if;

    -- One message at a time per room, so the check below sees earlier rows.
    perform pg_advisory_xact_lock(hashtextextended(v_room::text, 0));

    select coalesce(array_agg(r), '{}')
      into v_recipients
      from unnest(v_members) as r
     where r is distinct from new.sender_id
       and not exists (
         select 1 from public.notification_outbox o
          where o.type = 'chat_message'
            and coalesce(o.activity_id, o.pod_id) = v_room
            and r = any (o.recipient_ids)
            and (
              (o.sent_at is null and o.attempts < 5)
              or o.created_at > now() - interval '2 minutes'
            )
       );

    -- The preview is clipped here so the outbox never holds whole messages.
    perform public._enqueue_notification(
      'chat_message', new.activity_id, new.pod_id, new.sender_id, v_recipients,
      v_payload || jsonb_build_object(
        'actorName', new.sender_name,
        'preview', left(new.message, 140)
      )
    );
  exception when others then
    -- Never let a notification problem block sending the message.
    raise warning 'enqueue_chat_notification failed: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger messages_notify_insert
  after insert on public.messages
  for each row execute function public.enqueue_chat_notification();

-- ---------------------------------------------------------------------------
-- Function permissions (Supabase grants EXECUTE to anon/authenticated by
-- default, so revoke explicitly).
-- ---------------------------------------------------------------------------

revoke execute on function public.set_pod_mute(uuid, boolean) from public, anon;
grant  execute on function public.set_pod_mute(uuid, boolean) to authenticated;

revoke execute on function public.clear_mutes_of_former_members() from public, anon, authenticated;
revoke execute on function public.apply_pod_mutes_to_outbox() from public, anon, authenticated;
revoke execute on function public.enqueue_chat_notification() from public, anon, authenticated;
