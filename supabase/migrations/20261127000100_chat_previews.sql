-- =============================================================================
-- Latest message per activity chat, for the Messages list
--
-- One call instead of one query per chat. SECURITY INVOKER on purpose: the
-- caller's Row Level Security applies, so it returns only messages they could
-- read anyway (their own activities, minus anyone they have a block with).
-- =============================================================================

create function public.get_chat_previews(p_activity_ids uuid[])
returns table (
  activity_id uuid,
  sender_id   uuid,
  sender_name text,
  message     text,
  created_at  timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select distinct on (m.activity_id)
         m.activity_id, m.sender_id, m.sender_name, left(m.message, 140), m.created_at
    from public.messages m
   where m.activity_id = any (p_activity_ids)
   order by m.activity_id, m.created_at desc;
$$;

revoke execute on function public.get_chat_previews(uuid[]) from public, anon;
grant execute on function public.get_chat_previews(uuid[]) to authenticated;
