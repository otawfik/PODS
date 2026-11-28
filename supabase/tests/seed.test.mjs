// The demo data in supabase/seed.sql: it must apply on top of the migrations,
// produce every state the UI needs, keep counters consistent, be safe to
// re-run, and leave other people's data alone.
//
// Run: npm run test:db

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from './helpers.mjs';

const seedSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'seed.sql'),
  'utf8',
);

const SEED = `like '5eed0000-%'`;
const realUser = '00000000-0000-0000-0000-0000000000f1'; // a BU student who signed up normally

let db, signUp, asUser, one;
let realPodId;

before(async () => {
  ({ db, signUp, asUser, one } = await createTestDb());
  await signUp(realUser, 'riley@bu.edu', { display_name: 'Riley' });
  realPodId = await asUser(
    realUser,
    async () =>
      (await one(`select public.create_pod('Real pod', '', 'Other', 'public', null) as id`)).id,
  );
  await db.exec(seedSql);
});

after(async () => {
  await db?.close();
});

const count = async (sql, params) => (await one(`select count(*)::int as c from ${sql}`, params)).c;

const snapshot = async () => ({
  students: await count(`public.profiles where id::text ${SEED}`),
  pods: await count(`public.pods where created_by::text ${SEED}`),
  activities: await count(`public.activities where host_id::text ${SEED}`),
  messages: await count(`public.messages where sender_id::text ${SEED}`),
});

test('seed creates the students, pods, activities and chat', async () => {
  assert.deepEqual(await snapshot(), { students: 20, pods: 8, activities: 13, messages: 11 });

  const byUniversity = await db.query(
    `select university, count(*)::int as c from public.profiles
      where id::text ${SEED} group by university order by c desc, university`,
  );
  assert.deepEqual(byUniversity.rows, [
    { university: 'Boston University', c: 16 },
    { university: 'Harvard University', c: 2 },
    { university: 'MIT', c: 1 },
    { university: 'Northeastern University', c: 1 },
  ]);

  const maya = await one(
    `select display_name, major, interests, posts_count from public.profiles
      where email = 'seed+maya@bu.edu'`,
  );
  assert.equal(maya.display_name, 'Maya Chen');
  assert.equal(maya.major, 'Computer Science');
  assert.ok(maya.interests.includes('Climbing'));
  assert.equal(maya.posts_count, 2);

  const film = await one(
    `select visibility, member_count from public.pods where invite_code = 'SEEDFM'`,
  );
  assert.deepEqual(film, { visibility: 'private', member_count: 3 });
});

test('seed covers every activity state the screens show', async () => {
  const has = (where) => count(`public.activities where host_id::text ${SEED} and ${where}`);
  const active = `status = 'active' and expires_at > now()`;

  assert.equal(await has(`status = 'expired'`), 2, 'expired');
  assert.equal(await has(`status = 'active' and expires_at <= now()`), 0, 'nothing left overdue');
  assert.ok((await has(`${active} and current_participants < max_participants`)) >= 1, 'open');
  assert.ok((await has(`${active} and current_participants >= max_participants`)) >= 1, 'full');
  assert.ok(
    (await has(`${active} and cardinality(pending_requests) > 0`)) >= 1,
    'pending requests',
  );
  assert.ok((await has(`${active} and current_participants = 1`)) >= 1, 'only the host so far');
  assert.ok((await has(`${active} and start_time < now()`)) >= 1, 'already started');
  assert.ok((await has(`${active} and auto_approve`)) >= 1, 'auto-approve');
  assert.ok((await has(`${active} and not auto_approve`)) >= 1, 'host approves');
  assert.ok((await has(`${active} and visibility = 'pod'`)) >= 1, 'pod-only');
  assert.ok((await has(`${active} and visibility = 'university'`)) >= 1, 'university-wide');
  // Activity chat exists only on live activities (expiry clears it).
  assert.ok((await count(`public.messages where activity_id is not null`)) >= 1);
  assert.ok((await count(`public.messages where pod_id is not null`)) >= 1);
  assert.equal(
    await count(
      `public.messages m join public.activities a on a.id = m.activity_id where a.status = 'expired'`,
    ),
    0,
  );
});

test('seed data is internally consistent', async () => {
  const bad = async (what, sql) => assert.equal(await count(sql), 0, what);

  await bad(
    'member_count matches members',
    `public.pods where member_count <> cardinality(members)`,
  );
  await bad('every admin is a member', `public.pods where not (admins <@ members)`);
  await bad('every pod has an admin', `public.pods where cardinality(admins) = 0`);
  await bad(
    'participant count matches participants',
    `public.activities where current_participants <> cardinality(participants)`,
  );
  await bad(
    'no activity is over capacity',
    `public.activities where current_participants > max_participants`,
  );
  await bad(
    'the host is a participant',
    `public.activities where not (host_id = any (participants))`,
  );
  await bad(
    'nobody is both in and waiting',
    `public.activities where participants && pending_requests`,
  );
  await bad('starts before it expires', `public.activities where start_time >= expires_at`);
  await bad(
    'pods_joined matches pod membership',
    `public.profiles pr where pr.pods_joined is distinct from array(
       select p.id from public.pods p where pr.id = any (p.members)
        order by array_position(pr.pods_joined, p.id))`,
  );
  await bad(
    'activity chat is written by participants',
    `public.messages m join public.activities a on a.id = m.activity_id
      where not (m.sender_id = any (a.participants))`,
  );
  await bad(
    'pod chat is written by members',
    `public.messages m join public.pods p on p.id = m.pod_id where not (m.sender_id = any (p.members))`,
  );
  await bad(
    'participants could see the activity',
    `public.activities a join public.pods p on p.id = a.pod_id
      where a.visibility = 'pod' and not (a.participants <@ p.members)`,
  );
});

test('a newly signed-up BU student sees the right slice of the seed', async () => {
  const seen = await asUser(realUser, async () => ({
    pods: (await db.query(`select name from public.pods where created_by::text ${SEED}`)).rows.map(
      (r) => r.name,
    ),
    activities: (
      await db.query(
        `select title, university, visibility from public.activities where host_id::text ${SEED}`,
      )
    ).rows,
    messages: await count(`public.messages`),
  }));

  assert.equal(seen.pods.length, 7, 'the seven public pods');
  assert.ok(!seen.pods.includes('Thursday Screenings'), 'not the private one');
  assert.ok(seen.activities.length >= 4);
  for (const a of seen.activities) {
    assert.equal(a.visibility, 'university', `${a.title} is pod-only`);
    assert.equal(a.university, 'Boston University', `${a.title} is another campus`);
  }
  assert.equal(seen.messages, 0, 'no chat before joining anything');

  // They can take the last spot in the campus-wide game, through the normal RPC.
  const game = await one(`select id from public.activities where title like '3v3%'`);
  await asUser(realUser, () => db.query(`select public.request_join_activity($1)`, [game.id]));
  const after = await one(
    `select current_participants, max_participants, $2 = any (participants) as joined
       from public.activities where id = $1`,
    [game.id, realUser],
  );
  assert.deepEqual(after, { current_participants: 6, max_participants: 6, joined: true });
});

test('re-running the seed replaces it and leaves other data alone', async () => {
  // The real student joins a seed pod and posts in their own pod first.
  const cs = await one(`select id from public.pods where name = 'CS 411 Study Group'`);
  await asUser(realUser, () => db.query(`select public.join_pod($1)`, [cs.id]));
  await asUser(realUser, () =>
    db.query(`insert into public.messages (pod_id, sender_id, message) values ($1, $2, 'hello')`, [
      realPodId,
      realUser,
    ]),
  );

  await db.exec(seedSql);

  assert.deepEqual(await snapshot(), { students: 20, pods: 8, activities: 13, messages: 11 });
  assert.equal(await count(`public.pods`), 9, 'eight seed pods plus the real one');
  assert.equal(await count(`auth.users`), 21);

  const riley = await one(`select pods_joined from public.profiles where id = $1`, [realUser]);
  assert.deepEqual(riley.pods_joined, [realPodId], 'the stale seed pod id is dropped');
  assert.equal(await count(`public.messages where pod_id = $1`, [realPodId]), 1);
  assert.equal(
    await one(`select current_setting('request.jwt.claim.sub', true) as sub`).then(
      (r) => r.sub ?? '',
    ),
    '',
    'the seed does not leave a signed-in user behind',
  );
});
