-- =============================================================================
-- PODS — initial Supabase schema (port of the Firestore data model + rules)
--
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- (Or `supabase db push` if you use the Supabase CLI.)
--
-- Tables mirror the old Firestore collections:
--   users       → public.profiles   (one row per auth user, created by trigger)
--   pods        → public.pods       (podInvites folded in as pods.invite_code)
--   activities  → public.activities
--   messages    → public.messages   (realtime enabled)
--
-- Reads are governed by Row Level Security policies that mirror
-- firestore.rules. Every multi-step write (join/leave, approve, create,
-- delete…) goes through a SECURITY DEFINER function so it is atomic and the
-- permission checks live on the server.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  display_name   text not null default 'Member',
  email          text not null default '',
  university     text not null default '',
  profile_photo  text,
  bio            text,
  join_date      timestamptz not null default now(),
  pods_joined    uuid[] not null default '{}',
  commendations  integer not null default 0,
  posts_count    integer not null default 0
);

create table public.pods (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text not null default '',
  category      text not null,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  member_count  integer not null default 1,
  visibility    text not null default 'public' check (visibility in ('public', 'private')),
  members       uuid[] not null default '{}',
  admins        uuid[] not null default '{}',
  banner_color  text not null default '#6C63FF',
  invite_code   text unique
);

create table public.activities (
  id                    uuid primary key default gen_random_uuid(),
  pod_id                uuid not null references public.pods (id) on delete cascade,
  host_id               uuid not null references public.profiles (id) on delete cascade,
  host_name             text not null default '',
  title                 text not null,
  category              text not null,
  tags                  text[] not null default '{}',
  start_time            timestamptz not null,
  expires_at            timestamptz not null,
  max_participants      integer not null check (max_participants > 0),
  current_participants  integer not null default 1,
  participants          uuid[] not null default '{}',
  pending_requests      uuid[] not null default '{}',
  status                text not null default 'active' check (status in ('active', 'expired')),
  visibility            text not null default 'pod' check (visibility in ('pod', 'university')),
  university            text not null default '',
  auto_approve          boolean not null default false,
  created_at            timestamptz not null default now()
);

create index activities_pod_id_idx on public.activities (pod_id);
create index activities_university_idx on public.activities (visibility, university, status);

create table public.messages (
  id           uuid primary key default gen_random_uuid(),
  activity_id  uuid references public.activities (id) on delete cascade,
  pod_id       uuid references public.pods (id) on delete cascade,
  sender_id    uuid not null references public.profiles (id) on delete cascade,
  sender_name  text not null default '',
  message      text not null check (length(message) between 1 and 4000),
  created_at   timestamptz not null default now(),
  -- Each message belongs to exactly one room: an activity chat or a pod chat.
  constraint messages_one_room check (num_nonnulls(activity_id, pod_id) = 1)
);

create index messages_activity_idx on public.messages (activity_id, created_at desc);
create index messages_pod_idx on public.messages (pod_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Profile row for every new auth user
-- (display_name / university come from signUp options.data)
-- ---------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email, university)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Member'),
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'university', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Helper functions used by the policies (SECURITY DEFINER so policies on one
-- table can look at another without tripping that table's own RLS)
-- ---------------------------------------------------------------------------

create function public.is_pod_member(p_pod_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.pods
    where id = p_pod_id and (select auth.uid()) = any (members)
  );
$$;

create function public.is_pod_admin(p_pod_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.pods
    where id = p_pod_id and (select auth.uid()) = any (admins)
  );
$$;

create function public.is_activity_participant(p_activity_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.activities
    where id = p_activity_id and (select auth.uid()) = any (participants)
  );
$$;

create function public.current_university()
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select university from public.profiles where id = (select auth.uid())),
    ''
  );
$$;

-- Can the current user see this activity? (same test as the SELECT policy)
create function public.can_view_activity(p_activity_id uuid)
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
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles   enable row level security;
alter table public.pods       enable row level security;
alter table public.activities enable row level security;
alter table public.messages   enable row level security;

-- profiles: any signed-in user can read (member lists, names);
-- users create/update only their own row; nobody deletes from the client.
create policy "profiles: signed-in users can read"
  on public.profiles for select to authenticated
  using (true);

create policy "profiles: insert own"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- pods: public pods, or private pods you belong to.
-- Admins may edit metadata directly; membership changes, creation and
-- deletion go through the functions below.
create policy "pods: read public or member"
  on public.pods for select to authenticated
  using (visibility = 'public' or (select auth.uid()) = any (members));

create policy "pods: admins update"
  on public.pods for update to authenticated
  using ((select auth.uid()) = any (admins))
  with check (true);

-- activities: pod members, or same-university users for university-wide
-- activities. All writes go through functions.
create policy "activities: read if pod member or same university"
  on public.activities for select to authenticated
  using (
    public.is_pod_member(pod_id)
    or (
      visibility = 'university'
      and university <> ''
      and university = public.current_university()
    )
  );

-- messages: activity participants / pod members can read and send.
create policy "messages: read if in the room"
  on public.messages for select to authenticated
  using (
    (activity_id is not null and public.is_activity_participant(activity_id))
    or (pod_id is not null and public.is_pod_member(pod_id))
  );

create policy "messages: send if in the room"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and (
      (activity_id is not null and public.is_activity_participant(activity_id))
      or (pod_id is not null and public.is_pod_member(pod_id))
    )
  );

-- ---------------------------------------------------------------------------
-- Pod functions
-- ---------------------------------------------------------------------------

-- Raises if there is no signed-in user; returns their id.
create function public.require_user()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'You must be signed in';
  end if;
  return v_uid;
end;
$$;

-- Short, unambiguous invite code (no 0/O, 1/I/L).
create function public.generate_invite_code()
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  chars constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.pods where invite_code = code);
  end loop;
  return code;
end;
$$;

create function public.create_pod(
  p_name text,
  p_description text,
  p_category text,
  p_visibility text,
  p_banner_color text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_id uuid;
begin
  insert into public.pods (
    name, description, category, visibility, banner_color,
    created_by, member_count, members, admins, invite_code
  )
  values (
    p_name, coalesce(p_description, ''), p_category, p_visibility,
    coalesce(p_banner_color, '#6C63FF'),
    v_uid, 1, array[v_uid], array[v_uid], public.generate_invite_code()
  )
  returning id into v_id;

  update public.profiles
     set pods_joined = array_append(array_remove(pods_joined, v_id), v_id)
   where id = v_uid;

  return v_id;
end;
$$;

-- Internal: add the current user to a pod (row must already be locked).
create function public._add_pod_member(p_pod_id uuid, p_uid uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.pods
     set members = array_append(members, p_uid),
         member_count = member_count + 1
   where id = p_pod_id and not (p_uid = any (members));

  update public.profiles
     set pods_joined = array_append(array_remove(pods_joined, p_pod_id), p_pod_id)
   where id = p_uid;
end;
$$;

create function public.join_pod(p_pod_id uuid, p_invite_code text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_pod public.pods%rowtype;
  v_attempt text := upper(trim(coalesce(p_invite_code, '')));
begin
  select * into v_pod from public.pods where id = p_pod_id for update;
  if not found then
    raise exception 'Pod not found';
  end if;
  if v_uid = any (v_pod.members) then
    return;
  end if;
  if v_pod.visibility = 'private' and v_pod.invite_code is not null then
    if v_attempt = '' or v_attempt <> upper(v_pod.invite_code) then
      raise exception 'This pod is private. Enter a valid invite code to join.';
    end if;
  end if;
  perform public._add_pod_member(p_pod_id, v_uid);
end;
$$;

create function public.join_pod_with_code(p_code text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_pod public.pods%rowtype;
begin
  if v_code = '' then
    raise exception 'Enter an invite code';
  end if;
  select * into v_pod from public.pods where invite_code = v_code for update;
  if not found then
    raise exception 'Invalid invite code';
  end if;
  if v_uid = any (v_pod.members) then
    raise exception 'You are already a member of this pod';
  end if;
  perform public._add_pod_member(v_pod.id, v_uid);
  return v_pod.id;
end;
$$;

create function public.leave_pod(p_pod_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_pod public.pods%rowtype;
begin
  select * into v_pod from public.pods where id = p_pod_id for update;
  if not found or not (v_uid = any (v_pod.members)) then
    return;
  end if;
  if v_uid = any (v_pod.admins) and cardinality(v_pod.admins) = 1 then
    raise exception 'You are the last admin. Grant admin to another member or delete the pod instead.';
  end if;
  update public.pods
     set members = array_remove(members, v_uid),
         admins = array_remove(admins, v_uid),
         member_count = greatest(member_count - 1, 0)
   where id = p_pod_id;
  update public.profiles
     set pods_joined = array_remove(pods_joined, p_pod_id)
   where id = v_uid;
end;
$$;

create function public.grant_pod_admin(p_pod_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if not public.is_pod_admin(p_pod_id) then
    raise exception 'Only admins can manage admins';
  end if;
  update public.pods
     set admins = array_append(array_remove(admins, p_user_id), p_user_id)
   where id = p_pod_id;
end;
$$;

create function public.remove_pod_admin(p_pod_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if not public.is_pod_admin(p_pod_id) then
    raise exception 'Only admins can manage admins';
  end if;
  update public.pods
     set admins = array_remove(admins, p_user_id)
   where id = p_pod_id;
end;
$$;

-- Deletes the pod; its activities and all chat messages go with it (FK cascade).
create function public.delete_pod(p_pod_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if not exists (select 1 from public.pods where id = p_pod_id) then
    return;
  end if;
  if not public.is_pod_admin(p_pod_id) then
    raise exception 'Only admins can delete this pod';
  end if;
  delete from public.pods where id = p_pod_id;
  update public.profiles
     set pods_joined = array_remove(pods_joined, p_pod_id)
   where p_pod_id = any (pods_joined);
end;
$$;

-- Drop pod ids that no longer exist from the caller's pods_joined.
create function public.remove_pods_from_user(p_pod_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  update public.profiles
     set pods_joined = array(
       select p from unnest(pods_joined) as p where not (p = any (p_pod_ids))
     )
   where id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Activity functions
-- ---------------------------------------------------------------------------

create function public.create_activity(
  p_pod_id uuid,
  p_host_name text,
  p_title text,
  p_category text,
  p_tags text[],
  p_start_time timestamptz,
  p_expires_at timestamptz,
  p_max_participants integer,
  p_visibility text,
  p_auto_approve boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_university text;
  v_id uuid;
begin
  if not public.is_pod_member(p_pod_id) then
    raise exception 'You must be a pod member to post an activity';
  end if;
  select coalesce(nullif(university, ''), 'Unknown University')
    into v_university
    from public.profiles where id = v_uid;

  insert into public.activities (
    pod_id, host_id, host_name, title, category, tags, start_time, expires_at,
    max_participants, current_participants, participants, pending_requests,
    status, visibility, university, auto_approve
  )
  values (
    p_pod_id, v_uid, coalesce(p_host_name, ''), p_title, p_category,
    coalesce(p_tags, '{}'), p_start_time, p_expires_at,
    p_max_participants, 1, array[v_uid], '{}',
    'active', p_visibility, coalesce(v_university, 'Unknown University'),
    coalesce(p_auto_approve, false)
  )
  returning id into v_id;

  update public.profiles set posts_count = posts_count + 1 where id = v_uid;
  return v_id;
end;
$$;

-- Marks an activity expired once its time has passed and clears its chat.
-- Returns the (possibly updated) status. Safe for anyone who can see it.
create function public.expire_activity_if_needed(p_activity_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_status text;
begin
  if not public.can_view_activity(p_activity_id) then
    return null;
  end if;
  update public.activities
     set status = 'expired'
   where id = p_activity_id and status = 'active' and expires_at < now()
  returning status into v_status;
  if found then
    delete from public.messages where activity_id = p_activity_id;
    return v_status;
  end if;
  select status into v_status from public.activities where id = p_activity_id;
  return v_status;
end;
$$;

-- Internal: approve with a capacity check (row must already be locked).
create function public._approve_participant(p_activity_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_act public.activities%rowtype;
begin
  select * into v_act from public.activities where id = p_activity_id;
  if p_user_id = any (v_act.participants) then
    -- Already in: just clear any stale pending request.
    update public.activities
       set pending_requests = array_remove(pending_requests, p_user_id)
     where id = p_activity_id;
    return;
  end if;
  if v_act.current_participants >= v_act.max_participants then
    raise exception 'Activity is full';
  end if;
  update public.activities
     set participants = array_append(participants, p_user_id),
         pending_requests = array_remove(pending_requests, p_user_id),
         current_participants = current_participants + 1
   where id = p_activity_id;
end;
$$;

create function public.request_join_activity(p_activity_id uuid)
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

create function public.approve_join_request(p_activity_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_act public.activities%rowtype;
begin
  select * into v_act from public.activities where id = p_activity_id for update;
  if not found then
    raise exception 'Activity not found';
  end if;
  if v_act.host_id <> v_uid then
    raise exception 'Only the host can approve join requests';
  end if;
  perform public._approve_participant(p_activity_id, p_user_id);
end;
$$;

create function public.reject_join_request(p_activity_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if not exists (
    select 1 from public.activities
    where id = p_activity_id and (host_id = v_uid or p_user_id = v_uid)
  ) then
    raise exception 'Only the host can decline join requests';
  end if;
  update public.activities
     set pending_requests = array_remove(pending_requests, p_user_id)
   where id = p_activity_id;
end;
$$;

create function public.leave_activity(p_activity_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_act public.activities%rowtype;
begin
  select * into v_act from public.activities where id = p_activity_id for update;
  if not found then
    return;
  end if;
  if v_act.host_id = v_uid then
    raise exception 'As the host you cannot leave your own activity. Delete it instead.';
  end if;
  if not (v_uid = any (v_act.participants)) then
    return;
  end if;
  update public.activities
     set participants = array_remove(participants, v_uid),
         current_participants = greatest(current_participants - 1, 0)
   where id = p_activity_id;
end;
$$;

-- Host or pod admin. Chat messages go with it (FK cascade).
create function public.delete_activity(p_activity_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_act public.activities%rowtype;
begin
  select * into v_act from public.activities where id = p_activity_id;
  if not found then
    return;
  end if;
  if v_act.host_id <> v_uid and not public.is_pod_admin(v_act.pod_id) then
    raise exception 'Only the host or a pod admin can delete this activity';
  end if;
  delete from public.activities where id = p_activity_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function permissions: signed-in users only; internal helpers not callable.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public._add_pod_member(uuid, uuid) from authenticated;
revoke execute on function public._approve_participant(uuid, uuid) from authenticated;
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.generate_invite_code() from authenticated;

-- Table privileges (RLS above still decides which rows). Explicit so this
-- doesn't depend on the project's default grants.
revoke all on public.profiles, public.pods, public.activities, public.messages from anon;
grant select, insert, update on public.profiles to authenticated;
grant select, update on public.pods to authenticated;
grant select on public.activities to authenticated;
grant select, insert on public.messages to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime for chat
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.messages;
