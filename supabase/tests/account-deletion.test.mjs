// Account deletion: public.delete_account_data(uid) plus the auth.users
// cascade must leave no trace of the user and keep everyone else's data
// consistent. Run with the other database tests: npm run test:db

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.mjs';

const ids = {
  dana: '00000000-0000-0000-0000-0000000000d1', // the account being deleted
  ava: '00000000-0000-0000-0000-0000000000d2',
  ben: '00000000-0000-0000-0000-0000000000d3',
  cy: '00000000-0000-0000-0000-0000000000d4', // shares nothing with dana
};
const TOKEN = (s) => `ExponentPushToken[${s}]`;

/**
 * A fresh database where dana is tangled into everything:
 *   solo     pod only dana is in (with an activity + chat)      → deleted
 *   handoff  dana is the only admin; ava joined before ben      → ava promoted
 *   coAdmin  dana and ben are admins; ava is a member           → ben stays sole admin
 *   avas     ava's pod; dana and ben are members                → dana removed
 *   cys      cy's pod and activity; dana is not involved        → untouched
 */
async function seed() {
  const t = await createTestDb();
  const rpc = (uid, sql, params) => t.asUser(uid, () => t.db.query(sql, params));
  const id = async (uid, sql, params) => (await rpc(uid, sql, params)).rows[0].id;

  await t.signUp(ids.dana, 'dana@bu.edu', { display_name: 'Dana' });
  await t.signUp(ids.ava, 'ava@bu.edu', { display_name: 'Ava' });
  await t.signUp(ids.ben, 'ben@bu.edu', { display_name: 'Ben' });
  await t.signUp(ids.cy, 'cy@bu.edu', { display_name: 'Cy' });

  const pod = (uid, name) =>
    id(uid, `select public.create_pod($1, '', 'Sports', 'public', null) as id`, [name]);
  const join = (uid, podId) => rpc(uid, `select public.join_pod($1)`, [podId]);
  const activity = (uid, podId, title, autoApprove) =>
    id(
      uid,
      `select public.create_activity($1, 'Host', $2, 'Sports', '{}',
         now() + interval '1 hour', now() + interval '3 hours', 5, 'pod', $3) as id`,
      [podId, title, autoApprove],
    );
  const request = (uid, actId) => rpc(uid, `select public.request_join_activity($1)`, [actId]);
  const say = (uid, actId, podId, text) =>
    t.db.query(
      `insert into public.messages (activity_id, pod_id, sender_id, message) values ($1, $2, $3, $4)`,
      [actId, podId, uid, text],
    );

  const pods = {
    solo: await pod(ids.dana, 'Solo'),
    handoff: await pod(ids.dana, 'Handoff'),
    coAdmin: await pod(ids.dana, 'CoAdmin'),
    avas: await pod(ids.ava, 'Avas'),
    cys: await pod(ids.cy, 'Cys'),
  };
  await join(ids.ava, pods.handoff); // ava before ben: ava is longest-standing
  await join(ids.ben, pods.handoff);
  await join(ids.ben, pods.coAdmin);
  await join(ids.ava, pods.coAdmin);
  await rpc(ids.dana, `select public.grant_pod_admin($1, $2)`, [pods.coAdmin, ids.ben]);
  await join(ids.dana, pods.avas);
  await join(ids.ben, pods.avas);

  const acts = {
    soloHosted: await activity(ids.dana, pods.solo, 'Solo run', true),
    hosted: await activity(ids.dana, pods.handoff, 'Dana hosts', true),
    joined: await activity(ids.ava, pods.avas, 'Dana joined', true),
    pending: await activity(ids.ava, pods.avas, 'Dana pending', false),
    cys: await activity(ids.cy, pods.cys, 'Cy only', true),
  };
  await request(ids.ava, acts.hosted); // auto-approved into dana's activity
  await request(ids.dana, acts.joined);
  await request(ids.ben, acts.joined);
  await request(ids.dana, acts.pending);
  await request(ids.ben, acts.pending);

  await say(ids.dana, acts.soloHosted, null, 'solo chat');
  await say(ids.dana, acts.hosted, null, 'host says hi');
  await say(ids.ava, acts.hosted, null, 'ava in danas activity');
  await say(ids.dana, acts.joined, null, 'dana in avas activity');
  await say(ids.ava, acts.joined, null, 'ava keeps this');
  await say(ids.dana, null, pods.avas, 'dana in pod chat');
  await say(ids.ben, null, pods.avas, 'ben keeps this');
  await say(ids.cy, acts.cys, null, 'cy keeps this');

  await rpc(ids.dana, `select public.register_push_token($1, 'ios')`, [TOKEN('dana')]);
  await rpc(ids.ava, `select public.register_push_token($1, 'ios')`, [TOKEN('ava')]);
  for (const uid of [ids.dana, ids.ava]) {
    await t.db.query(
      `insert into public.pod_recommendations (profile_id, signals_key, model) values ($1, 'k', 'm')`,
      [uid],
    );
  }
  return { t, pods, acts };
}

const cleanup = (t, uid) =>
  t.asService(async () => (await t.one(`select public.delete_account_data($1) as r`, [uid])).r);
const deleteAuthUser = (t, uid) => t.db.query(`delete from auth.users where id = $1`, [uid]);
const count = async (t, sql, params) => (await t.one(sql, params)).c;

/** Every uuid / uuid[] column in the public schema that still holds `uid`. */
async function referencesTo(t, uid) {
  const { rows: columns } = await t.db.query(
    `select table_name, column_name, udt_name from information_schema.columns
      where table_schema = 'public' and udt_name in ('uuid', '_uuid')`,
  );
  assert.ok(columns.length >= 15, 'expected to scan the uuid columns of every table');
  const found = [];
  for (const { table_name, column_name, udt_name } of columns) {
    const where = udt_name === '_uuid' ? `$1 = any ("${column_name}")` : `"${column_name}" = $1`;
    const c = await count(
      t,
      `select count(*)::int as c from public."${table_name}" where ${where}`,
      [uid],
    );
    if (c > 0) found.push(`${table_name}.${column_name} (${c})`);
  }
  return found;
}

/** The state every deletion path must end in. */
async function assertDeletedAndConsistent({ t, pods, acts }) {
  assert.deepEqual(await referencesTo(t, ids.dana), [], 'no column still holds the user id');
  assert.equal(
    await count(t, `select count(*)::int as c from auth.users where id = $1`, [ids.dana]),
    0,
  );

  const pod = (id) =>
    t.one(`select members, admins, member_count, created_by from public.pods where id = $1`, [id]);

  assert.equal(await pod(pods.solo), undefined, 'sole-member pod is deleted');

  // Sole admin leaves: the longest-standing remaining member takes over.
  assert.deepEqual(await pod(pods.handoff), {
    members: [ids.ava, ids.ben],
    admins: [ids.ava],
    member_count: 2,
    created_by: null,
  });
  // Another admin remains: nobody is promoted.
  assert.deepEqual(await pod(pods.coAdmin), {
    members: [ids.ben, ids.ava],
    admins: [ids.ben],
    member_count: 2,
    created_by: null,
  });
  assert.deepEqual(await pod(pods.avas), {
    members: [ids.ava, ids.ben],
    admins: [ids.ava],
    member_count: 2,
    created_by: ids.ava,
  });

  // Hosted activities and their whole chats are gone, other people's lines too.
  assert.equal(
    await count(t, `select count(*)::int as c from public.activities where id = any ($1)`, [
      [acts.soloHosted, acts.hosted],
    ]),
    0,
  );
  assert.equal(
    await count(t, `select count(*)::int as c from public.messages where activity_id = any ($1)`, [
      [acts.soloHosted, acts.hosted],
    ]),
    0,
  );

  const act = (id) =>
    t.one(
      `select host_id, participants, pending_requests, current_participants
         from public.activities where id = $1`,
      [id],
    );
  assert.deepEqual(await act(acts.joined), {
    host_id: ids.ava,
    participants: [ids.ava, ids.ben],
    pending_requests: [],
    current_participants: 2,
  });
  assert.deepEqual(await act(acts.pending), {
    host_id: ids.ava,
    participants: [ids.ava],
    pending_requests: [ids.ben],
    current_participants: 1,
  });

  // Other users' data is untouched.
  const { rows: messages } = await t.db.query(
    `select message from public.messages order by message`,
  );
  assert.deepEqual(
    messages.map((m) => m.message),
    ['ava keeps this', 'ben keeps this', 'cy keeps this'],
  );
  assert.deepEqual(await pod(pods.cys), {
    members: [ids.cy],
    admins: [ids.cy],
    member_count: 1,
    created_by: ids.cy,
  });
  assert.deepEqual(await act(acts.cys), {
    host_id: ids.cy,
    participants: [ids.cy],
    pending_requests: [],
    current_participants: 1,
  });
  const joined = async (uid) =>
    [
      ...(await t.one(`select pods_joined from public.profiles where id = $1`, [uid])).pods_joined,
    ].sort();
  assert.deepEqual(await joined(ids.ava), [pods.handoff, pods.coAdmin, pods.avas].sort());
  assert.deepEqual(await joined(ids.ben), [pods.handoff, pods.coAdmin, pods.avas].sort());
  assert.deepEqual(await joined(ids.cy), [pods.cys]);
  assert.equal(await count(t, `select count(*)::int as c from public.profiles`), 3);

  const { rows: tokens } = await t.db.query(`select token from public.push_tokens`);
  assert.deepEqual(tokens, [{ token: TOKEN('ava') }]);
  const { rows: cache } = await t.db.query(`select profile_id from public.pod_recommendations`);
  assert.deepEqual(cache, [{ profile_id: ids.ava }]);

  // Queued pushes between the others survive (ben asked to join ava's activity).
  assert.equal(
    await count(
      t,
      `select count(*)::int as c from public.notification_outbox
        where type = 'join_request' and actor_id = $1 and activity_id = $2`,
      [ids.ben, acts.pending],
    ),
    1,
  );
}

test('cleanup then auth delete removes the user everywhere and keeps the rest consistent', async () => {
  const world = await seed();
  const { t } = world;
  try {
    // Sanity: the seed really did tangle the user in.
    assert.ok((await referencesTo(t, ids.dana)).length >= 8);

    const summary = await cleanup(t, ids.dana);
    assert.deepEqual(summary, {
      pods_left: 3,
      pods_deleted: 1,
      admins_promoted: 1,
      activities_deleted: 2,
      activities_left: 2,
    });
    await deleteAuthUser(t, ids.dana);
    await assertDeletedAndConsistent(world);
  } finally {
    await t.db.close();
  }
});

test('after cleanup alone the account still works and the cleanup can be retried', async () => {
  const world = await seed();
  const { t, pods } = world;
  try {
    await cleanup(t, ids.dana);

    // Only the profile is left, plus "created by" on the two pods that
    // outlive the user (set null by the foreign key when the profile goes).
    assert.deepEqual(await referencesTo(t, ids.dana), ['pods.created_by (2)', 'profiles.id (1)']);
    const profile = await t.one(`select pods_joined from public.profiles where id = $1`, [
      ids.dana,
    ]);
    assert.deepEqual(profile.pods_joined, []);

    // Still a normal account: can use the app while the auth delete is retried.
    await t.asUser(ids.dana, () => t.db.query(`select public.join_pod($1)`, [pods.cys]));
    assert.equal(
      (await t.one(`select member_count from public.pods where id = $1`, [pods.cys])).member_count,
      2,
    );

    // Retry: idempotent, and it picks up what was joined in between.
    assert.deepEqual(await cleanup(t, ids.dana), {
      pods_left: 1,
      pods_deleted: 0,
      admins_promoted: 0,
      activities_deleted: 0,
      activities_left: 0,
    });
    assert.equal((await cleanup(t, ids.dana)).pods_left, 0);
    await deleteAuthUser(t, ids.dana);
    await assertDeletedAndConsistent(world);
  } finally {
    await t.db.close();
  }
});

test('deleting the auth user without the cleanup call still scrubs the arrays (trigger)', async () => {
  const world = await seed();
  try {
    await deleteAuthUser(world.t, ids.dana);
    await assertDeletedAndConsistent(world);
  } finally {
    await world.t.db.close();
  }
});

test('foreign keys alone cascade rows but leave dangling array ids', async () => {
  const world = await seed();
  const { t, pods, acts } = world;
  try {
    await t.db.exec(`alter table public.profiles disable trigger profiles_cleanup_after_delete`);
    await deleteAuthUser(t, ids.dana);

    // Confirmed cascades: profile, hosted activities (host_id), sent messages
    // (sender_id), push tokens, recommendation cache.
    assert.equal(
      await count(t, `select count(*)::int as c from public.profiles where id = $1`, [ids.dana]),
      0,
    );
    assert.equal(
      await count(t, `select count(*)::int as c from public.activities where id = any ($1)`, [
        [acts.soloHosted, acts.hosted],
      ]),
      0,
    );
    const { rows: messages } = await t.db.query(
      `select message from public.messages order by message`,
    );
    assert.deepEqual(
      messages.map((m) => m.message),
      ['ava keeps this', 'ben keeps this', 'cy keeps this'],
    );
    assert.equal(
      await count(t, `select count(*)::int as c from public.push_tokens where profile_id = $1`, [
        ids.dana,
      ]),
      0,
    );
    assert.equal(
      await count(
        t,
        `select count(*)::int as c from public.pod_recommendations where profile_id = $1`,
        [ids.dana],
      ),
      0,
    );

    // ...and this is what the cleanup function exists for.
    const dangling = await referencesTo(t, ids.dana);
    for (const column of [
      'pods.members',
      'pods.admins',
      'activities.participants',
      'activities.pending_requests',
    ]) {
      assert.ok(
        dangling.some((d) => d.startsWith(column)),
        `${column} should dangle without cleanup`,
      );
    }
    assert.equal(
      (await t.one(`select member_count from public.pods where id = $1`, [pods.solo])).member_count,
      1,
    );
  } finally {
    await t.db.close();
  }
});

test('app users and anon cannot run the cleanup, for themselves or anyone else', async () => {
  const world = await seed();
  const { t } = world;
  try {
    const before = await referencesTo(t, ids.dana);
    for (const [role, uid] of [
      ['authenticated', ids.dana],
      ['authenticated', ids.ava],
      ['anon', null],
    ]) {
      await t.asRole(role, uid, async () => {
        await assert.rejects(
          t.db.query(`select public.delete_account_data($1)`, [ids.dana]),
          /permission denied for function delete_account_data/,
        );
        await assert.rejects(
          t.db.query(`select public.cleanup_deleted_profile()`),
          /permission denied|trigger functions can only be called as triggers/,
        );
        // No direct route either: with no DELETE policy, Row Level Security
        // makes a client delete of a profile row match nothing (or be denied).
        await t.db.query(`delete from public.profiles where id = $1`, [ids.dana]).catch((err) => {
          assert.match(err.message, /permission denied/);
        });
      });
    }
    assert.deepEqual(await referencesTo(t, ids.dana), before, 'nothing changed');
    assert.equal(await count(t, `select count(*)::int as c from public.profiles`), 4);

    await assert.rejects(cleanup(t, null), /A user id is required/);
    // Unknown id: a no-op, not an error.
    assert.equal((await cleanup(t, '00000000-0000-0000-0000-0000000000ff')).pods_left, 0);
    assert.deepEqual(await referencesTo(t, ids.dana), before);
  } finally {
    await t.db.close();
  }
});
