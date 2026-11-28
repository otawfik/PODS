// Features from different PRs working together: blocks + chat pushes,
// both join guards on request_join_activity, and account deletion with
// blocks / mutes / reports / push tokens in place.
// Run with the other database tests: npm run test:db

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof createTestDb>>} */
let t;

const ids = {
  ana: '00000000-0000-0000-0000-0000000000c1',
  ben: '00000000-0000-0000-0000-0000000000c2',
  cat: '00000000-0000-0000-0000-0000000000c3',
  dan: '00000000-0000-0000-0000-0000000000c4',
};
const names = { [ids.ana]: 'Ana', [ids.ben]: 'Ben', [ids.cat]: 'Cat', [ids.dan]: 'Dan' };

let podId;

const rpc = (uid, sql, params) => t.asUser(uid, () => t.db.query(sql, params));

const createActivity = (host, { auto = false, visibility = 'pod' } = {}) =>
  t.asUser(
    host,
    async () =>
      (
        await t.one(
          `select public.create_activity($1, $2, 'Session', 'Study', '{}',
             now() + interval '1 hour', now() + interval '3 hours', 5, $3, $4) as id`,
          [podId, names[host], visibility, auto],
        )
      ).id,
  );

const sendPodMessage = (uid, message) =>
  rpc(
    uid,
    `insert into public.messages (pod_id, sender_id, sender_name, message) values ($1, $2, $3, $4)`,
    [podId, uid, names[uid], message],
  );

const chatRecipients = async () => {
  const { rows } = await t.db.query(
    `select recipient_ids from public.notification_outbox where type = 'chat_message'`,
  );
  return rows.flatMap((r) => r.recipient_ids).sort();
};

before(async () => {
  t = await createTestDb();
  for (const [key, id] of Object.entries(ids)) {
    await t.signUp(id, `${key}@bu.edu`, { display_name: names[id] });
  }
  podId = await t.asUser(
    ids.ana,
    async () =>
      (await t.one(`select public.create_pod('Study crew', '', 'Study', 'public', null) as id`)).id,
  );
  for (const uid of [ids.ben, ids.cat, ids.dan]) {
    await rpc(uid, `select public.join_pod($1)`, [podId]);
  }
});

after(async () => {
  await t?.db.close();
});

beforeEach(async () => {
  await t.db.exec(
    `delete from public.notification_outbox; delete from public.pod_mutes; delete from public.blocks;`,
  );
});

test('a chat message does not notify someone who has a block with the sender', async () => {
  await rpc(ids.ben, `select public.block_user($1)`, [ids.ana]);
  await t.db.exec(`delete from public.notification_outbox`);

  await sendPodMessage(ids.ana, 'Library at 7?');
  // Ben blocked Ana: only Cat and Dan hear about it.
  assert.deepEqual(await chatRecipients(), [ids.cat, ids.dan].sort());

  // And the other direction: Ben's message does not reach Ana.
  await t.db.exec(`delete from public.notification_outbox`);
  await sendPodMessage(ids.ben, 'I am in');
  assert.deepEqual(await chatRecipients(), [ids.cat, ids.dan].sort());
});

test('mute and block both apply to the same chat message', async () => {
  await rpc(ids.ben, `select public.block_user($1)`, [ids.ana]);
  await rpc(ids.cat, `select public.set_pod_mute($1, true)`, [podId]);
  await t.db.exec(`delete from public.notification_outbox`);

  await sendPodMessage(ids.ana, 'Room 204');
  assert.deepEqual(await chatRecipients(), [ids.dan]);
});

test('request_join_activity enforces the block check and the ended check together', async () => {
  const open = await createActivity(ids.ana, { auto: true });
  const ended = await createActivity(ids.ana, { auto: true });
  await t.db.query(
    `update public.activities set expires_at = now() - interval '1 minute' where id = $1`,
    [ended],
  );

  // Not blocked: an ended activity is refused for that reason.
  await assert.rejects(
    rpc(ids.cat, `select public.request_join_activity($1)`, [ended]),
    /has ended/,
  );

  // Blocked: refused as "not found", ended or not, and nobody was added.
  await rpc(ids.ben, `select public.block_user($1)`, [ids.ana]);
  await assert.rejects(
    rpc(ids.ben, `select public.request_join_activity($1)`, [open]),
    /Activity not found/,
  );
  await assert.rejects(
    rpc(ids.ben, `select public.request_join_activity($1)`, [ended]),
    /Activity not found/,
  );
  const { participants } = await t.one(`select participants from public.activities where id = $1`, [
    open,
  ]);
  assert.deepEqual(participants, [ids.ana]);

  await t.db.query(`delete from public.activities where id = any ($1)`, [[open, ended]]);
});

test('deleting an account also clears its blocks, mutes and tokens; reports survive anonymised', async () => {
  const gone = '00000000-0000-0000-0000-0000000000c9';
  await t.signUp(gone, 'gone@bu.edu', { display_name: 'Gone' });
  await rpc(gone, `select public.join_pod($1)`, [podId]);
  await rpc(gone, `select public.block_user($1)`, [ids.ana]);
  await rpc(ids.ben, `select public.block_user($1)`, [gone]);
  await rpc(gone, `select public.set_pod_mute($1, true)`, [podId]);
  await rpc(gone, `select public.register_push_token($1, 'ios')`, [
    'ExponentPushToken[gonegonegonegonegonego]',
  ]);
  await rpc(gone, `select public.report_content('user', $1, 'spam', 'by the leaver')`, [ids.cat]);
  await rpc(ids.cat, `select public.report_content('user', $1, 'harassment', 'about the leaver')`, [
    gone,
  ]);

  await t.asService(() => t.db.query(`select public.delete_account_data($1)`, [gone]));
  await t.db.query(`delete from auth.users where id = $1`, [gone]);

  // No uuid / uuid[] column in the public schema still holds the id, except
  // in a report *about* them (reported_user_id, and target_id for a 'user'
  // report), which is a moderation record kept on purpose.
  const { rows: columns } = await t.db.query(
    `select table_name, column_name, udt_name from information_schema.columns
      where table_schema = 'public' and udt_name in ('uuid', '_uuid')`,
  );
  const leftovers = [];
  for (const { table_name, column_name, udt_name } of columns) {
    if (table_name === 'reports' && ['reported_user_id', 'target_id'].includes(column_name)) {
      continue;
    }
    const where = udt_name === '_uuid' ? `$1 = any ("${column_name}")` : `"${column_name}" = $1`;
    const { rows } = await t.db.query(
      `select count(*)::int as c from public."${table_name}" where ${where}`,
      [gone],
    );
    if (rows[0].c > 0) leftovers.push(`${table_name}.${column_name}`);
  }
  assert.deepEqual(leftovers, []);

  // The report they filed is kept without their id; the one about them is kept.
  const filed = await t.one(
    `select reporter_id from public.reports where details = 'by the leaver'`,
  );
  assert.equal(filed.reporter_id, null);
  const about = await t.one(
    `select reported_user_id from public.reports where details = 'about the leaver'`,
  );
  assert.equal(about.reported_user_id, gone);

  // The pod is intact for everyone else.
  const pod = await t.one(`select members, member_count from public.pods where id = $1`, [podId]);
  assert.ok(!pod.members.includes(gone));
  assert.equal(pod.member_count, pod.members.length);
});

test('emails are readable only by the owner path and by pod-mates', async () => {
  // Direct reads of the column are refused for everyone, including yourself.
  await assert.rejects(
    rpc(ids.cat, `select email from public.profiles where id = $1`, [ids.dan]),
    /permission denied/,
  );
  await assert.rejects(rpc(ids.cat, `select * from public.profiles`), /permission denied/);
  // The rest of a profile is still readable.
  const { rows } = await rpc(
    ids.cat,
    `select display_name, university from public.profiles where id = $1`,
    [ids.dan],
  );
  assert.deepEqual(rows, [{ display_name: 'Dan', university: 'Boston University' }]);

  // Pod-mates get each other's emails through the RPC.
  const mates = await rpc(ids.cat, `select * from public.get_pod_member_emails($1)`, [podId]);
  const byId = Object.fromEntries(mates.rows.map((r) => [r.profile_id, r.email]));
  assert.equal(byId[ids.dan], 'dan@bu.edu');
  assert.equal(byId[ids.cat], 'cat@bu.edu');

  // Someone outside the pod gets nothing.
  const outsider = '00000000-0000-0000-0000-0000000000c8';
  await t.signUp(outsider, 'outsider@harvard.edu', { display_name: 'Out' });
  await assert.rejects(
    rpc(outsider, `select * from public.get_pod_member_emails($1)`, [podId]),
    /Only pod members/,
  );

  // A block hides the pair's emails from each other, not from the rest.
  await rpc(ids.ben, `select public.block_user($1)`, [ids.ana]);
  const forAna = await rpc(ids.ana, `select * from public.get_pod_member_emails($1)`, [podId]);
  const anaSees = forAna.rows.map((r) => r.profile_id);
  assert.ok(!anaSees.includes(ids.ben));
  assert.ok(anaSees.includes(ids.cat) && anaSees.includes(ids.ana));
});
