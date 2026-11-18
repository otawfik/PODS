// Database tests: apply every migration to an in-process Postgres (PGlite,
// real Postgres compiled to WebAssembly — no Docker needed) and check the
// security rules and business logic.
//
// Run: npm run test:db
//
// Supabase-provided pieces (auth schema, roles, realtime publication) are
// stubbed minimally below. auth.uid() reads `request.jwt.claim.sub`, which
// asUser() sets, and asUser() switches to the `authenticated` role so
// grants and Row Level Security apply exactly as they do for the app.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  grant usage on schema public to anon, authenticated, service_role;

  -- Supabase grants EXECUTE on new public functions to these roles by
  -- default; mimic it so the tests prove the migrations' REVOKEs work.
  alter default privileges in schema public grant execute on functions to anon, authenticated;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated;

  create publication supabase_realtime;
`;

/** @type {PGlite} */
let db;

const ids = {
  alice: '00000000-0000-0000-0000-00000000000a', // BU
  bob: '00000000-0000-0000-0000-00000000000b', // Harvard
  carol: '00000000-0000-0000-0000-00000000000c', // BU
};

async function signUp(id, email, meta = {}) {
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [
    id,
    email,
    JSON.stringify(meta),
  ]);
}

/** Run fn as a signed-in app user (role authenticated, RLS on). */
async function asUser(uid, fn) {
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 3, 'expected the initial migration plus the new ones');
  for (const file of files) {
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  await signUp(ids.alice, 'alice@bu.edu', { display_name: 'Alice', university: 'Harvard University' });
  await signUp(ids.bob, 'bob@harvard.edu', { display_name: 'Bob' });
  await signUp(ids.carol, 'carol@cs.bu.edu', { display_name: 'Carol' });
});

after(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// Sign-up hook
// ---------------------------------------------------------------------------

test('sign-up hook allows .edu and rejects everything else', async () => {
  const hook = async (email) =>
    (await one(`select public.hook_before_user_created($1::jsonb) as r`, [
      JSON.stringify({ user: { email } }),
    ])).r;

  assert.deepEqual(await hook('student@bu.edu'), {});
  assert.deepEqual(await hook('Student@CS.BU.EDU'), {});
  for (const bad of ['me@gmail.com', 'me@bu.edu.evil.com', 'me@edu', 'not-an-email', '']) {
    const r = await hook(bad);
    assert.equal(r.error?.http_code, 403, `expected rejection for "${bad}"`);
  }
  await db.query(`insert into public.signup_email_allowlist (email) values ('reviewer@example.com')`);
  assert.deepEqual(await hook('Reviewer@Example.com'), {});
});

test('app users cannot call the hook or the university lookup', async () => {
  await asUser(ids.alice, async () => {
    await assert.rejects(
      db.query(`select public.hook_before_user_created('{}'::jsonb)`),
      /permission denied/,
    );
    await assert.rejects(db.query(`select public.university_for_email('x@bu.edu')`), /permission denied/);
  });
});

// ---------------------------------------------------------------------------
// Profiles: server-owned identity
// ---------------------------------------------------------------------------

test('university comes from the email, not client metadata', async () => {
  const alice = await one(`select university from public.profiles where id = $1`, [ids.alice]);
  assert.equal(alice.university, 'Boston University'); // metadata said Harvard
  const carol = await one(`select university from public.profiles where id = $1`, [ids.carol]);
  assert.equal(carol.university, 'Boston University'); // subdomain
});

test('users can edit bio/major/interests but not identity columns', async () => {
  await asUser(ids.alice, async () => {
    await db.query(
      `update public.profiles set bio = 'hi', major = 'CS', interests = '{climbing,chess}' where id = $1`,
      [ids.alice],
    );
    for (const col of [
      `university = 'Harvard University'`,
      `email = 'x@harvard.edu'`,
      `commendations = 999`,
      `pods_joined = '{}'`,
    ]) {
      await assert.rejects(
        db.query(`update public.profiles set ${col} where id = $1`, [ids.alice]),
        /permission denied/,
        col,
      );
    }
    await assert.rejects(
      db.query(`insert into public.profiles (id, email, university) values (gen_random_uuid(), 'a', 'b')`),
      /permission denied/,
    );
  });
  const row = await one(`select bio, major, interests, university from public.profiles where id = $1`, [ids.alice]);
  assert.deepEqual(row, {
    bio: 'hi',
    major: 'CS',
    interests: ['climbing', 'chess'],
    university: 'Boston University',
  });
});

test('ensure_profile recreates a missing profile row', async () => {
  const id = '00000000-0000-0000-0000-0000000000dd';
  await signUp(id, 'dan@mit.edu', { display_name: 'Dan' });
  await db.query(`delete from public.profiles where id = $1`, [id]);
  const row = await asUser(id, () => one(`select * from public.ensure_profile()`));
  assert.equal(row.university, 'MIT');
  assert.equal(row.display_name, 'Dan');
});

// ---------------------------------------------------------------------------
// Pods / activities RLS (the checks listed in the roadmap's Phase 2)
// ---------------------------------------------------------------------------

test('private pods and university activities stay private', async () => {
  const podId = await asUser(ids.alice, async () =>
    (await one(`select public.create_pod('Secret', 'shh', 'Study', 'private', null) as id`)).id,
  );
  const bobSees = await asUser(ids.bob, () =>
    db.query(`select id from public.pods where id = $1`, [podId]),
  );
  assert.equal(bobSees.rows.length, 0, "Bob must not read Alice's private pod");

  const actId = await asUser(ids.alice, async () =>
    (await one(
      `select public.create_activity($1, 'Alice', 'Library grind', 'Study', '{}',
         now() + interval '1 hour', now() + interval '3 hours', 5, 'university', false) as id`,
      [podId],
    )).id,
  );
  const carolSees = await asUser(ids.carol, () =>
    db.query(`select id from public.activities where id = $1`, [actId]),
  );
  assert.equal(carolSees.rows.length, 1, 'same-university student sees a university activity');
  const bobSeesAct = await asUser(ids.bob, () =>
    db.query(`select id from public.activities where id = $1`, [actId]),
  );
  assert.equal(bobSeesAct.rows.length, 0, 'other-university student does not');
});

test('only the host approves, and capacity is enforced', async () => {
  const podId = await asUser(ids.alice, async () =>
    (await one(`select public.create_pod('Hoops', '', 'Sports', 'public', null) as id`)).id,
  );
  const actId = await asUser(ids.alice, async () =>
    (await one(
      `select public.create_activity($1, 'Alice', '2v2', 'Sports', '{}',
         now() + interval '1 hour', now() + interval '2 hours', 2, 'university', false) as id`,
      [podId],
    )).id,
  );
  await asUser(ids.carol, () => db.query(`select public.request_join_activity($1)`, [actId]));
  await asUser(ids.carol, () =>
    assert.rejects(
      db.query(`select public.approve_join_request($1, $2)`, [actId, ids.carol]),
      /Only the host/,
    ),
  );
  await asUser(ids.alice, () =>
    db.query(`select public.approve_join_request($1, $2)`, [actId, ids.carol]),
  );
  // Host + Carol = 2 of 2. A third approval must fail.
  const extra = '00000000-0000-0000-0000-0000000000ee';
  await signUp(extra, 'erin@bu.edu');
  await asUser(extra, () => db.query(`select public.request_join_activity($1)`, [actId]));
  await asUser(ids.alice, () =>
    assert.rejects(
      db.query(`select public.approve_join_request($1, $2)`, [actId, extra]),
      /Activity is full/,
    ),
  );
});

// ---------------------------------------------------------------------------
// Expiry job
// ---------------------------------------------------------------------------

test('expire_due_activities expires past activities and clears their chat', async () => {
  const podId = await asUser(ids.alice, async () =>
    (await one(`select public.create_pod('Food', '', 'Food', 'public', null) as id`)).id,
  );
  const [pastId, futureId] = await asUser(ids.alice, async () => {
    const mk = async (expires) =>
      (await one(
        `select public.create_activity($1, 'Alice', 'Lunch', 'Food', '{}',
           now() - interval '3 hours', ${expires}, 4, 'pod', true) as id`,
        [podId],
      )).id;
    const past = await mk(`now() + interval '1 hour'`);
    const future = await mk(`now() + interval '1 hour'`);
    await db.query(
      `insert into public.messages (activity_id, sender_id, message) values ($1, $2, 'see you')`,
      [past, ids.alice],
    );
    return [past, future];
  });
  // Move one activity's deadline into the past (as the clock would).
  await db.query(`update public.activities set expires_at = now() - interval '1 minute' where id = $1`, [pastId]);

  await asUser(ids.alice, () =>
    assert.rejects(db.query(`select public.expire_due_activities()`), /permission denied/),
  );

  const { n } = await one(`select public.expire_due_activities() as n`);
  assert.ok(n >= 1);
  const statuses = await db.query(`select id, status from public.activities where id = any($1)`, [
    [pastId, futureId],
  ]);
  const byId = Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]));
  assert.equal(byId[pastId], 'expired');
  assert.equal(byId[futureId], 'active');
  const msgs = await one(`select count(*)::int as c from public.messages where activity_id = $1`, [pastId]);
  assert.equal(msgs.c, 0);
});
