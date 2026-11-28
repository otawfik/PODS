// Report and block tests: blocks hide chat messages and university activities
// in both directions, stop join requests and pushes between the pair, and
// stay private; reports are write-only for clients, snapshot the content,
// and are rate-limited. Run with the other database tests: npm run test:db

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof createTestDb>>} */
let t;

const ids = {
  ana: '00000000-0000-0000-0000-0000000000b1', // BU, in the shared pod
  ben: '00000000-0000-0000-0000-0000000000b2', // BU, in the shared pod
  cy: '00000000-0000-0000-0000-0000000000b3', // BU, owns the shared pod
  dee: '00000000-0000-0000-0000-0000000000b4', // BU, in no pod
};

let sharedPod; // cy's pod; ana and ben are members
let benPod; // ben's own pod; ana is not a member
let anaPod; // ana's own pod; ben is not a member
let sharedActivity; // cy's activity in the shared pod; ana and ben joined
let benCampusActivity; // ben's university-wide activity in benPod
let anaCampusActivity; // ana's university-wide activity in anaPod

const rpc = (uid, sql, params) => t.asUser(uid, () => t.db.query(sql, params));
const rows = async (uid, sql, params) => (await rpc(uid, sql, params)).rows;

const createPod = (uid, name, visibility = 'public') =>
  t.asUser(
    uid,
    async () =>
      (
        await t.one(`select public.create_pod($1, '', 'Social', $2, null) as id`, [
          name,
          visibility,
        ])
      ).id,
  );

const createActivity = (uid, podId, title, { visibility = 'pod', autoApprove = false } = {}) =>
  t.asUser(
    uid,
    async () =>
      (
        await t.one(
          `select public.create_activity($1, 'Host', $2, 'Social', '{}',
             now() + interval '1 hour', now() + interval '3 hours', 8, $3, $4) as id`,
          [podId, title, visibility, autoApprove],
        )
      ).id,
  );

const say = (uid, room, id, text) =>
  rpc(
    uid,
    `insert into public.messages (${room}, sender_id, sender_name, message) values ($1, $2, 'x', $3)`,
    [id, uid, text],
  );

/** Message texts `uid` can read in a room, sorted. */
const heard = async (uid, room, id) =>
  (await rows(uid, `select message from public.messages where ${room} = $1`, [id]))
    .map((r) => r.message)
    .sort();

const block = (uid, other) => rpc(uid, `select public.block_user($1)`, [other]);
const unblock = (uid, other) => rpc(uid, `select public.unblock_user($1)`, [other]);
const report = async (uid, type, id, reason = 'spam', details = null) =>
  (
    await rows(uid, `select public.report_content($1, $2, $3, $4) as id`, [
      type,
      id,
      reason,
      details,
    ])
  )[0].id;

const canSee = async (uid, activityId) =>
  (await rows(uid, `select 1 from public.activities where id = $1`, [activityId])).length === 1;

const outbox = async () =>
  (
    await t.db.query(
      `select type, actor_id, recipient_ids from public.notification_outbox order by created_at, type`,
    )
  ).rows.map((r) => ({ ...r, recipient_ids: [...r.recipient_ids].sort() }));

before(async () => {
  t = await createTestDb();
  await t.signUp(ids.ana, 'ana@bu.edu', { display_name: 'Ana' });
  await t.signUp(ids.ben, 'ben@bu.edu', { display_name: 'Ben' });
  await t.signUp(ids.cy, 'cy@bu.edu', { display_name: 'Cy' });
  await t.signUp(ids.dee, 'dee@bu.edu', { display_name: 'Dee' });

  sharedPod = await createPod(ids.cy, 'Board games');
  for (const uid of [ids.ana, ids.ben]) await rpc(uid, `select public.join_pod($1)`, [sharedPod]);
  benPod = await createPod(ids.ben, 'Ben runs');
  anaPod = await createPod(ids.ana, 'Ana cooks');

  sharedActivity = await createActivity(ids.cy, sharedPod, 'Catan night', { autoApprove: true });
  for (const uid of [ids.ana, ids.ben]) {
    await rpc(uid, `select public.request_join_activity($1)`, [sharedActivity]);
  }
  benCampusActivity = await createActivity(ids.ben, benPod, 'River run', {
    visibility: 'university',
  });
  anaCampusActivity = await createActivity(ids.ana, anaPod, 'Dumplings', {
    visibility: 'university',
  });

  for (const [uid, name] of [
    [ids.ana, 'ana'],
    [ids.ben, 'ben'],
    [ids.cy, 'cy'],
  ]) {
    await say(uid, 'pod_id', sharedPod, `pod:${name}`);
    await say(uid, 'activity_id', sharedActivity, `act:${name}`);
  }
});

after(async () => {
  await t?.db.close();
});

afterEach(async () => {
  await t.db.exec(`delete from public.blocks; delete from public.notification_outbox;`);
});

// ---------------------------------------------------------------------------
// Blocks hide content
// ---------------------------------------------------------------------------

test('a block hides chat messages in both directions; unblock restores them', async () => {
  const everyone = (room) => [`${room}:ana`, `${room}:ben`, `${room}:cy`];
  assert.deepEqual(await heard(ids.ana, 'pod_id', sharedPod), everyone('pod'));

  await block(ids.ana, ids.ben);

  for (const [room, id, tag] of [
    ['pod_id', sharedPod, 'pod'],
    ['activity_id', sharedActivity, 'act'],
  ]) {
    assert.deepEqual(await heard(ids.ana, room, id), [`${tag}:ana`, `${tag}:cy`], 'blocker');
    assert.deepEqual(await heard(ids.ben, room, id), [`${tag}:ben`, `${tag}:cy`], 'blocked');
    assert.deepEqual(await heard(ids.cy, room, id), everyone(tag), 'bystander sees all');
  }

  // Both can still post in the shared rooms; the other side just never sees it.
  await say(ids.ben, 'pod_id', sharedPod, 'pod:ben-later');
  assert.ok(!(await heard(ids.ana, 'pod_id', sharedPod)).includes('pod:ben-later'));
  await t.db.query(`delete from public.messages where message = 'pod:ben-later'`);

  await unblock(ids.ana, ids.ben);
  assert.deepEqual(await heard(ids.ana, 'pod_id', sharedPod), everyone('pod'));
  assert.deepEqual(await heard(ids.ben, 'activity_id', sharedActivity), everyone('act'));
});

test('a block hides university activities in both directions; unblock restores them', async () => {
  assert.ok(await canSee(ids.ana, benCampusActivity));
  assert.ok(await canSee(ids.ben, anaCampusActivity));

  await block(ids.ana, ids.ben);
  assert.ok(!(await canSee(ids.ana, benCampusActivity)), "blocker loses the blocked user's");
  assert.ok(!(await canSee(ids.ben, anaCampusActivity)), "blocked user loses the blocker's");
  assert.ok(await canSee(ids.dee, benCampusActivity), 'others are unaffected');
  const feed = await rows(
    ids.ana,
    `select id from public.activities where visibility = 'university' and host_id <> $1`,
    [ids.ana],
  );
  assert.deepEqual(feed, []);

  await unblock(ids.ana, ids.ben);
  assert.ok(await canSee(ids.ana, benCampusActivity));
  assert.ok(await canSee(ids.ben, anaCampusActivity));
});

test('a shared pod keeps working under a block, but the pair cannot join each other', async () => {
  const inPod = await createActivity(ids.ben, sharedPod, 'Chess');
  const auto = await createActivity(ids.ben, benPod, 'Open run', {
    visibility: 'university',
    autoApprove: true,
  });
  await block(ids.ana, ids.ben);

  // Pod, member list, profiles and the pod's own activities stay readable.
  const pod = (
    await rows(ids.ana, `select members from public.pods where id = $1`, [sharedPod])
  )[0];
  assert.ok(pod.members.includes(ids.ben));
  const profile = await rows(ids.ana, `select display_name from public.profiles where id = $1`, [
    ids.ben,
  ]);
  assert.deepEqual(profile, [{ display_name: 'Ben' }]);
  assert.ok(await canSee(ids.ana, inPod));

  // ...but neither side can request a spot with the other, in either direction.
  await assert.rejects(
    rpc(ids.ana, `select public.request_join_activity($1)`, [inPod]),
    /Activity not found/,
  );
  await assert.rejects(
    rpc(ids.ana, `select public.request_join_activity($1)`, [auto]),
    /Activity not found/,
  );
  await assert.rejects(
    rpc(ids.ben, `select public.request_join_activity($1)`, [anaCampusActivity]),
    /Activity not found/,
  );
  const act = await t.one(
    `select pending_requests, participants from public.activities where id = $1`,
    [inPod],
  );
  assert.deepEqual(act, { pending_requests: [], participants: [ids.ben] });

  await t.db.query(`delete from public.activities where id = any ($1)`, [[inPod, auto]]);
});

test('someone already in an activity keeps seeing it (and can leave) after a block', async () => {
  const auto = await createActivity(ids.ben, benPod, 'Sunrise run', {
    visibility: 'university',
    autoApprove: true,
  });
  await rpc(ids.ana, `select public.request_join_activity($1)`, [auto]);
  await block(ids.ana, ids.ben);

  assert.ok(await canSee(ids.ana, auto), 'still visible to the participant');
  await rpc(ids.ana, `select public.leave_activity($1)`, [auto]);
  assert.ok(!(await canSee(ids.ana, auto)), 'hidden once they leave');
  await t.db.query(`delete from public.activities where id = $1`, [auto]);
});

// ---------------------------------------------------------------------------
// Block rules and privacy
// ---------------------------------------------------------------------------

test('self-block and unknown users are rejected; blocking twice is harmless', async () => {
  await assert.rejects(block(ids.ana, ids.ana), /cannot block yourself/);
  await assert.rejects(block(ids.ana, '00000000-0000-0000-0000-0000000000ff'), /User not found/);
  await assert.rejects(block(ids.ana, null), /User not found/);
  await assert.rejects(
    t.db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $1)`, [ids.ana]),
    /blocks_no_self/,
  );

  await block(ids.ana, ids.ben);
  await block(ids.ana, ids.ben);
  const n = await t.one(`select count(*)::int as c from public.blocks`);
  assert.equal(n.c, 1);
  await unblock(ids.ana, ids.dee); // not blocked: nothing happens
  assert.equal((await t.one(`select count(*)::int as c from public.blocks`)).c, 1);
});

test('users read only their own blocks and cannot write the table directly', async () => {
  await block(ids.ana, ids.ben);
  await block(ids.cy, ids.dee);

  assert.deepEqual(await rows(ids.ana, `select blocked_id from public.blocks`), [
    { blocked_id: ids.ben },
  ]);
  assert.deepEqual(await rows(ids.ben, `select * from public.blocks`), [], 'not told who blocked');
  assert.deepEqual(await rows(ids.dee, `select * from public.blocks`), []);

  await t.asUser(ids.ben, async () => {
    await assert.rejects(t.db.query(`delete from public.blocks`), /permission denied/);
    await assert.rejects(
      t.db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [
        ids.ben,
        ids.cy,
      ]),
      /permission denied/,
    );
    await assert.rejects(
      t.db.query(`update public.blocks set blocked_id = $1`, [ids.cy]),
      /permission denied/,
    );
    // Unblocking only ever removes the caller's own block.
    await t.db.query(`select public.unblock_user($1)`, [ids.ana]);
  });
  assert.equal((await t.one(`select count(*)::int as c from public.blocks`)).c, 2);

  await t.asRole('anon', null, async () => {
    await assert.rejects(t.db.query(`select * from public.blocks`), /permission denied/);
    await assert.rejects(
      t.db.query(`select public.block_user($1)`, [ids.ben]),
      /permission denied/,
    );
    await assert.rejects(
      t.db.query(`select public.unblock_user($1)`, [ids.ben]),
      /permission denied/,
    );
    await assert.rejects(
      t.db.query(`select public.is_blocked_with($1)`, [ids.ben]),
      /permission denied/,
    );
    await assert.rejects(
      t.db.query(`select public.report_content('user', $1, 'spam', null)`, [ids.ben]),
      /permission denied/,
    );
  });
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

test('a blocked pair produces no push outbox rows for each other', async () => {
  await block(ids.ana, ids.ben);

  // New activity in the shared pod: the other members, minus the blocked pair.
  const byBen = await createActivity(ids.ben, sharedPod, 'Go');
  const byAna = await createActivity(ids.ana, sharedPod, 'Poker');
  const byCy = await createActivity(ids.cy, sharedPod, 'Uno');
  assert.deepEqual(await outbox(), [
    { type: 'new_activity', actor_id: ids.ben, recipient_ids: [ids.cy] },
    { type: 'new_activity', actor_id: ids.ana, recipient_ids: [ids.cy] },
    { type: 'new_activity', actor_id: ids.cy, recipient_ids: [ids.ana, ids.ben].sort() },
  ]);

  // The filter itself, for every event type: only the bystander is left.
  await t.db.exec(`delete from public.notification_outbox`);
  for (const type of [
    'join_request',
    'participant_joined',
    'request_approved',
    'request_declined',
  ]) {
    await t.db.query(`select public._enqueue_notification($1, null, null, $2, $3, '{}')`, [
      type,
      ids.ben,
      [ids.ana, ids.cy],
    ]);
    await t.db.query(`select public._enqueue_notification($1, null, null, $2, $3, '{}')`, [
      type,
      ids.ana,
      [ids.ben],
    ]);
  }
  const left = await outbox();
  assert.equal(left.length, 4);
  assert.ok(left.every((r) => r.actor_id === ids.ben && r.recipient_ids.join() === ids.cy));

  await t.db.query(`delete from public.activities where id = any ($1)`, [[byBen, byAna, byCy]]);
});

test('blocking withdraws pending requests between the pair without a push', async () => {
  const byBen = await createActivity(ids.ben, sharedPod, 'Darts');
  const byAna = await createActivity(ids.ana, sharedPod, 'Pool');
  await rpc(ids.ana, `select public.request_join_activity($1)`, [byBen]);
  await rpc(ids.ben, `select public.request_join_activity($1)`, [byAna]);
  await rpc(ids.cy, `select public.request_join_activity($1)`, [byAna]);
  await t.db.exec(`delete from public.notification_outbox`);

  await block(ids.ana, ids.ben);

  const pending = async (id) =>
    (await t.one(`select pending_requests from public.activities where id = $1`, [id]))
      .pending_requests;
  assert.deepEqual(await pending(byBen), [], "blocker's request withdrawn");
  assert.deepEqual(await pending(byAna), [ids.cy], "blocked user's request removed, others kept");
  assert.deepEqual(await outbox(), [], 'no "declined" push to either side');

  await t.db.query(`delete from public.activities where id = any ($1)`, [[byBen, byAna]]);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

test('nobody on the client can read or write reports directly', async () => {
  await report(ids.ana, 'user', ids.ben, 'harassment', 'rude in chat');
  for (const [role, uid] of [
    ['authenticated', ids.ana],
    ['authenticated', ids.ben],
    ['anon', null],
  ]) {
    await t.asRole(role, uid, async () => {
      await assert.rejects(t.db.query(`select * from public.reports`), /permission denied/);
      await assert.rejects(
        t.db.query(
          `insert into public.reports (reporter_id, target_type, target_id, reason)
           values ($1, 'user', $1, 'spam')`,
          [ids.ana],
        ),
        /permission denied/,
      );
      await assert.rejects(
        t.db.query(`update public.reports set status = 'dismissed'`),
        /permission denied/,
      );
      await assert.rejects(t.db.query(`delete from public.reports`), /permission denied/);
    });
  }
  // Moderators (service role / dashboard) can.
  const seen = await t.asService(() =>
    t.db.query(`select reason, details, status, reported_user_id from public.reports`),
  );
  assert.deepEqual(seen.rows, [
    { reason: 'harassment', details: 'rude in chat', status: 'open', reported_user_id: ids.ben },
  ]);
  await t.db.exec(`delete from public.reports`);
});

test('a message report snapshots the text and sender and outlives the chat', async () => {
  await say(ids.ben, 'activity_id', sharedActivity, 'act:nasty');
  const msg = await t.one(`select id from public.messages where message = 'act:nasty'`);

  // Reportable even after blocking the sender (the message is hidden by then).
  await block(ids.ana, ids.ben);
  const id = await report(ids.ana, 'message', msg.id, 'hate', '  slur  ');
  await t.db.query(`delete from public.messages where id = $1`, [msg.id]); // as expiry does

  const row = await t.one(`select * from public.reports where id = $1`, [id]);
  assert.equal(row.reporter_id, ids.ana);
  assert.equal(row.target_type, 'message');
  assert.equal(row.target_id, msg.id);
  assert.equal(row.reported_user_id, ids.ben);
  assert.equal(row.details, 'slur');
  assert.equal(row.status, 'open');
  assert.equal(row.snapshot.message, 'act:nasty');
  assert.equal(row.snapshot.activityId, sharedActivity);
  assert.equal(row.snapshot.podId, null);
  assert.ok(row.snapshot.sentAt);
  await t.db.exec(`delete from public.reports`);
});

test('pods, activities and users can be reported; a repeat returns the open report', async () => {
  const podReport = await report(ids.ana, 'pod', benPod, 'spam');
  const actReport = await report(ids.ana, 'activity', benCampusActivity, 'other', 'fake event');
  const userReport = await report(ids.ana, 'user', ids.ben, 'impersonation');
  assert.equal(await report(ids.ana, 'pod', benPod, 'hate'), podReport, 'same open report');

  const { rows: all } = await t.db.query(
    `select id, target_type, reported_user_id, snapshot from public.reports order by created_at`,
  );
  assert.deepEqual(all, [
    {
      id: podReport,
      target_type: 'pod',
      reported_user_id: ids.ben,
      snapshot: { name: 'Ben runs', description: '' },
    },
    {
      id: actReport,
      target_type: 'activity',
      reported_user_id: ids.ben,
      snapshot: { title: 'River run', hostName: 'Host', podId: benPod },
    },
    {
      id: userReport,
      target_type: 'user',
      reported_user_id: ids.ben,
      snapshot: { displayName: 'Ben', bio: null },
    },
  ]);

  // Once a moderator closes it, the same thing can be reported again.
  await t.db.query(`update public.reports set status = 'resolved' where id = $1`, [podReport]);
  assert.notEqual(await report(ids.ana, 'pod', benPod, 'spam'), podReport);
  await t.db.exec(`delete from public.reports`);
});

test('reports are validated and limited to what the reporter can see', async () => {
  const secretPod = await createPod(ids.ben, 'Secret', 'private');
  const secretActivity = await createActivity(ids.ben, secretPod, 'Hidden');
  await say(ids.ben, 'pod_id', secretPod, 'pod:secret');
  const secretMsg = await t.one(`select id from public.messages where message = 'pod:secret'`);
  const ownMsg = await t.one(`select id from public.messages where message = 'pod:ana'`);
  const gone = /no longer available/;

  await assert.rejects(report(ids.ana, 'pod', secretPod), gone);
  await assert.rejects(report(ids.ana, 'activity', secretActivity), gone);
  await assert.rejects(report(ids.ana, 'message', secretMsg.id), gone);
  await assert.rejects(report(ids.ana, 'user', '00000000-0000-0000-0000-0000000000ff'), gone);
  await assert.rejects(report(ids.ana, 'user', ids.ana), /cannot report yourself/);
  await assert.rejects(report(ids.ana, 'message', ownMsg.id), /cannot report yourself/);
  await assert.rejects(report(ids.ana, 'comment', ids.ben), /Unknown report type/);
  await assert.rejects(report(ids.ana, 'user', ids.ben, 'boring'), /Choose a reason/);
  await assert.rejects(report(ids.ana, 'user', ids.ben, null), /Choose a reason/);
  await assert.rejects(
    report(ids.ana, 'user', ids.ben, 'spam', 'x'.repeat(1001)),
    /1000 characters/,
  );
  assert.equal((await t.one(`select count(*)::int as c from public.reports`)).c, 0);

  await t.db.query(`delete from public.pods where id = $1`, [secretPod]);
});

test('reports are rate-limited to 20 per user per day', async () => {
  // 19 recent reports and one old one: the old one does not count.
  await t.db.query(
    `insert into public.reports (reporter_id, target_type, target_id, reason, created_at)
     select $1, 'user', gen_random_uuid(), 'spam',
            case when n = 20 then now() - interval '25 hours' else now() end
       from generate_series(1, 20) as n`,
    [ids.ana],
  );
  await report(ids.ana, 'user', ids.ben); // the 20th within 24 h
  await assert.rejects(report(ids.ana, 'user', ids.cy), /daily report limit/);
  // Re-sending an open report is not a new report; other users are unaffected.
  await report(ids.ana, 'user', ids.ben);
  await report(ids.cy, 'user', ids.ben);
  const counts = await t.db.query(
    `select reporter_id, count(*)::int as c from public.reports group by 1 order by 2`,
  );
  assert.deepEqual(counts.rows, [
    { reporter_id: ids.cy, c: 1 },
    { reporter_id: ids.ana, c: 21 },
  ]);
  await t.db.exec(`delete from public.reports`);
});
