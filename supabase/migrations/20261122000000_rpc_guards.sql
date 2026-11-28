-- =============================================================================
-- Three missing checks in existing RPCs (found by supabase/tests/rules.test.mjs)
--
-- 1. request_join_activity / approve_join_request accepted an activity that
--    had already ended; with auto-approve the person was added to it.
-- 2. grant_pod_admin could make someone who is not in the pod an admin.
-- 3. remove_pod_admin could remove the last admin, leaving a pod nobody can
--    manage or delete (leave_pod already refuses this; now this does too).
--
-- Signatures and grants are unchanged (create or replace keeps them).
--
-- Dated before the reports/blocks migration on purpose: that one also replaces
-- request_join_activity (adding the block check) and must run after this.
-- =============================================================================

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

create or replace function public.approve_join_request(p_activity_id uuid, p_user_id uuid)
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
  if v_act.status <> 'active' or v_act.expires_at < now() then
    raise exception 'This activity has ended';
  end if;
  perform public._approve_participant(p_activity_id, p_user_id);
end;
$$;

create or replace function public.grant_pod_admin(p_pod_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_pod public.pods%rowtype;
begin
  if not public.is_pod_admin(p_pod_id) then
    raise exception 'Only admins can manage admins';
  end if;
  select * into v_pod from public.pods where id = p_pod_id for update;
  if not (p_user_id = any (v_pod.members)) then
    raise exception 'Only pod members can be made admins';
  end if;
  update public.pods
     set admins = array_append(array_remove(admins, p_user_id), p_user_id)
   where id = p_pod_id;
end;
$$;

create or replace function public.remove_pod_admin(p_pod_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
  v_pod public.pods%rowtype;
begin
  if not public.is_pod_admin(p_pod_id) then
    raise exception 'Only admins can manage admins';
  end if;
  select * into v_pod from public.pods where id = p_pod_id for update;
  if p_user_id = any (v_pod.admins) and cardinality(v_pod.admins) = 1 then
    raise exception 'A pod needs at least one admin. Make another member an admin first.';
  end if;
  update public.pods
     set admins = array_remove(admins, p_user_id)
   where id = p_pod_id;
end;
$$;
