-- =============================================================================
-- Profile emails are no longer readable by every signed-in user
--
-- "profiles: signed-in users can read" exposes whole rows, so any student at
-- any university could list every other student's email address. Emails are
-- now readable only:
--   - by their owner (the app takes it from the auth session), and
--   - by people who share a pod with them, through get_pod_member_emails()
--     (the member popup in a pod shows it), unless either has blocked the other.
-- Everything else on a profile stays readable as before.
-- =============================================================================

revoke select on public.profiles from authenticated;
grant select (
  id, display_name, university, profile_photo, bio, join_date,
  pods_joined, commendations, posts_count, major, interests
) on public.profiles to authenticated;

-- Emails of the members of a pod the caller belongs to.
create function public.get_pod_member_emails(p_pod_id uuid)
returns table (profile_id uuid, email text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  if not public.is_pod_member(p_pod_id) then
    raise exception 'Only pod members can see member emails';
  end if;
  return query
    select p.id, p.email
      from public.pods pod
      join public.profiles p on p.id = any (pod.members)
     where pod.id = p_pod_id
       and (p.id = v_uid or not public.is_blocked_with(p.id));
end;
$$;

revoke execute on function public.get_pod_member_emails(uuid) from public, anon;
grant execute on function public.get_pod_member_emails(uuid) to authenticated;
