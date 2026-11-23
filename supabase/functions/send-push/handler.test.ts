// Runs the real send-push handler with `fetch` stubbed: the Supabase calls
// (claim RPC, token delete, outbox updates) and the Expo Push API request are
// exercised end to end without any network.
//
//   cd supabase/functions && deno test --allow-env

import assert from 'node:assert/strict';
import { handler } from './handler.ts';

const SUPABASE_URL = 'https://test.supabase.co';
const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_DEAD = 'ExponentPushToken[dddddddddddddddddddddd]';

interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
  apikey: string | null;
}

interface World {
  /** Rows handed out by successive claim_push_notifications calls. */
  claims: unknown[][];
  expoStatus: number;
  /** Builds Expo's reply from the messages it was sent. */
  expoReply: (messages: { to: string }[]) => unknown;
  calls: Call[];
  expoRequests: { to: string; title: string; data: Record<string, unknown> }[][];
}

function install(world: World): () => void {
  const original = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    const body: unknown = text ? JSON.parse(text) : null;

    if (url.origin === 'https://exp.host') {
      const messages = body as { to: string; title: string; data: Record<string, unknown> }[];
      world.expoRequests.push(messages);
      return json(world.expoReply(messages), world.expoStatus);
    }
    if (url.origin === SUPABASE_URL) {
      world.calls.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        body,
        apikey: req.headers.get('apikey'),
      });
      if (url.pathname === '/rest/v1/rpc/claim_push_notifications') {
        return json(world.claims.shift() ?? []);
      }
      if (
        url.pathname === '/rest/v1/push_tokens' ||
        url.pathname === '/rest/v1/notification_outbox'
      ) {
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected fetch in test: ${req.method} ${req.url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

const allOk = (messages: { to: string }[]) => ({ data: messages.map(() => ({ status: 'ok' })) });

function newWorld(claims: unknown[][]): World {
  return { claims, expoStatus: 200, expoReply: allOk, calls: [], expoRequests: [] };
}

function setEnv() {
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  Deno.env.set('PUSH_WEBHOOK_SECRET', 'shh');
  Deno.env.delete('EXPO_ACCESS_TOKEN');
}

const call = (secret?: string, method = 'POST') =>
  handler(
    new Request('https://fn/send-push', {
      method,
      headers: secret ? { 'x-push-secret': secret } : {},
      body: method === 'POST' ? '{}' : undefined,
    }),
  );

const joinRequest = (id: string, tokens: string[]) => ({
  id,
  type: 'join_request',
  activity_id: 'act-1',
  pod_id: 'pod-1',
  payload: { actor_name: 'Carol', activity_title: 'Library grind' },
  tokens,
});

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test('rejects a missing or wrong secret before touching the database', opts, async () => {
  const world = newWorld([[joinRequest('n1', [TOKEN_A])]]);
  const restore = install(world);
  setEnv();
  try {
    assert.equal((await call()).status, 401);
    assert.equal((await call('wrong')).status, 401);
    assert.equal((await call('shh', 'GET')).status, 405);
    assert.equal(world.calls.length, 0);
    assert.equal(world.expoRequests.length, 0);
  } finally {
    restore();
  }
});

Deno.test('fails closed when the secret is not configured', opts, async () => {
  const world = newWorld([]);
  const restore = install(world);
  setEnv();
  Deno.env.delete('PUSH_WEBHOOK_SECRET');
  try {
    assert.equal((await call('')).status, 500);
    assert.equal(world.calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test('sends claimed notifications to Expo and marks them sent', opts, async () => {
  const world = newWorld([[joinRequest('n1', [TOKEN_A])]]);
  const restore = install(world);
  setEnv();
  try {
    const res = await call('shh');
    assert.equal(res.status, 200);
    const totals = await res.json();
    assert.equal(totals.notifications, 1);
    assert.equal(totals.messages, 1);
    assert.equal(totals.retry, 0);

    assert.equal(world.expoRequests.length, 1);
    const [message] = world.expoRequests[0];
    assert.equal(message.to, TOKEN_A);
    assert.equal(message.data.type, 'join_request');
    assert.equal(message.data.activityId, 'act-1');
    assert.ok(message.title.length > 0);

    const marked = world.calls.find((c) => c.path === '/rest/v1/notification_outbox');
    assert.ok(marked, 'outbox row should be updated');
    assert.equal(marked.method, 'PATCH');
    assert.ok(marked.query.includes('n1'));
    assert.ok((marked.body as { sent_at?: string }).sent_at);
    // Everything goes through the service role key.
    assert.ok(world.calls.every((c) => c.apikey === 'service-key'));
  } finally {
    restore();
  }
});

Deno.test('deletes tokens Expo reports as DeviceNotRegistered', opts, async () => {
  const world = newWorld([[joinRequest('n1', [TOKEN_A, TOKEN_DEAD])]]);
  world.expoReply = (messages) => ({
    data: messages.map((m) =>
      m.to === TOKEN_DEAD
        ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok' },
    ),
  });
  const restore = install(world);
  setEnv();
  try {
    const totals = await (await call('shh')).json();
    assert.equal(totals.deadTokens, 1);
    const del = world.calls.find((c) => c.path === '/rest/v1/push_tokens');
    assert.ok(del);
    assert.equal(del.method, 'DELETE');
    assert.ok(decodeURIComponent(del.query).includes(TOKEN_DEAD));
    assert.ok(!decodeURIComponent(del.query).includes(TOKEN_A));
  } finally {
    restore();
  }
});

Deno.test('leaves rows unsent for retry when Expo is down', opts, async () => {
  const world = newWorld([[joinRequest('n1', [TOKEN_A])]]);
  world.expoStatus = 503;
  world.expoReply = () => ({ errors: [{ message: 'unavailable' }] });
  const restore = install(world);
  setEnv();
  try {
    const totals = await (await call('shh')).json();
    assert.equal(totals.messages, 0);
    assert.equal(totals.retry, 1);
    const updates = world.calls.filter((c) => c.path === '/rest/v1/notification_outbox');
    assert.equal(updates.length, 1);
    const body = updates[0].body as { sent_at?: string; last_error?: string };
    assert.equal(body.sent_at, undefined, 'a failed row must not be marked sent');
    assert.ok(body.last_error);
  } finally {
    restore();
  }
});

Deno.test('a notification with no tokens is marked sent without calling Expo', opts, async () => {
  const world = newWorld([[joinRequest('n1', [])]]);
  const restore = install(world);
  setEnv();
  try {
    const totals = await (await call('shh')).json();
    assert.equal(totals.notifications, 1);
    assert.equal(world.expoRequests.length, 0);
    const marked = world.calls.find((c) => c.path === '/rest/v1/notification_outbox');
    assert.ok(marked && (marked.body as { sent_at?: string }).sent_at);
  } finally {
    restore();
  }
});
