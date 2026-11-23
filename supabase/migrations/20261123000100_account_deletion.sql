-- =============================================================================
-- Account deletion (App Store guideline 5.1.1(v): delete from inside the app)
--
-- Membership lives in uuid[] columns (pods.members/admins,
-- activities.participants/pending_requests, notification_outbox.recipient_ids),
-- which foreign keys cannot cascade. public.delete_account_data(uid) removes
-- a user from all of them, in one transaction:
--
--   Pods         removed from members/admins; member_count recounted.
--                Nobody else in the pod  -> the pod is deleted (its
--                activities and chats cascade).
--                Last admin, others stay -> the longest-standing remaining
--                member becomes admin. `members` is append-only on join, so
--                that is the first remaining entry of pods.members.
--   Activities   the ones they host are deleted (with their chats and queued
--                notifications); elsewhere they are removed from
--                participants/pending_requests and current_participants is
--                recounted.
--   Messages     everything they sent is deleted.
--   Devices etc. push tokens, the recommendation cache row, and queued
--                notifications from or to them are deleted.
--
-- The profile row is NOT deleted here. It goes when the auth user is deleted
-- (profiles.id references auth.users on delete cascade), which the
-- delete-account Edge Function does next. If that second step fails the user
-- still has a working, signed-in account (just with no pods) and can retry:
-- this function is idempotent.
--
-- Safety net: an AFTER DELETE trigger on profiles runs the same cleanup, in
-- the same transaction as the auth.users delete. It covers users deleted
-- from the dashboard, and anything the user joined between the two steps.
--
-- Only the service role may call delete_account_data.
-- =============================================================================

create function public.delete_account_data(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_pod public.pods%rowtype;
  v_members uuid[];
  v_admins uuid[];
  v_pods_deleted uuid[] := '{}';
  v_pods_left integer := 0;
  v_admins_promoted integer := 0;
  v_activities_deleted integer;
  v_activities_left integer;
begin
  if p_user_id is null then
    raise exception 'A user id is required';
  end if;

  -- 1. Activities they host. Chats and queued notifications cascade.
  delete from public.activities where host_id = p_user_id;
  get diagnostics v_activities_deleted = row_count;

  -- 2. Pods. Lock each row so a concurrent join/leave can't interleave.
  for v_pod in
    select * from public.pods
     where p_user_id = any (members) or p_user_id = any (admins)
     order by id
     for update
  loop
    v_members := array_remove(v_pod.members, p_user_id);
    v_admins := array_remove(v_pod.admins, p_user_id);

    if cardinality(v_members) = 0 then
      delete from public.pods where id = v_pod.id;
      v_pods_deleted := array_append(v_pods_deleted, v_pod.id);
      continue;
    end if;

    -- Admins who are no longer members don't count.
    v_admins := array(select a from unnest(v_admins) as a where a = any (v_members));
    if cardinality(v_admins) = 0 then
      -- Handoff: the longest-standing remaining member (see header).
      v_admins := array[v_members[1]];
      v_admins_promoted := v_admins_promoted + 1;
    end if;

    update public.pods
       set members = v_members,
           admins = v_admins,
           member_count = cardinality(v_members)
     where id = v_pod.id;
    v_pods_left := v_pods_left + 1;
  end loop;

  -- Same bookkeeping as delete_pod(); also empties the user's own list while
  -- their profile still exists.
  update public.profiles
     set pods_joined = array(
       select p from unnest(pods_joined) as p where not (p = any (v_pods_deleted))
     )
   where pods_joined && v_pods_deleted;
  update public.profiles set pods_joined = '{}'
   where id = p_user_id and cardinality(pods_joined) > 0;

  -- 3. Other people's activities (the pod deletes above removed some).
  update public.activities
     set participants = array_remove(participants, p_user_id),
         pending_requests = array_remove(pending_requests, p_user_id),
         current_participants = cardinality(array_remove(participants, p_user_id))
   where p_user_id = any (participants) or p_user_id = any (pending_requests);
  get diagnostics v_activities_left = row_count;

  -- 4. Rows that would cascade with the profile anyway; deleted now so the
  --    account is already empty if the auth delete has to be retried.
  delete from public.messages where sender_id = p_user_id;
  delete from public.push_tokens where profile_id = p_user_id;
  delete from public.pod_recommendations where profile_id = p_user_id;

  -- 5. Queued notifications, last: step 3 fires the activities trigger, which
  --    queues a "request declined" push addressed to the departing user.
  delete from public.notification_outbox
   where actor_id = p_user_id
      or (p_user_id = any (recipient_ids)
          and cardinality(array_remove(recipient_ids, p_user_id)) = 0);
  update public.notification_outbox
     set recipient_ids = array_remove(recipient_ids, p_user_id)
   where p_user_id = any (recipient_ids);

  return jsonb_build_object(
    'pods_left', v_pods_left,
    'pods_deleted', cardinality(v_pods_deleted),
    'admins_promoted', v_admins_promoted,
    'activities_deleted', v_activities_deleted,
    'activities_left', v_activities_left
  );
end;
$$;

-- Safety net: whenever a profile row goes (normally via the auth.users
-- cascade), scrub the arrays in the same transaction. AFTER, not BEFORE: the
-- cleanup updates the profile row, which a BEFORE DELETE trigger may not do.
create function public.cleanup_deleted_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.delete_account_data(old.id);
  return null;
end;
$$;

create trigger profiles_cleanup_after_delete
  after delete on public.profiles
  for each row execute function public.cleanup_deleted_profile();

-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default, so revoke explicitly.
revoke execute on function public.delete_account_data(uuid) from public, anon, authenticated;
revoke execute on function public.cleanup_deleted_profile() from public, anon, authenticated;
grant  execute on function public.delete_account_data(uuid) to service_role;
