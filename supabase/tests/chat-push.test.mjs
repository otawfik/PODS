// Chat message pushes and per-pod mute
// (supabase/migrations/20261123000200_chat_push_and_mute.sql).
// Run with the other database tests: npm run test:db

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof createTestDb>>} */
let t;

const ids = {
  host: '00000000-0000-0000-0000-0000000000b1',
  member: '00000000-0000-0000-0000-0000000000b2',
  other: '00000000-0000-0000-0000-0000000000b3',
  outsider: '00000000-0000-0000-0000-0000000000b4', // BU, not in the pod
};
const names = { [ids.host]: 'Hana', [ids.member]: 'Milo', [ids.other]: 'Olga' };

let podId;
/** Activity with host + member as participants; `other` is only in the pod. */
let actId;

const rpc = (uid, sql, params) => t.asUser(uid, () => t.db.query(sql, params));

before(async () => {
  t = await createTestDb();
  await t.signUp(ids.host, 'hana@bu.edu', { display_name: 'Hana' });
  await t.signUp(ids.member, 'milo@bu.edu', { display_name: 'Milo' });
  await t.signUp(ids.other, 'olga@bu.edu', { display_name: 'Olga' });
  await t.signUp(ids.outsider, 'oscar@bu.edu', { display_name: 'Oscar' });

  podId = await t.asUser(
    ids.host,
    async () =>
      (await t.one(`select public.create_pod('Climbing', '', 'Sports', 'public', null) as id`)).id,
  );
  for (const uid of [ids.member, ids.other]) {
    await rpc(uid, `select public.join_pod($1)`, [podId]);
  }
  actId = await createActivity('Bouldering');
  await rpc(ids.member, `select public.request_join_activity($1)`, [actId]);
  await rpc(ids.host, `select public.approve_join_request($1, $2)`, [actId, ids.member]);
});

after(async () => {
  await t?.db.close();
});

beforeEach(async () => {
  await t.db.exec(`delete from public.notification_outbox; delete from public.pod_mutes;`);
});

async function createActivity(title) {
  return t.asUser(
    ids.host,
    async () =>
      (
        await t.one(
          `select public.create_activity($1, 'Hana', $2, 'Sports', '{}',
         now() + interval '1 hour', now() + interval '3 hours', 5, 'pod', false) as id`,
          [podId, title],
        )
      ).id,
  );
}

/** Send a chat message as `uid`, the way the app does (a plain insert under RLS). */
function send(uid, room, message) {
  return rpc(
    uid,
    `insert into public.messages (activity_id, pod_id, sender_id, sender_name, message)
     values ($1, $2, $3, $4, $5)`,
    [room.activityId ?? null, room.podId ?? null, uid, names[uid], message],
  );
}

/** Outbox rows as plain objects, oldest first. */
async function outbox(type = 'chat_message') {
  const { rows } = await t.db.query(
    `select type, activity_id, pod_id, actor_id, recipient_ids, payload
       from public.notification_outbox where type = $1 order by created_at`,
    [type],
  );
  return rows.map((r) => ({ ...r, recipient_ids: [...r.recipient_ids].sort() }));
}

/** Pretend earlier chat notifications were delivered `minutes` ago. */
async function ageOutbox(minutes) {
  await t.db.query(
    `update public.notification_outbox
        set sent_at = now(), created_at = now() - make_interval(mins => $1)`,
    [minutes],
  );
}

const messageCount = async () =>
  (await t.one(`select count(*)::int as c from public.messages`)).c;

// ---------------------------------------------------------------------------
// Chat messages → outbox
// ---------------------------------------------------------------------------

test('a pod chat message notifies the other members, never the sender', async () => {
  await send(ids.member, { podId }, 'Anyone climbing tonight?');
  assert.deepEqual(await outbox(), [
    {
      type: 'chat_message',
      activity_id: null,
      pod_id: podId,
      actor_id: ids.member,
      recipient_ids: [ids.host, ids.other].sort(),
      payload: {
        podName: 'Climbing',
        actorName: 'Milo',
        preview: 'Anyone climbing tonight?',
      },
    },
  ]);
});

test('an activity chat message notifies the other participants only', async () => {
  await send(ids.host, { activityId: actId }, 'Meet at the front desk');
  const rows = await outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activity_id, actId);
  assert.equal(rows[0].pod_id, null);
  assert.equal(rows[0].actor_id, ids.host);
  // Olga is in the pod but did not join the activity.
  assert.deepEqual(rows[0].recipient_ids, [ids.member]);
  assert.deepEqual(rows[0].payload, {
    activityTitle: 'Bouldering',
    actorName: 'Hana',
    preview: 'Meet at the front desk',
  });
});

test('the stored preview is clipped to 140 characters', async () => {
  await send(ids.member, { podId }, 'x'.repeat(1000));
  const [row] = await outbox();
  assert.equal(row.payload.preview.length, 140);
});

test('collapse: no second notification while one is still waiting to be sent', async () => {
  await send(ids.member, { podId }, 'one');
  await send(ids.member, { podId }, 'two');
  await send(ids.member, { podId }, 'three');
  const rows = await outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.preview, 'one');
});

test('collapse: quiet for 2 minutes after a delivered one, then notifies again', async () => {
  await send(ids.member, { podId }, 'first');
  await ageOutbox(1); // delivered a minute ago
  await send(ids.member, { podId }, 'still inside the window');
  assert.equal((await outbox()).length, 1);

  await ageOutbox(3); // now older than the window
  await send(ids.member, { podId }, 'after the window');
  const rows = await outbox();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].payload.preview, 'after the window');
  assert.deepEqual(rows[1].recipient_ids, [ids.host, ids.other].sort());
});

test('collapse is per recipient and per room', async () => {
  // Milo writes: Hana and Olga are notified. Hana answers: only Milo is new.
  await send(ids.member, { podId }, 'hi');
  await send(ids.host, { podId }, 'hello');
  let rows = await outbox();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].recipient_ids, [ids.member]);

  // A different room is not affected by the pod chat's pending notification.
  await send(ids.member, { activityId: actId }, 'on my way');
  rows = await outbox();
  assert.equal(rows.length, 3);
  assert.equal(rows[2].activity_id, actId);
  assert.deepEqual(rows[2].recipient_ids, [ids.host]);
});

test('an abandoned notification (5 failed attempts) stops holding the room back', async () => {
  await send(ids.member, { podId }, 'first');
  await t.db.query(
    `update public.notification_outbox
        set attempts = 5, created_at = now() - interval '10 minutes'`,
  );
  await send(ids.member, { podId }, 'second');
  assert.equal((await outbox()).length, 2);
});

test('people outside the room cannot send, so they cannot trigger a push', async () => {
  await assert.rejects(send(ids.outsider, { podId }, 'spam'), /row-level security/);
  await assert.rejects(send(ids.other, { activityId: actId }, 'spam'), /row-level security/);
  assert.deepEqual(await outbox(), []);
});

test('a broken outbox never blocks sending a chat message', async () => {
  const before = await messageCount();
  await t.db.exec(
    `alter table public.notification_outbox add constraint test_reject_all check (type = 'nope') not valid`,
  );
  try {
    await send(ids.member, { podId }, 'still goes through');
    await send(ids.host, { activityId: actId }, 'this one too');
  } finally {
    await t.db.exec(`alter table public.notification_outbox drop constraint test_reject_all`);
  }
  assert.equal(await messageCount(), before + 2);
  assert.deepEqual(await outbox(), []);
});

// ---------------------------------------------------------------------------
// Per-pod mute
// ---------------------------------------------------------------------------

test('a muted pod sends that member no pod-chat or new-activity pushes', async () => {
  await rpc(ids.other, `select public.set_pod_mute($1, true)`, [podId]);

  await send(ids.member, { podId }, 'muted for Olga');
  assert.deepEqual((await outbox())[0].recipient_ids, [ids.host]);

  await createActivity('Lead climbing');
  const [created] = await outbox('new_activity');
  assert.deepEqual(created.recipient_ids, [ids.member]);

  // Unmuting brings both back.
  await rpc(ids.other, `select public.set_pod_mute($1, false)`, [podId]);
  await t.db.exec(`delete from public.notification_outbox`);
  await send(ids.member, { podId }, 'audible again');
  assert.deepEqual((await outbox())[0].recipient_ids, [ids.host, ids.other].sort());
});

test('when every recipient muted the pod, nothing is queued', async () => {
  await rpc(ids.host, `select public.set_pod_mute($1, true)`, [podId]);
  await rpc(ids.other, `select public.set_pod_mute($1, true)`, [podId]);
  await send(ids.member, { podId }, 'nobody listening');
  assert.deepEqual(await outbox(), []);
});

test('direct notifications ignore the mute', async () => {
  await rpc(ids.host, `select public.set_pod_mute($1, true)`, [podId]);
  await rpc(ids.member, `select public.set_pod_mute($1, true)`, [podId]);
  await rpc(ids.other, `select public.set_pod_mute($1, true)`, [podId]);

  // A join request still reaches the (muted) host...
  await rpc(ids.other, `select public.request_join_activity($1)`, [actId]);
  const [request] = await outbox('join_request');
  assert.deepEqual(request.recipient_ids, [ids.host]);

  // ...the decision still reaches the (muted) requester...
  await rpc(ids.host, `select public.reject_join_request($1, $2)`, [actId, ids.other]);
  const [declined] = await outbox('request_declined');
  assert.deepEqual(declined.recipient_ids, [ids.other]);

  // ...and so does the chat of an activity they joined.
  await send(ids.host, { activityId: actId }, 'see you there');
  assert.deepEqual((await outbox())[0].recipient_ids, [ids.member]);
});

test('mutes are private: users read and change only their own', async () => {
  await rpc(ids.member, `select public.set_pod_mute($1, true)`, [podId]);
  await rpc(ids.member, `select public.set_pod_mute($1, true)`, [podId]); // idempotent
  await rpc(ids.other, `select public.set_pod_mute($1, true)`, [podId]);

  const mine = await rpc(ids.member, `select pod_id, profile_id from public.pod_mutes`);
  assert.deepEqual(mine.rows, [{ pod_id: podId, profile_id: ids.member }]);
  const hosts = await rpc(ids.host, `select * from public.pod_mutes`);
  assert.deepEqual(hosts.rows, []);

  // No direct writes: not for yourself, and not to mute or unmute others.
  await t.asUser(ids.host, async () => {
    await assert.rejects(
      t.db.query(`insert into public.pod_mutes (pod_id, profile_id) values ($1, $2)`, [
        podId,
        ids.host,
      ]),
      /permission denied/,
    );
    await assert.rejects(t.db.query(`delete from public.pod_mutes`), /permission denied/);
    await assert.rejects(
      t.db.query(`update public.pod_mutes set profile_id = $1`, [ids.host]),
      /permission denied/,
    );
  });

  // Unmuting changes only the caller's row.
  await rpc(ids.member, `select public.set_pod_mute($1, false)`, [podId]);
  const left = await t.db.query(`select profile_id from public.pod_mutes`);
  assert.deepEqual(left.rows, [{ profile_id: ids.other }]);
});

test('only signed-in members can mute; internal functions are not callable', async () => {
  await assert.rejects(
    rpc(ids.outsider, `select public.set_pod_mute($1, true)`, [podId]),
    /not a member/,
  );
  await t.asRole('anon', null, () =>
    assert.rejects(t.db.query(`select public.set_pod_mute($1, true)`, [podId]), /permission denied/),
  );
  await t.asRole('anon', null, () =>
    assert.rejects(t.db.query(`select * from public.pod_mutes`), /permission denied/),
  );
  for (const fn of [
    'enqueue_chat_notification',
    'apply_pod_mutes_to_outbox',
    'clear_mutes_of_former_members',
  ]) {
    await t.asUser(ids.member, () =>
      assert.rejects(t.db.query(`select public.${fn}()`), /permission denied|trigger/),
    );
  }
});

test('leaving a pod forgets the mute', async () => {
  await rpc(ids.other, `select public.set_pod_mute($1, true)`, [podId]);
  await rpc(ids.other, `select public.leave_pod($1)`, [podId]);
  const gone = await t.one(`select count(*)::int as c from public.pod_mutes`);
  assert.equal(gone.c, 0);

  await rpc(ids.other, `select public.join_pod($1)`, [podId]);
  await send(ids.member, { podId }, 'welcome back');
  assert.deepEqual((await outbox())[0].recipient_ids, [ids.host, ids.other].sort());
});
