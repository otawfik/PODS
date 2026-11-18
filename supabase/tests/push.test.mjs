// Push notification tests: device tokens (RLS + RPCs), the outbox rows each
// activity event produces, and the delivery contract used by the send-push
// Edge Function. Run with the other database tests: npm run test:db

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof createTestDb>>} */
let t;

const ids = {
  host: '00000000-0000-0000-0000-0000000000a1',
  member: '00000000-0000-0000-0000-0000000000a2',
  other: '00000000-0000-0000-0000-0000000000a3',
  outsider: '00000000-0000-0000-0000-0000000000a4', // BU, not in the pod
};
const TOKEN = (s) => `ExponentPushToken[${s}]`;

let podId;

before(async () => {
  t = await createTestDb();
  await t.signUp(ids.host, 'hana@bu.edu', { display_name: 'Hana' });
  await t.signUp(ids.member, 'milo@bu.edu', { display_name: 'Milo' });
  await t.signUp(ids.other, 'olga@bu.edu', { display_name: 'Olga' });
  await t.signUp(ids.outsider, 'oscar@bu.edu', { display_name: 'Oscar' });

  podId = await t.asUser(ids.host, async () =>
    (await t.one(`select public.create_pod('Climbing', '', 'Sports', 'public', null) as id`)).id,
  );
  for (const uid of [ids.member, ids.other]) {
    await t.asUser(uid, () => t.db.query(`select public.join_pod($1)`, [podId]));
  }
});

after(async () => {
  await t?.db.close();
});

beforeEach(async () => {
  await t.db.exec(`delete from public.notification_outbox`);
});

/** Outbox rows as plain objects, oldest first. */
async function outbox() {
  const { rows } = await t.db.query(
    `select type, activity_id, pod_id, actor_id, recipient_ids, payload
       from public.notification_outbox order by created_at, type`,
  );
  return rows.map((r) => ({ ...r, recipient_ids: [...r.recipient_ids].sort() }));
}

async function createActivity(autoApprove = false, title = 'Bouldering') {
  return t.asUser(ids.host, async () =>
    (await t.one(
      `select public.create_activity($1, 'Hana', $2, 'Sports', '{}',
         now() + interval '1 hour', now() + interval '3 hours', 5, 'university', $3) as id`,
      [podId, title, autoApprove],
    )).id,
  );
}

const rpc = (uid, sql, params) => t.asUser(uid, () => t.db.query(sql, params));

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test('users register, read and unregister only their own tokens', async () => {
  await rpc(ids.member, `select public.register_push_token($1, 'ios')`, [TOKEN('milo-phone')]);
  await rpc(ids.other, `select public.register_push_token($1, 'android')`, [TOKEN('olga-phone')]);

  const mine = await t.asUser(ids.member, () => t.db.query(`select token, platform from public.push_tokens`));
  assert.deepEqual(mine.rows, [{ token: TOKEN('milo-phone'), platform: 'ios' }], 'sees only own token');

  // No direct writes; unregistering someone else's token does nothing.
  await t.asUser(ids.member, async () => {
    await assert.rejects(
      t.db.query(`insert into public.push_tokens (token, profile_id, platform) values ($1, $2, 'ios')`, [
        TOKEN('x'),
        ids.member,
      ]),
      /permission denied/,
    );
    await assert.rejects(t.db.query(`delete from public.push_tokens`), /permission denied/);
    await t.db.query(`select public.unregister_push_token($1)`, [TOKEN('olga-phone')]);
  });
  const olga = await t.one(`select profile_id from public.push_tokens where token = $1`, [TOKEN('olga-phone')]);
  assert.equal(olga.profile_id, ids.other);

  await rpc(ids.member, `select public.unregister_push_token($1)`, [TOKEN('milo-phone')]);
  const gone = await t.one(`select count(*)::int as c from public.push_tokens where token = $1`, [
    TOKEN('milo-phone'),
  ]);
  assert.equal(gone.c, 0);
});

test('a token moves to whoever registers it last; bad input is rejected', async () => {
  await rpc(ids.member, `select public.register_push_token($1, 'ios')`, [TOKEN('shared')]);
  await rpc(ids.other, `select public.register_push_token($1, 'ios')`, [TOKEN('shared')]);
  const row = await t.one(`select profile_id from public.push_tokens where token = $1`, [TOKEN('shared')]);
  assert.equal(row.profile_id, ids.other);

  await t.asUser(ids.member, async () => {
    await assert.rejects(t.db.query(`select public.register_push_token('not-a-token', 'ios')`), /Invalid push token/);
    await assert.rejects(
      t.db.query(`select public.register_push_token($1, 'web')`, [TOKEN('w')]),
      /Invalid platform/,
    );
  });
  await t.asRole('anon', null, () =>
    assert.rejects(
      t.db.query(`select public.register_push_token($1, 'ios')`, [TOKEN('anon')]),
      /permission denied/,
    ),
  );
});

test('each user keeps at most 10 devices', async () => {
  for (let i = 0; i < 12; i++) {
    await rpc(ids.outsider, `select public.register_push_token($1, 'android')`, [TOKEN(`dev-${i}`)]);
  }
  const { rows } = await t.db.query(`select token from public.push_tokens where profile_id = $1`, [ids.outsider]);
  assert.equal(rows.length, 10);
  assert.ok(!rows.some((r) => r.token === TOKEN('dev-0')), 'oldest device dropped');
  await t.db.query(`delete from public.push_tokens where profile_id = $1`, [ids.outsider]);
});

// ---------------------------------------------------------------------------
// Events → outbox
// ---------------------------------------------------------------------------

test('a new activity notifies the other pod members, not the creator', async () => {
  const actId = await createActivity(false, 'Night session');
  assert.deepEqual(await outbox(), [
    {
      type: 'new_activity',
      activity_id: actId,
      pod_id: podId,
      actor_id: ids.host,
      recipient_ids: [ids.member, ids.other].sort(),
      payload: { activityTitle: 'Night session', podName: 'Climbing', actorName: 'Hana' },
    },
  ]);
});

test('a join request notifies the host once; a duplicate request is silent', async () => {
  const actId = await createActivity();
  await t.db.exec(`delete from public.notification_outbox`);

  await rpc(ids.member, `select public.request_join_activity($1)`, [actId]);
  await rpc(ids.member, `select public.request_join_activity($1)`, [actId]); // duplicate
  const rows = await outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'join_request');
  assert.deepEqual(rows[0].recipient_ids, [ids.host]);
  assert.equal(rows[0].actor_id, ids.member);
  assert.equal(rows[0].payload.actorName, 'Milo');
});

test('approval notifies the requester; re-approving is silent', async () => {
  const actId = await createActivity();
  await rpc(ids.member, `select public.request_join_activity($1)`, [actId]);
  await t.db.exec(`delete from public.notification_outbox`);

  await rpc(ids.host, `select public.approve_join_request($1, $2)`, [actId, ids.member]);
  await rpc(ids.host, `select public.approve_join_request($1, $2)`, [actId, ids.member]);
  const rows = await outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'request_approved');
  assert.deepEqual(rows[0].recipient_ids, [ids.member]);
  assert.equal(rows[0].actor_id, ids.host);
});

test('a decline notifies the requester; withdrawing your own request is silent', async () => {
  const actId = await createActivity();
  await rpc(ids.member, `select public.request_join_activity($1)`, [actId]);
  await rpc(ids.other, `select public.request_join_activity($1)`, [actId]);
  await t.db.exec(`delete from public.notification_outbox`);

  await rpc(ids.host, `select public.reject_join_request($1, $2)`, [actId, ids.member]);
  await rpc(ids.other, `select public.reject_join_request($1, $2)`, [actId, ids.other]); // withdraw
  const rows = await outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'request_declined');
  assert.deepEqual(rows[0].recipient_ids, [ids.member]);
});

test('auto-approve joins notify the host; leaving and expiry are silent', async () => {
  const actId = await createActivity(true);
  await t.db.exec(`delete from public.notification_outbox`);

  await rpc(ids.outsider, `select public.request_join_activity($1)`, [actId]); // university-visible
  let rows = await outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'participant_joined');
  assert.deepEqual(rows[0].recipient_ids, [ids.host]);
  assert.equal(rows[0].payload.actorName, 'Oscar');

  await t.db.exec(`delete from public.notification_outbox`);
  await rpc(ids.outsider, `select public.leave_activity($1)`, [actId]);
  await t.db.query(`update public.activities set expires_at = now() - interval '1 minute' where id = $1`, [actId]);
  await t.db.query(`select public.expire_due_activities()`);
  rows = await outbox();
  assert.deepEqual(rows, []);
});

test('a broken outbox never rolls back the join request', async () => {
  const actId = await createActivity();
  await t.db.exec(
    `alter table public.notification_outbox add constraint test_reject_all check (type = 'nope') not valid`,
  );
  try {
    await rpc(ids.member, `select public.request_join_activity($1)`, [actId]);
  } finally {
    await t.db.exec(`alter table public.notification_outbox drop constraint test_reject_all`);
  }
  const act = await t.one(`select pending_requests from public.activities where id = $1`, [actId]);
  assert.deepEqual(act.pending_requests, [ids.member]);
});

// ---------------------------------------------------------------------------
// Delivery contract
// ---------------------------------------------------------------------------

test('clients cannot read the outbox or call the delivery functions', async () => {
  await createActivity();
  await t.asUser(ids.member, async () => {
    await assert.rejects(t.db.query(`select * from public.notification_outbox`), /permission denied/);
    await assert.rejects(t.db.query(`select * from public.claim_push_notifications(10)`), /permission denied/);
    await assert.rejects(t.db.query(`select public.kick_push_delivery()`), /permission denied/);
    await assert.rejects(
      t.db.query(`select public._enqueue_notification('join_request', null, null, null, $1, '{}')`, [[ids.member]]),
      /permission denied/,
    );
  });
});

test('claim_push_notifications leases pending rows with their recipients tokens', async () => {
  await t.db.exec(`delete from public.push_tokens`);
  await rpc(ids.member, `select public.register_push_token($1, 'ios')`, [TOKEN('milo-1')]);
  await rpc(ids.member, `select public.register_push_token($1, 'android')`, [TOKEN('milo-2')]);
  await rpc(ids.host, `select public.register_push_token($1, 'ios')`, [TOKEN('hana-1')]);
  const actId = await createActivity(false, 'Claimed');

  // Without pg_net/vault (as here) the kick is a quiet no-op.
  await t.db.query(`select public.kick_push_delivery()`);

  const claimed = await t.asService(() => t.db.query(`select * from public.claim_push_notifications(10)`));
  assert.equal(claimed.rows.length, 1);
  const [row] = claimed.rows;
  assert.equal(row.type, 'new_activity');
  assert.equal(row.activity_id, actId);
  assert.deepEqual(row.tokens, [TOKEN('milo-1'), TOKEN('milo-2')], "host's own token is not included");

  const again = await t.asService(() => t.db.query(`select * from public.claim_push_notifications(10)`));
  assert.equal(again.rows.length, 0, 'leased rows are not handed out twice');

  // The function marks rows sent and removes dead tokens with the service role.
  await t.asService(async () => {
    await t.db.query(`update public.notification_outbox set sent_at = now() where id = $1`, [row.id]);
    await t.db.query(`delete from public.push_tokens where token = $1`, [TOKEN('milo-2')]);
  });
  const state = await t.one(`select attempts, sent_at is not null as sent from public.notification_outbox where id = $1`, [
    row.id,
  ]);
  assert.deepEqual(state, { attempts: 1, sent: true });
});
