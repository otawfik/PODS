// Business rules of the pod, activity and chat RPCs and policies that
// db.test.mjs does not already cover: invite codes, admins, auto-approve,
// leaving, declining, deleting, lazy expiry and who can read or send chat.
//
// Run: npm run test:db

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.mjs';

let db, signUp, asUser, one;

const ids = {
  alice: '00000000-0000-0000-0000-0000000000a1', // BU, creates the pods
  bob: '00000000-0000-0000-0000-0000000000b1', // BU
  carol: '00000000-0000-0000-0000-0000000000c1', // BU
  dave: '00000000-0000-0000-0000-0000000000d1', // Harvard
};

before(async () => {
  ({ db, signUp, asUser, one } = await createTestDb());
  await signUp(ids.alice, 'alice@bu.edu', { display_name: 'Alice' });
  await signUp(ids.bob, 'bob@bu.edu', { display_name: 'Bob' });
  await signUp(ids.carol, 'carol@bu.edu', { display_name: 'Carol' });
  await signUp(ids.dave, 'dave@harvard.edu', { display_name: 'Dave' });
});

after(async () => {
  await db?.close();
});

// --- small helpers -----------------------------------------------------------

const rpc = (uid, call, params) => asUser(uid, () => db.query(`select public.${call}`, params));
const rpcValue = async (uid, call, params) =>
  (await asUser(uid, () => one(`select public.${call} as v`, params))).v;

const createPod = (uid, name, visibility = 'public') =>
  rpcValue(uid, `create_pod($1, '', 'Other', $2, null)`, [name, visibility]);

const createActivity = (uid, podId, { max = 5, visibility = 'pod', auto = false } = {}) =>
  rpcValue(
    uid,
    `create_activity($1, 'Host', 'Thing', 'Other', '{}',
       now() + interval '1 hour', now() + interval '2 hours', $2, $3, $4)`,
    [podId, max, visibility, auto],
  );

/**
 * A direct table write the app user must not be able to make. Depending on the
 * table it is stopped by a missing grant (error), by Row Level Security on
 * insert (error) or by having no matching policy (touches no rows).
 */
const blocked = async (uid, sql, params) => {
  const outcome = await asUser(uid, async () => {
    try {
      return (await db.query(sql, params)).affectedRows ?? 0;
    } catch (err) {
      assert.match(err.message, /permission denied|row-level security/, sql);
      return 0;
    }
  });
  assert.equal(outcome, 0, `expected no rows changed by: ${sql}`);
};

const pod = (id) =>
  one(`select members, admins, member_count, invite_code from public.pods where id = $1`, [id]);
const activity = (id) =>
  one(
    `select participants, pending_requests, current_participants, status
       from public.activities where id = $1`,
    [id],
  );
const podsJoined = async (uid) =>
  (await one(`select pods_joined from public.profiles where id = $1`, [uid])).pods_joined;

// ---------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------

test('creating a pod makes the creator its only member and admin', async () => {
  const podId = await createPod(ids.alice, 'Founders');
  const p = await pod(podId);
  assert.deepEqual(p.members, [ids.alice]);
  assert.deepEqual(p.admins, [ids.alice]);
  assert.equal(p.member_count, 1);
  assert.match(p.invite_code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.ok((await podsJoined(ids.alice)).includes(podId));
});

test('joining and leaving keep members, counts and pods_joined in step', async () => {
  const podId = await createPod(ids.alice, 'Open');
  await rpc(ids.bob, `join_pod($1)`, [podId]);
  await rpc(ids.bob, `join_pod($1)`, [podId]); // joining twice is a no-op
  let p = await pod(podId);
  assert.deepEqual(p.members, [ids.alice, ids.bob]);
  assert.equal(p.member_count, 2);
  assert.ok((await podsJoined(ids.bob)).includes(podId));

  await rpc(ids.bob, `leave_pod($1)`, [podId]);
  await rpc(ids.bob, `leave_pod($1)`, [podId]); // leaving twice is a no-op
  p = await pod(podId);
  assert.deepEqual(p.members, [ids.alice]);
  assert.equal(p.member_count, 1);
  assert.ok(!(await podsJoined(ids.bob)).includes(podId));
});

test('a private pod needs its invite code', async () => {
  const podId = await createPod(ids.alice, 'Hidden', 'private');
  const { invite_code: code } = await pod(podId);

  await assert.rejects(rpc(ids.bob, `join_pod($1)`, [podId]), /valid invite code/);
  await assert.rejects(rpc(ids.bob, `join_pod($1, 'WRONG1')`, [podId]), /valid invite code/);
  await assert.rejects(rpc(ids.bob, `join_pod_with_code('WRONG1')`), /Invalid invite code/);
  await assert.rejects(rpc(ids.bob, `join_pod_with_code('  ')`), /Enter an invite code/);
  assert.deepEqual((await pod(podId)).members, [ids.alice]);

  // Codes are matched ignoring case and surrounding spaces.
  const joined = await rpcValue(ids.bob, `join_pod_with_code($1)`, [` ${code.toLowerCase()} `]);
  assert.equal(joined, podId);
  await rpc(ids.carol, `join_pod($1, $2)`, [podId, code]);
  assert.deepEqual((await pod(podId)).members, [ids.alice, ids.bob, ids.carol]);

  await assert.rejects(rpc(ids.bob, `join_pod_with_code($1)`, [code]), /already a member/);

  // Members see the pod; everyone else still cannot.
  const visibleTo = (uid) =>
    asUser(
      uid,
      async () => (await db.query(`select 1 from public.pods where id = $1`, [podId])).rows.length,
    );
  assert.equal(await visibleTo(ids.bob), 1);
  assert.equal(await visibleTo(ids.dave), 0);
});

test('only admins manage admins, and the last admin cannot walk away', async () => {
  const podId = await createPod(ids.alice, 'Committee');
  await rpc(ids.bob, `join_pod($1)`, [podId]);

  await assert.rejects(rpc(ids.bob, `grant_pod_admin($1, $2)`, [podId, ids.bob]), /Only admins/);
  await assert.rejects(rpc(ids.bob, `remove_pod_admin($1, $2)`, [podId, ids.alice]), /Only admins/);
  await assert.rejects(rpc(ids.alice, `leave_pod($1)`, [podId]), /last admin/);

  await rpc(ids.alice, `grant_pod_admin($1, $2)`, [podId, ids.bob]);
  await rpc(ids.alice, `grant_pod_admin($1, $2)`, [podId, ids.bob]); // no duplicate entry
  assert.deepEqual((await pod(podId)).admins, [ids.alice, ids.bob]);

  await rpc(ids.alice, `leave_pod($1)`, [podId]);
  const p = await pod(podId);
  assert.deepEqual(p.members, [ids.bob]);
  assert.deepEqual(p.admins, [ids.bob]);
});

test('only an admin can edit or delete a pod; deleting takes everything with it', async () => {
  const podId = await createPod(ids.alice, 'Doomed');
  await rpc(ids.bob, `join_pod($1)`, [podId]);
  const actId = await createActivity(ids.bob, podId);
  await asUser(ids.bob, () =>
    db.query(
      `insert into public.messages (pod_id, sender_id, message) values ($1, $2, 'pod chat')`,
      [podId, ids.bob],
    ),
  );
  await asUser(ids.bob, () =>
    db.query(
      `insert into public.messages (activity_id, sender_id, message) values ($1, $2, 'act chat')`,
      [actId, ids.bob],
    ),
  );

  // A plain member's edit matches no rows (RLS), an admin's goes through.
  const rename = (uid, name) =>
    asUser(
      uid,
      async () =>
        (
          await db.query(`update public.pods set name = $2 where id = $1 returning id`, [
            podId,
            name,
          ])
        ).rows.length,
    );
  assert.equal(await rename(ids.bob, 'Hijacked'), 0);
  assert.equal(await rename(ids.alice, 'Renamed'), 1);

  await assert.rejects(rpc(ids.bob, `delete_pod($1)`, [podId]), /Only admins/);
  await blocked(ids.bob, `delete from public.pods where id = $1`, [podId]);
  await blocked(ids.alice, `delete from public.pods where id = $1`, [podId]); // even admins use the RPC
  assert.equal((await pod(podId)).member_count, 2);

  await rpc(ids.alice, `delete_pod($1)`, [podId]);
  const left = await one(
    `select (select count(*)::int from public.pods where id = $1) as pods,
            (select count(*)::int from public.activities where pod_id = $1) as activities,
            (select count(*)::int from public.messages where pod_id = $1 or activity_id = $2) as messages`,
    [podId, actId],
  );
  assert.deepEqual(left, { pods: 0, activities: 0, messages: 0 });
  assert.ok(!(await podsJoined(ids.alice)).includes(podId));
  assert.ok(!(await podsJoined(ids.bob)).includes(podId));
  await rpc(ids.alice, `delete_pod($1)`, [podId]); // deleting again is a no-op
});

test('app users cannot write pods or activities except through the RPCs', async () => {
  const podId = await createPod(ids.alice, 'Locked down');
  const actId = await createActivity(ids.alice, podId);
  for (const sql of [
    `insert into public.pods (name, category) values ('x', 'Other')`,
    `insert into public.activities (pod_id, host_id, title, category, start_time, expires_at, max_participants)
       values ('${podId}', '${ids.alice}', 'x', 'Other', now(), now(), 3)`,
    `update public.activities set max_participants = 99 where id = '${actId}'`,
    `delete from public.activities where id = '${actId}'`,
    `delete from public.messages`,
    `delete from public.profiles where id = '${ids.alice}'`,
  ]) {
    await blocked(ids.alice, sql);
  }
  // Internal helpers are not callable at all.
  await asUser(ids.alice, async () => {
    for (const sql of [
      `select public._add_pod_member('${podId}', '${ids.bob}')`,
      `select public._approve_participant('${actId}', '${ids.bob}')`,
      `select public.generate_invite_code()`,
    ]) {
      await assert.rejects(db.query(sql), /permission denied/, sql);
    }
  });
  const a = await one(`select max_participants from public.activities where id = $1`, [actId]);
  assert.equal(a.max_participants, 5);
  assert.deepEqual((await pod(podId)).members, [ids.alice]);
});

test('signed-out callers are turned away', async () => {
  await db.exec(`set role anon`);
  try {
    await assert.rejects(db.query(`select * from public.pods`), /permission denied/);
    await assert.rejects(
      db.query(`select public.create_pod('x', '', 'Other', 'public', null)`),
      /permission denied/,
    );
  } finally {
    await db.exec(`reset role`);
  }
});

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

test('only pod members can post an activity; the host is the first participant', async () => {
  const podId = await createPod(ids.alice, 'Posters');
  await assert.rejects(createActivity(ids.bob, podId), /must be a pod member/);

  const before = (await one(`select posts_count from public.profiles where id = $1`, [ids.alice]))
    .posts_count;
  const actId = await createActivity(ids.alice, podId);
  const a = await activity(actId);
  assert.deepEqual(a.participants, [ids.alice]);
  assert.equal(a.current_participants, 1);
  assert.equal(a.status, 'active');
  const row = await one(`select university, host_id from public.activities where id = $1`, [actId]);
  assert.equal(row.university, 'Boston University');
  const after = (await one(`select posts_count from public.profiles where id = $1`, [ids.alice]))
    .posts_count;
  assert.equal(after, before + 1);
});

test('auto-approve lets people straight in until the activity is full', async () => {
  const podId = await createPod(ids.alice, 'Walk-ins');
  await rpc(ids.bob, `join_pod($1)`, [podId]);
  await rpc(ids.carol, `join_pod($1)`, [podId]);
  const actId = await createActivity(ids.alice, podId, { max: 2, auto: true });

  await rpc(ids.bob, `request_join_activity($1)`, [actId]);
  await rpc(ids.bob, `request_join_activity($1)`, [actId]); // asking twice changes nothing
  let a = await activity(actId);
  assert.deepEqual(a.participants, [ids.alice, ids.bob]);
  assert.deepEqual(a.pending_requests, []);
  assert.equal(a.current_participants, 2);

  await assert.rejects(rpc(ids.carol, `request_join_activity($1)`, [actId]), /Activity is full/);

  // Someone leaving frees the spot.
  await rpc(ids.bob, `leave_activity($1)`, [actId]);
  await rpc(ids.carol, `request_join_activity($1)`, [actId]);
  a = await activity(actId);
  assert.deepEqual(a.participants, [ids.alice, ids.carol]);
  assert.equal(a.current_participants, 2);
});

test('people who cannot see an activity cannot ask to join it', async () => {
  const podId = await createPod(ids.alice, 'Campus only');
  const podOnly = await createActivity(ids.alice, podId, { visibility: 'pod' });
  const campus = await createActivity(ids.alice, podId, { visibility: 'university' });

  // Bob is at BU but not in the pod; Dave is at Harvard.
  await assert.rejects(rpc(ids.bob, `request_join_activity($1)`, [podOnly]), /Activity not found/);
  await assert.rejects(rpc(ids.dave, `request_join_activity($1)`, [campus]), /Activity not found/);
  await rpc(ids.bob, `request_join_activity($1)`, [campus]);
  assert.deepEqual((await activity(campus)).pending_requests, [ids.bob]);
  assert.deepEqual((await activity(podOnly)).pending_requests, []);
});

test('requests can be declined by the host or withdrawn by the requester, nobody else', async () => {
  const podId = await createPod(ids.alice, 'Picky');
  await rpc(ids.bob, `join_pod($1)`, [podId]);
  await rpc(ids.carol, `join_pod($1)`, [podId]);
  const actId = await createActivity(ids.alice, podId);
  await rpc(ids.bob, `request_join_activity($1)`, [actId]);
  await rpc(ids.carol, `request_join_activity($1)`, [actId]);
  assert.deepEqual((await activity(actId)).pending_requests, [ids.bob, ids.carol]);

  await assert.rejects(
    rpc(ids.carol, `reject_join_request($1, $2)`, [actId, ids.bob]),
    /Only the host/,
  );
  await rpc(ids.carol, `reject_join_request($1, $2)`, [actId, ids.carol]); // withdraw own
  await rpc(ids.alice, `reject_join_request($1, $2)`, [actId, ids.bob]); // host declines
  const a = await activity(actId);
  assert.deepEqual(a.pending_requests, []);
  assert.deepEqual(a.participants, [ids.alice]);
  assert.equal(a.current_participants, 1);
});

test('the host cannot leave; leaving when not in is a no-op', async () => {
  const podId = await createPod(ids.alice, 'Hosted');
  await rpc(ids.bob, `join_pod($1)`, [podId]);
  const actId = await createActivity(ids.alice, podId);

  await assert.rejects(
    rpc(ids.alice, `leave_activity($1)`, [actId]),
    /cannot leave your own activity/,
  );
  await rpc(ids.bob, `leave_activity($1)`, [actId]);
  const a = await activity(actId);
  assert.deepEqual(a.participants, [ids.alice]);
  assert.equal(a.current_participants, 1);
});

test('an activity can be deleted by its host or a pod admin, and its chat goes too', async () => {
  const podId = await createPod(ids.alice, 'Moderated');
  await rpc(ids.bob, `join_pod($1)`, [podId]);
  await rpc(ids.carol, `join_pod($1)`, [podId]);

  const byBob = await createActivity(ids.bob, podId);
  await asUser(ids.bob, () =>
    db.query(
      `insert into public.messages (activity_id, sender_id, message) values ($1, $2, 'hi')`,
      [byBob, ids.bob],
    ),
  );
  await assert.rejects(
    rpc(ids.carol, `delete_activity($1)`, [byBob]),
    /Only the host or a pod admin/,
  );
  await rpc(ids.alice, `delete_activity($1)`, [byBob]); // Alice is the pod admin
  assert.equal(await activity(byBob), undefined);
  const msgs = await one(`select count(*)::int as c from public.messages where activity_id = $1`, [
    byBob,
  ]);
  assert.equal(msgs.c, 0);

  const byCarol = await createActivity(ids.carol, podId);
  await rpc(ids.carol, `delete_activity($1)`, [byCarol]); // the host
  assert.equal(await activity(byCarol), undefined);
});

test('opening an overdue activity expires it and clears its chat', async () => {
  const podId = await createPod(ids.alice, 'Ephemeral');
  const actId = await createActivity(ids.alice, podId);
  await asUser(ids.alice, () =>
    db.query(
      `insert into public.messages (activity_id, sender_id, message) values ($1, $2, 'soon')`,
      [actId, ids.alice],
    ),
  );

  assert.equal(await rpcValue(ids.alice, `expire_activity_if_needed($1)`, [actId]), 'active');
  await db.query(
    `update public.activities set expires_at = now() - interval '1 minute' where id = $1`,
    [actId],
  );
  // Someone who cannot see the activity gets nothing and changes nothing.
  assert.equal(await rpcValue(ids.dave, `expire_activity_if_needed($1)`, [actId]), null);
  assert.equal((await activity(actId)).status, 'active');

  assert.equal(await rpcValue(ids.alice, `expire_activity_if_needed($1)`, [actId]), 'expired');
  assert.equal((await activity(actId)).status, 'expired');
  const msgs = await one(`select count(*)::int as c from public.messages where activity_id = $1`, [
    actId,
  ]);
  assert.equal(msgs.c, 0);
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

test('chat is readable and writable only by the people in the room', async () => {
  const podId = await createPod(ids.alice, 'Chatty');
  await rpc(ids.bob, `join_pod($1)`, [podId]);
  await rpc(ids.carol, `join_pod($1)`, [podId]);
  const actId = await createActivity(ids.alice, podId);
  await rpc(ids.bob, `request_join_activity($1)`, [actId]);
  await rpc(ids.alice, `approve_join_request($1, $2)`, [actId, ids.bob]);
  await rpc(ids.carol, `request_join_activity($1)`, [actId]); // still pending

  const say = (uid, room, roomId, as = uid) =>
    asUser(uid, () =>
      db.query(`insert into public.messages (${room}, sender_id, message) values ($1, $2, 'hey')`, [
        roomId,
        as,
      ]),
    );
  const reads = (uid, room, roomId) =>
    asUser(
      uid,
      async () =>
        (await db.query(`select id from public.messages where ${room} = $1`, [roomId])).rows.length,
    );

  // Activity chat: host and approved participant only.
  await say(ids.alice, 'activity_id', actId);
  await say(ids.bob, 'activity_id', actId);
  await assert.rejects(say(ids.carol, 'activity_id', actId), /row-level security/); // pending
  await assert.rejects(say(ids.dave, 'activity_id', actId), /row-level security/);
  assert.equal(await reads(ids.bob, 'activity_id', actId), 2);
  assert.equal(await reads(ids.carol, 'activity_id', actId), 0);
  assert.equal(await reads(ids.dave, 'activity_id', actId), 0);

  // Pod chat: members only.
  await say(ids.carol, 'pod_id', podId);
  await assert.rejects(say(ids.dave, 'pod_id', podId), /row-level security/);
  assert.equal(await reads(ids.alice, 'pod_id', podId), 1);
  assert.equal(await reads(ids.dave, 'pod_id', podId), 0);

  // Nobody can post under someone else's name, into two rooms, or into none.
  await assert.rejects(say(ids.bob, 'pod_id', podId, ids.alice), /row-level security/);
  await asUser(ids.bob, async () => {
    await assert.rejects(
      db.query(
        `insert into public.messages (pod_id, activity_id, sender_id, message) values ($1, $2, $3, 'x')`,
        [podId, actId, ids.bob],
      ),
      /messages_one_room/,
    );
    await assert.rejects(
      db.query(`insert into public.messages (sender_id, message) values ($1, 'x')`, [ids.bob]),
      /messages_one_room|row-level security/,
    );
  });
  // Sent messages cannot be edited or deleted from the app.
  await blocked(ids.bob, `update public.messages set message = 'edited'`);
  await blocked(ids.bob, `delete from public.messages`);
  assert.equal(await reads(ids.alice, 'pod_id', podId), 1);

  // Leaving the activity ends access to its chat.
  await rpc(ids.bob, `leave_activity($1)`, [actId]);
  assert.equal(await reads(ids.bob, 'activity_id', actId), 0);
  await assert.rejects(say(ids.bob, 'activity_id', actId), /row-level security/);
});

// ---------------------------------------------------------------------------
// Known gaps. These describe behaviour the RPCs should have but do not yet;
// they are marked todo so they report without failing the run. Fix each in a
// new migration and drop the `todo`.
// ---------------------------------------------------------------------------

test(
  'an expired activity accepts no new join requests',
  { todo: 'request_join_activity ignores status' },
  async () => {
    const podId = await createPod(ids.alice, 'Gap: expired');
    await rpc(ids.bob, `join_pod($1)`, [podId]);
    const actId = await createActivity(ids.alice, podId, { auto: true });
    await db.query(
      `update public.activities set status = 'expired', expires_at = now() - interval '1 hour' where id = $1`,
      [actId],
    );
    await assert.rejects(rpc(ids.bob, `request_join_activity($1)`, [actId]));
  },
);

test(
  'admin can only be granted to a pod member',
  { todo: 'grant_pod_admin does not check membership' },
  async () => {
    const podId = await createPod(ids.alice, 'Gap: outsider admin');
    await assert.rejects(rpc(ids.alice, `grant_pod_admin($1, $2)`, [podId, ids.dave]));
  },
);

test(
  'a pod always keeps at least one admin',
  { todo: 'remove_pod_admin can remove the last admin' },
  async () => {
    const podId = await createPod(ids.alice, 'Gap: no admins');
    await assert.rejects(rpc(ids.alice, `remove_pod_admin($1, $2)`, [podId, ids.alice]));
  },
);
