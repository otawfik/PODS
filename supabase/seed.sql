-- =============================================================================
-- PODS — demo data for development and screenshots
--
-- 20 students (16 at Boston University, 2 Harvard, 1 MIT, 1 Northeastern),
-- 8 pods (one private, invite code SEEDFM) and activities in every state:
-- open, with pending requests, full, auto-approve, already started,
-- pod-only, university-wide and expired, plus some pod and activity chat.
--
-- Run it in the Supabase SQL Editor of a DEVELOPMENT project (or let
-- `supabase db reset` pick it up). Do not run it on the project real students
-- use: the pods and people below would show up in their feeds.
--
-- Safe to re-run: it first removes what an earlier run created (seed users
-- have ids starting 5eed0000 and seed+...@ emails; seed pods are the ones
-- they created), then builds everything again. Times are relative to now(),
-- so re-run it when the "active" activities have expired. Nothing else in the
-- database is touched. To remove the demo data, run only the "Remove" block.
--
-- Pods and activities are created through the app's own RPCs (create_pod,
-- join_pod, create_activity, request_join_activity, approve_join_request),
-- acting as each seed user, so counters and membership arrays are exactly
-- what the app would have produced.
--
-- Seed users have no password and cannot sign in. Sign up in the app with
-- your own @bu.edu address to see the Boston University data.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Remove what an earlier run created
-- ---------------------------------------------------------------------------

update public.profiles pr
   set pods_joined = array(
         select p from unnest(pr.pods_joined) as p
          where p not in (select id from public.pods
                           where created_by::text like '5eed0000-%'))
 where pr.id::text not like '5eed0000-%'
   and pr.pods_joined && array(select id from public.pods
                                where created_by::text like '5eed0000-%');

delete from public.pods where created_by::text like '5eed0000-%';
delete from auth.users where id::text like '5eed0000-%';

-- ---------------------------------------------------------------------------
-- Helpers (temporary: gone when the session ends)
-- ---------------------------------------------------------------------------

-- Seed user number n → its fixed id.
create or replace function pg_temp.seed_uid(n integer) returns uuid
language sql immutable as $$
  select ('5eed0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- Make auth.uid() return seed user n for the RPC calls that follow.
create or replace function pg_temp.seed_act_as(n integer) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', pg_temp.seed_uid(n)::text, true)
$$;

create or replace function pg_temp.seed_join(p_pod uuid, p_people integer[], p_code text default null)
returns void language plpgsql as $$
declare n integer;
begin
  foreach n in array p_people loop
    perform pg_temp.seed_act_as(n);
    perform public.join_pod(p_pod, p_code);
  end loop;
end;
$$;

-- Offsets are relative to now(); negative means in the past.
create or replace function pg_temp.seed_activity(
  p_host integer, p_pod uuid, p_title text, p_category text, p_tags text[],
  p_starts interval, p_expires interval, p_max integer, p_visibility text, p_auto boolean
) returns uuid language plpgsql as $$
begin
  perform pg_temp.seed_act_as(p_host);
  return public.create_activity(
    p_pod,
    (select display_name from public.profiles where id = pg_temp.seed_uid(p_host)),
    p_title, p_category, p_tags, now() + p_starts, now() + p_expires,
    p_max, p_visibility, p_auto);
end;
$$;

-- Each person asks for a spot (joins straight away on auto-approve activities).
create or replace function pg_temp.seed_request(p_activity uuid, p_people integer[])
returns void language plpgsql as $$
declare n integer;
begin
  foreach n in array p_people loop
    perform pg_temp.seed_act_as(n);
    perform public.request_join_activity(p_activity);
  end loop;
end;
$$;

create or replace function pg_temp.seed_approve(p_activity uuid, p_host integer, p_people integer[])
returns void language plpgsql as $$
declare n integer;
begin
  perform pg_temp.seed_act_as(p_host);
  foreach n in array p_people loop
    perform public.approve_join_request(p_activity, pg_temp.seed_uid(n));
  end loop;
end;
$$;

create or replace function pg_temp.seed_say(
  p_activity uuid, p_pod uuid, p_sender integer, p_ago interval, p_message text
) returns void language sql as $$
  insert into public.messages (activity_id, pod_id, sender_id, sender_name, message, created_at)
  select p_activity, p_pod, id, display_name, p_message, now() - p_ago
    from public.profiles where id = pg_temp.seed_uid(p_sender)
$$;

-- ---------------------------------------------------------------------------
-- Students. The sign-up trigger creates each profile and derives the
-- university from the email domain; bio, major and interests are added after.
-- ---------------------------------------------------------------------------

create temporary table seed_people (
  n integer primary key, name text, email text, major text, bio text, interests text[]
) on commit drop;

insert into seed_people values
  (1,  'Maya Chen',       'seed+maya@bu.edu',      'Computer Science',       'Junior. Usually at Mugar or the climbing wall.',      '{Coding,Hackathons,Climbing,Coffee}'),
  (2,  'Jordan Alvarez',  'seed+jordan@bu.edu',    'Computer Engineering',   'TA for CS 111. Ask me about pointers.',               '{Coding,Study groups,Basketball}'),
  (3,  'Priya Natarajan', 'seed+priya@bu.edu',     'Data Science',           'Whiteboard enthusiast.',                              '{Coding,Study groups,Cooking}'),
  (4,  'Ethan Brooks',    'seed+ethan@bu.edu',     'Computer Science',       '',                                                    '{Coding,Video games,Startups}'),
  (5,  'Aaliyah Johnson', 'seed+aaliyah@bu.edu',   'Business Administration','Runs pickup at FitRec most weeknights.',              '{Basketball,Gym,Running}'),
  (6,  'Lucas Ferreira',  'seed+lucas@bu.edu',     'Mechanical Engineering', 'Left-handed point guard.',                            '{Basketball,Soccer,Coding}'),
  (7,  'Sofia Rossi',     'seed+sofia@bu.edu',     'Economics',              '',                                                    '{Basketball,Coffee,Study groups}'),
  (8,  'Daniel Kim',      'seed+daniel@bu.edu',    'Hospitality',            'Eating my way down Comm Ave.',                        '{Cooking,Coffee,Photography}'),
  (9,  'Hannah Schwartz', 'seed+hannah@bu.edu',    'Journalism',             'Will travel for dumplings.',                          '{Cooking,Basketball,Film}'),
  (10, 'Omar Haddad',     'seed+omar@bu.edu',      'Computer Science',       'Smash, Mario Kart, anything with a bracket.',         '{Video games,Board games,Cooking}'),
  (11, 'Grace Liu',       'seed+grace@bu.edu',     'Mathematics',            '',                                                    '{Video games,Board games,Music}'),
  (12, 'Noah Williams',   'seed+noah@bu.edu',      'Earth Science',          'Climbing, hiking, and games when it rains.',          '{Climbing,Hiking,Video games}'),
  (13, 'Isabella Moreno', 'seed+isabella@bu.edu',  'Psychology',             'New to climbing, be nice.',                           '{Climbing,Yoga,Video games}'),
  (14, 'Tariq Rahman',    'seed+tariq@bu.edu',     'Biology',                'Pre-med. Orgo survivor.',                             '{Pre-med,Study groups,Climbing}'),
  (15, 'Chloe Martin',    'seed+chloe@bu.edu',     'Film & Television',      'Programming the Thursday screenings.',                '{Film,Photography,Pre-med}'),
  (16, 'Ben Okafor',      'seed+ben@bu.edu',       'Neuroscience',           '',                                                    '{Pre-med,Film,Music}'),
  (17, 'Eleanor Whitby',  'seed+eleanor@harvard.edu', 'Philosophy',          'Blitz before class.',                                 '{Board games,Coffee}'),
  (18, 'Raj Malhotra',    'seed+raj@harvard.edu',  'Applied Mathematics',    '',                                                    '{Board games,Coding}'),
  (19, 'Zoe Carter',      'seed+zoe@mit.edu',      'Aerospace Engineering',  'Crosses the river for good pickup games.',            '{Basketball,Running}'),
  (20, 'Marcus Reid',     'seed+marcus@northeastern.edu', 'Physical Therapy', '',                                                   '{Basketball,Gym}');

insert into auth.users (id, email, raw_user_meta_data)
select pg_temp.seed_uid(n), email, jsonb_build_object('display_name', name)
  from seed_people order by n;

update public.profiles pr
   set major = sp.major, bio = nullif(sp.bio, ''), interests = sp.interests
  from seed_people sp
 where pr.id = pg_temp.seed_uid(sp.n);

-- ---------------------------------------------------------------------------
-- Pods, members, activities and chat
-- ---------------------------------------------------------------------------

do $$
declare
  cs uuid; hoops uuid; food uuid; gaming uuid; climbing uuid; premed uuid; film uuid; chess uuid;
  a uuid;
begin
  -- Pods (the creator is the first member and admin).
  perform pg_temp.seed_act_as(1);
  cs := public.create_pod('CS 411 Study Group', 'Problem sets, exam review and project help for Software Engineering.', 'Study', 'public', '#6C63FF');
  perform pg_temp.seed_act_as(5);
  hoops := public.create_pod('Pickup Basketball @ FitRec', 'Open runs most evenings. All levels, call your own fouls.', 'Sports', 'public', '#F97316');
  perform pg_temp.seed_act_as(8);
  food := public.create_pod('Comm Ave Food Crawl', 'Cheap eats within walking distance of campus, one spot at a time.', 'Food', 'public', '#EF4444');
  perform pg_temp.seed_act_as(10);
  gaming := public.create_pod('Late Night Gaming', 'Smash, Mario Kart and board games in the dorm lounges.', 'Gaming', 'public', '#8B5CF6');
  perform pg_temp.seed_act_as(12);
  climbing := public.create_pod('Climbing Crew', 'FitRec wall sessions and the occasional trip to a real gym.', 'Sports', 'public', '#10B981');
  perform pg_temp.seed_act_as(14);
  premed := public.create_pod('Pre-med Study Hall', 'Quiet group study for orgo, bio and MCAT prep.', 'Study', 'public', '#0EA5E9');
  perform pg_temp.seed_act_as(15);
  film := public.create_pod('Thursday Screenings', 'Invite-only film nights. Ask a member for the code.', 'Social', 'private', '#EC4899');
  perform pg_temp.seed_act_as(17);
  chess := public.create_pod('Harvard Square Chess', 'Blitz and casual games around the Square.', 'Other', 'public', '#64748B');

  update public.pods set invite_code = 'SEEDFM' where id = film;

  -- Members.
  perform pg_temp.seed_join(cs,       array[2, 3, 4, 5, 6, 7]);
  perform pg_temp.seed_join(hoops,    array[6, 7, 8, 9, 19, 20]);
  perform pg_temp.seed_join(food,     array[9, 10, 1, 2]);
  perform pg_temp.seed_join(gaming,   array[11, 12, 13]);
  perform pg_temp.seed_join(climbing, array[1, 13, 14]);
  perform pg_temp.seed_join(premed,   array[15, 16]);
  perform pg_temp.seed_join(film,     array[16, 1], 'seedfm');
  perform pg_temp.seed_join(chess,    array[18]);

  -- A second admin on the study pod.
  perform pg_temp.seed_act_as(1);
  perform public.grant_pod_admin(cs, pg_temp.seed_uid(2));

  -- CS 411: open with two approved and two waiting.
  a := pg_temp.seed_activity(1, cs, 'PS4 work session at Mugar', 'Study', '{Study Group,Evening}',
                             '2 hours', '5 hours', 6, 'pod', false);
  perform pg_temp.seed_request(a, array[2, 3, 4, 5]);
  perform pg_temp.seed_approve(a, 1, array[2, 3]);
  perform pg_temp.seed_say(a, null, 1, '40 minutes', 'Third floor, the big table by the windows.');
  perform pg_temp.seed_say(a, null, 2, '35 minutes', 'Bringing the whiteboard markers.');
  perform pg_temp.seed_say(a, null, 3, '12 minutes', 'Stuck on 2b already, see you there.');

  -- CS 411: campus-wide, auto-approve, tomorrow.
  a := pg_temp.seed_activity(2, cs, 'Midterm review (Zoom)', 'Study', '{Study Group,Free}',
                             '1 day', '1 day 3 hours', 12, 'university', true);
  perform pg_temp.seed_request(a, array[1, 3, 6, 7]);

  -- CS 411: already started and full, with one request left waiting.
  a := pg_temp.seed_activity(3, cs, 'Whiteboard interview practice', 'Study', '{Advanced}',
                             '-30 minutes', '90 minutes', 2, 'pod', false);
  perform pg_temp.seed_request(a, array[4, 5]);
  perform pg_temp.seed_approve(a, 3, array[4]);

  -- CS 411: yesterday's session (expired below). People can only join an
  -- activity that hasn't ended, so it is filled first and then moved to the past.
  a := pg_temp.seed_activity(1, cs, 'PS3 work session', 'Study', '{Study Group}',
                             '1 hour', '4 hours', 5, 'pod', true);
  perform pg_temp.seed_request(a, array[2, 4]);
  update public.activities
     set start_time = now() - interval '1 day', expires_at = now() - interval '21 hours'
   where id = a;

  -- Basketball: campus-wide, one spot left.
  a := pg_temp.seed_activity(5, hoops, '3v3 at FitRec, court 2', 'Sports', '{Casual,Indoor,Evening}',
                             '3 hours', '5 hours', 6, 'university', true);
  perform pg_temp.seed_request(a, array[6, 7, 8, 9]);
  perform pg_temp.seed_say(a, null, 5, '25 minutes', 'I have the ball. Bring a dark and a light shirt.');
  perform pg_temp.seed_say(a, null, 8, '9 minutes', 'Running 5 late from lab.');

  -- Basketball: nobody in yet, one request.
  a := pg_temp.seed_activity(6, hoops, 'Morning shootaround', 'Sports', '{Morning,Beginner}',
                             '18 hours', '20 hours', 4, 'pod', false);
  perform pg_temp.seed_request(a, array[9]);

  -- Food: campus-wide, host approves.
  a := pg_temp.seed_activity(8, food, 'Dumplings in Allston', 'Food', '{Casual,Paid}',
                             '4 hours', '6 hours', 5, 'university', false);
  perform pg_temp.seed_request(a, array[9, 10, 1]);
  perform pg_temp.seed_approve(a, 8, array[9, 10]);

  -- Food: yesterday's lunch (expired below).
  a := pg_temp.seed_activity(9, food, 'Lunch at Warren dining hall', 'Food', '{Casual}',
                             '1 hour', '3 hours', 4, 'pod', true);
  perform pg_temp.seed_request(a, array[8]);
  update public.activities
     set start_time = now() - interval '26 hours', expires_at = now() - interval '24 hours'
   where id = a;

  -- Gaming: tonight, auto-approve.
  a := pg_temp.seed_activity(10, gaming, 'Smash bracket night', 'Social', '{Competitive,Late Night,Free}',
                             '6 hours', '10 hours', 8, 'pod', true);
  perform pg_temp.seed_request(a, array[11, 12, 13]);

  -- Climbing: campus-wide, host approves, two waiting.
  a := pg_temp.seed_activity(12, climbing, 'Top-rope session at the FitRec wall', 'Gym', '{Beginner,Indoor}',
                             '1 day 2 hours', '1 day 4 hours', 4, 'university', false);
  perform pg_temp.seed_request(a, array[1, 13, 14]);
  perform pg_temp.seed_approve(a, 12, array[1]);

  -- Pre-med: this evening.
  a := pg_temp.seed_activity(14, premed, 'Orgo problem set 7', 'Study', '{Study Group,Evening}',
                             '2 hours 30 minutes', '5 hours', 5, 'pod', true);
  perform pg_temp.seed_request(a, array[15, 16]);

  -- Private pod: only its members can see this one.
  a := pg_temp.seed_activity(15, film, 'Screening: Spirited Away', 'Social', '{Evening,Free}',
                             '2 days', '2 days 3 hours', 10, 'pod', true);
  perform pg_temp.seed_request(a, array[16, 1]);

  -- Another university: invisible to BU students who are not in the pod.
  a := pg_temp.seed_activity(17, chess, 'Blitz at the Science Center', 'Other', '{Casual,Free}',
                             '3 hours', '5 hours', 6, 'university', true);
  perform pg_temp.seed_request(a, array[18]);

  -- Pod chat.
  perform pg_temp.seed_say(null, cs, 1, '2 days', 'Welcome! Post a session whenever you are working on something.');
  perform pg_temp.seed_say(null, cs, 4, '1 day 3 hours', 'Is the midterm cumulative?');
  perform pg_temp.seed_say(null, cs, 2, '1 day 2 hours', 'Everything through week 7. Review session is posted.');
  perform pg_temp.seed_say(null, hoops, 5, '5 hours', 'Court 2 is ours tonight.');
  perform pg_temp.seed_say(null, hoops, 19, '4 hours', 'Coming over from MIT, save me a spot.');
  perform pg_temp.seed_say(null, food, 8, '3 hours', 'Dumplings tonight. Cash only.');

  -- Same job the every-minute cron runs: flips the two past activities to expired.
  perform public.expire_due_activities();

  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;

commit;

-- What the seed created.
select
  (select count(*) from public.profiles where id::text like '5eed0000-%') as students,
  (select count(*) from public.pods where created_by::text like '5eed0000-%') as pods,
  (select count(*) from public.activities where host_id::text like '5eed0000-%' and status = 'active') as active_activities,
  (select count(*) from public.activities where host_id::text like '5eed0000-%' and status = 'expired') as expired_activities,
  (select count(*) from public.messages where sender_id::text like '5eed0000-%') as messages;
