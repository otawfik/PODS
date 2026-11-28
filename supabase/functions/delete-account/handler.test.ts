// Runs the real handler with `fetch` stubbed, so the Supabase SDK calls are
// exercised end to end without any network.
//
//   cd supabase/functions && deno test --allow-env

import assert from 'node:assert/strict';
import { handler } from './handler.ts';

const SUPABASE_URL = 'https://test.supabase.co';
const USER_ID = '00000000-0000-0000-0000-00000000000a';

interface Call {
  step: 'getUser' | 'cleanup' | 'authDelete';
  apikey: string;
  authorization: string;
  body?: unknown;
}

interface World {
  calls: Call[];
  cleanupStatus: number;
  authDeleteStatus: number;
}

function install(world: World): () => void {
  const original = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const call = (step: Call['step'], body?: unknown) =>
      world.calls.push({
        step,
        apikey: req.headers.get('apikey') ?? '',
        authorization: req.headers.get('authorization') ?? '',
        body,
      });

    if (url.origin !== SUPABASE_URL) throw new Error(`Unexpected fetch in test: ${req.url}`);
    if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
      call('getUser');
      return req.headers.get('authorization') === 'Bearer good'
        ? json({ id: USER_ID, aud: 'authenticated', email: 'a@bu.edu' })
        : json({ msg: 'invalid JWT' }, 401);
    }
    if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/delete_account_data') {
      call('cleanup', await req.json());
      return world.cleanupStatus === 200
        ? json({ pods_left: 1 })
        : json({ message: 'boom', code: 'P0001' }, world.cleanupStatus);
    }
    if (req.method === 'DELETE' && url.pathname === `/auth/v1/admin/users/${USER_ID}`) {
      call('authDelete');
      return world.authDeleteStatus === 200
        ? json({})
        : json({ msg: 'Database error deleting user' }, world.authDeleteStatus);
    }
    throw new Error(`Unexpected fetch in test: ${req.method} ${req.url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

const newWorld = (): World => ({ calls: [], cleanupStatus: 200, authDeleteStatus: 200 });

function setEnv() {
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
}

const post = (token: string | undefined, body: string) =>
  handler(
    new Request('https://fn/delete-account', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    }),
  );

const CONFIRMED = JSON.stringify({ confirm: 'DELETE' });
const steps = (world: World) => world.calls.map((c) => c.step);

// The SDK clients keep timers/connections the default sanitizers flag.
const opts = { sanitizeOps: false, sanitizeResources: false };

/** Run `fn` against a stubbed world. */
async function withWorld(world: World, fn: () => Promise<void>) {
  const restore = install(world);
  setEnv();
  try {
    await fn();
  } finally {
    restore();
  }
}

Deno.test('401 without a JWT or with an invalid one; nothing is deleted', opts, async () => {
  const world = newWorld();
  await withWorld(world, async () => {
    assert.equal((await post(undefined, CONFIRMED)).status, 401);
    assert.deepEqual(steps(world), []);
    assert.equal((await post('forged', CONFIRMED)).status, 401);
    assert.deepEqual(steps(world), ['getUser']);
  });
});

Deno.test('400 without the confirmation value; nothing is deleted', opts, async () => {
  const world = newWorld();
  await withWorld(world, async () => {
    const bodies = ['{}', '', 'not json', '{"confirm":"delete"}', '{"confirm":true}', '"DELETE"'];
    for (const body of bodies) {
      const res = await post('good', body);
      assert.equal(res.status, 400, `body ${body}`);
      assert.match((await res.json()).error, /confirm/);
    }
    assert.ok(steps(world).every((s) => s === 'getUser'));
  });
});

Deno.test('happy path: cleanup, then auth delete, both with the service key', opts, async () => {
  const world = newWorld();
  await withWorld(world, async () => {
    // A user id in the body is ignored: the id comes from the JWT.
    const res = await post('good', JSON.stringify({ confirm: 'DELETE', user_id: 'someone-else' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true });

    assert.deepEqual(steps(world), ['getUser', 'cleanup', 'authDelete']);
    const [getUser, cleanup, authDelete] = world.calls;
    assert.equal(getUser.apikey, 'anon-key');
    assert.equal(getUser.authorization, 'Bearer good');
    assert.deepEqual(cleanup.body, { p_user_id: USER_ID });
    for (const call of [cleanup, authDelete]) {
      assert.equal(call.apikey, 'service-key');
      assert.equal(call.authorization, 'Bearer service-key');
    }
  });
});

Deno.test('cleanup failure: 500 and the auth user is not deleted', opts, async () => {
  const world = newWorld();
  world.cleanupStatus = 500;
  await withWorld(world, async () => {
    const res = await post('good', CONFIRMED);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /Nothing was removed/);
    assert.deepEqual(steps(world), ['getUser', 'cleanup']);
  });
});

Deno.test('auth delete failure: 500, and a retry runs both steps again', opts, async () => {
  const world = newWorld();
  world.authDeleteStatus = 500;
  await withWorld(world, async () => {
    const res = await post('good', CONFIRMED);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /try again/);

    world.authDeleteStatus = 200;
    assert.equal((await post('good', CONFIRMED)).status, 200);
    assert.deepEqual(steps(world).slice(-3), ['getUser', 'cleanup', 'authDelete']);
  });
});

Deno.test('only POST (and the CORS preflight) is accepted', opts, async () => {
  const world = newWorld();
  await withWorld(world, async () => {
    const get = await handler(new Request('https://fn/delete-account', { method: 'GET' }));
    assert.equal(get.status, 405);
    const preflight = await handler(
      new Request('https://fn/delete-account', { method: 'OPTIONS' }),
    );
    assert.equal(preflight.status, 200);
    assert.deepEqual(steps(world), []);
  });
});
