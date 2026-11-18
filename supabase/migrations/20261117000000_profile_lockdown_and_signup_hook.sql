-- =============================================================================
-- Profiles: server-owned identity columns, interests/major, .edu sign-up hook
--
-- 1. SECURITY FIX. The "profiles: update own" policy let a user rewrite any
--    column of their own row, including `university`, which Row Level
--    Security trusts for university-wide activity visibility (and `email`,
--    `pods_joined`, `commendations`, `posts_count`). Clients may now update
--    only display_name, bio, profile_photo, major and interests. University
--    and email are derived on the server from the verified auth email.
-- 2. Profile signals for recommendations: `major`, `interests`.
-- 3. A `before user created` auth hook that rejects non-.edu sign-ups
--    (until now only the app checked). Must be switched on once in the
--    dashboard: Authentication → Hooks → "Before User Created" →
--    Postgres function → public.hook_before_user_created.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- University lookup (server-side twin of src/constants/categories.ts)
-- ---------------------------------------------------------------------------

create table public.universities (
  domain text primary key check (domain = lower(domain)),
  name   text not null
);
alter table public.universities enable row level security;
-- No policies: only SECURITY DEFINER functions read it.

insert into public.universities (domain, name) values
  ('bu.edu', 'Boston University'),
  ('mit.edu', 'MIT'),
  ('harvard.edu', 'Harvard University'),
  ('stanford.edu', 'Stanford University'),
  ('ucla.edu', 'UCLA'),
  ('usc.edu', 'University of Southern California'),
  ('nyu.edu', 'New York University'),
  ('columbia.edu', 'Columbia University'),
  ('cornell.edu', 'Cornell University'),
  ('yale.edu', 'Yale University'),
  ('princeton.edu', 'Princeton University'),
  ('upenn.edu', 'University of Pennsylvania'),
  ('brown.edu', 'Brown University'),
  ('dartmouth.edu', 'Dartmouth College'),
  ('umich.edu', 'University of Michigan'),
  ('uchicago.edu', 'University of Chicago'),
  ('gatech.edu', 'Georgia Tech'),
  ('cmu.edu', 'Carnegie Mellon University'),
  ('duke.edu', 'Duke University'),
  ('vanderbilt.edu', 'Vanderbilt University'),
  ('georgetown.edu', 'Georgetown University'),
  ('northwestern.edu', 'Northwestern University'),
  ('emory.edu', 'Emory University'),
  ('nd.edu', 'University of Notre Dame'),
  ('unc.edu', 'UNC Chapel Hill'),
  ('virginia.edu', 'University of Virginia'),
  ('wustl.edu', 'Washington University in St. Louis'),
  ('rice.edu', 'Rice University'),
  ('tufts.edu', 'Tufts University'),
  ('bc.edu', 'Boston College'),
  ('northeastern.edu', 'Northeastern University');

-- 'jo@cs.bu.edu' → 'Boston University' (longest matching suffix);
-- unknown 'jo@foo.edu' → 'FOO University'. Mirrors getUniversityFromEmail().
create function public.university_for_email(p_email text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_domain text := lower(split_part(coalesce(p_email, ''), '@', 2));
  v_labels text[];
  v_name text;
begin
  if v_domain = '' then
    return 'Unknown University';
  end if;
  v_labels := string_to_array(v_domain, '.');
  for i in 1..cardinality(v_labels) loop
    select name into v_name from public.universities
     where domain = array_to_string(v_labels[i:], '.');
    if found then
      return v_name;
    end if;
  end loop;
  -- Fallback: the label just before the TLD (bu in cs.bu.edu).
  if cardinality(v_labels) >= 2 then
    return upper(v_labels[cardinality(v_labels) - 1]) || ' University';
  end if;
  return upper(v_labels[1]) || ' University';
end;
$$;

-- ---------------------------------------------------------------------------
-- New profile columns
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column major     text   not null default ''
    check (length(major) <= 80),
  add column interests text[] not null default '{}'
    check (cardinality(interests) <= 20
           and coalesce(length(array_to_string(interests, '')), 0) <= 600);

-- ---------------------------------------------------------------------------
-- Identity columns are server-owned
-- ---------------------------------------------------------------------------

-- Re-derive email/university for existing rows from the verified auth email,
-- undoing anything a client may have written.
update public.profiles p
   set email = coalesce(u.email, ''),
       university = public.university_for_email(u.email)
  from auth.users u
 where u.id = p.id;

-- The sign-up trigger now ignores client-supplied university metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email, university)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Member'), 60),
    coalesce(new.email, ''),
    public.university_for_email(new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Self-heal for a signed-in user with no profile row (replaces the client
-- upsert, which needed INSERT/UPDATE on every column).
create function public.ensure_profile()
returns setof public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := public.require_user();
begin
  insert into public.profiles (id, display_name, email, university)
  select u.id,
         left(coalesce(nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''), 'Member'), 60),
         coalesce(u.email, ''),
         public.university_for_email(u.email)
    from auth.users u
   where u.id = v_uid
  on conflict (id) do nothing;
  return query select * from public.profiles where id = v_uid;
end;
$$;

drop policy "profiles: insert own" on public.profiles;
revoke insert, update on public.profiles from authenticated;
grant update (display_name, bio, profile_photo, major, interests)
  on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up restriction: .edu addresses (plus an allowlist for store reviewers)
-- ---------------------------------------------------------------------------

-- Exact addresses allowed without .edu, e.g. the App Store review demo
-- account. Add rows from the SQL editor; clients cannot read or write it.
create table public.signup_email_allowlist (
  email text primary key check (email = lower(email)),
  note  text
);
alter table public.signup_email_allowlist enable row level security;

create function public.is_allowed_signup_email(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select
    lower(coalesce(p_email, '')) ~ '^[^@\s]+@([a-z0-9-]+\.)+edu$'
    or exists (
      select 1 from public.signup_email_allowlist
       where email = lower(coalesce(p_email, ''))
    );
$$;

-- Supabase Auth "before user created" hook. Returning {} allows the sign-up;
-- returning {"error": {...}} rejects it with that message.
create function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql stable set search_path = ''
as $$
begin
  if public.is_allowed_signup_email(event -> 'user' ->> 'email') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'PODS is for college students. Please sign up with your .edu email.'
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Function permissions. Supabase grants EXECUTE on new public functions to
-- anon/authenticated by default, so revoke explicitly.
-- ---------------------------------------------------------------------------

revoke execute on function public.university_for_email(text) from public, anon, authenticated;
revoke execute on function public.is_allowed_signup_email(text) from public, anon, authenticated;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
revoke execute on function public.ensure_profile() from public, anon;
grant  execute on function public.ensure_profile() to authenticated;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
grant execute on function public.is_allowed_signup_email(text) to supabase_auth_admin;
