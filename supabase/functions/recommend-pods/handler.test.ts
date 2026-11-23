// Runs the real handler with `fetch` stubbed, so the Supabase and Anthropic
// SDK calls are exercised end to end without any network.
//
//   cd supabase/functions && deno test --allow-env

import assert from 'node:assert/strict';
import { handler } from './handler.ts';

const SUPABASE_URL = 'https://test.supabase.co';
const USER_ID = '00000000-0000-0000-0000-00000000000a';

const pods = [
  {
    id: 'climb',
    name: 'Bouldering Crew',
    description: 'Climbing wall sessions',
    category: 'Sports',
    member_count: 12,
    creator: { university: 'Boston University' },
  },
  {
    id: 'hoops',
    name: 'Pickup Basketball',
    description: 'Casual 5v5',
    category: 'Sports',
    member_count: 40,
    creator: { university: 'Boston University' },
  },
  {
    id: 'other',
    name: 'Harvard Chess',
    description: 'Chess',
    category: 'Social',
    member_count: 99,
    creator: { university: 'Harvard University' },
  },
];

interface World {
  cacheRow: Record<string, unknown> | null;
  anthropicCalls: Record<string, unknown>[];
  anthropicStatus: number;
  anthropicText: string;
  upserts: Record<string, unknown>[];
  keysUsedForCache: string[];
}

function install(world: World): () => void {
  const original = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const wantsObject = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object');

    if (url.origin === SUPABASE_URL && url.pathname === '/auth/v1/user') {
      return req.headers.get('authorization') === 'Bearer good'
        ? json({ id: USER_ID, aud: 'authenticated', email: 'a@bu.edu' })
        : json({ msg: 'invalid JWT' }, 401);
    }
    if (url.origin === SUPABASE_URL && url.pathname === '/rest/v1/profiles') {
      const row = {
        university: 'Boston University',
        major: 'CS',
        bio: '',
        interests: ['Climbing'],
        pods_joined: [],
      };
      return json(wantsObject ? row : [row]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === '/rest/v1/pods') {
      assert.equal(url.searchParams.get('visibility'), 'eq.public');
      return json(pods);
    }
    if (url.origin === SUPABASE_URL && url.pathname === '/rest/v1/pod_recommendations') {
      world.keysUsedForCache.push(req.headers.get('apikey') ?? '');
      if (req.method === 'GET') {
        if (wantsObject) return world.cacheRow ? json(world.cacheRow) : json({}, 406);
        return json(world.cacheRow ? [world.cacheRow] : []);
      }
      const body = await req.json();
      world.upserts.push(body);
      world.cacheRow = body;
      return new Response(null, { status: 201 });
    }
    if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
      world.anthropicCalls.push(await req.json());
      if (world.anthropicStatus !== 200) {
        return json(
          { type: 'error', error: { type: 'api_error', message: 'boom' } },
          world.anthropicStatus,
        );
      }
      return json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: world.anthropicText }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    throw new Error(`Unexpected fetch in test: ${req.method} ${req.url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function newWorld(): World {
  return {
    cacheRow: null,
    anthropicCalls: [],
    anthropicStatus: 200,
    anthropicText: JSON.stringify({
      recommendations: [
        { pod_id: 'climb', reason: 'Matches your interest in climbing.' },
        { pod_id: 'made-up', reason: 'Hallucinated.' },
      ],
    }),
    upserts: [],
    keysUsedForCache: [],
  };
}

function setEnv(withKey: boolean) {
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  Deno.env.delete('RECOMMENDATION_MODEL');
  if (withKey) Deno.env.set('ANTHROPIC_API_KEY', 'sk-ant-test');
  else Deno.env.delete('ANTHROPIC_API_KEY');
}

const call = (token?: string) =>
  handler(
    new Request('https://fn/recommend-pods', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: '{}',
    }),
  );

// The SDK clients keep timers/connections the default sanitizers flag.
const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test('rejects callers without a valid session', opts, async () => {
  const world = newWorld();
  const restore = install(world);
  setEnv(true);
  try {
    assert.equal((await call()).status, 401);
    assert.equal((await call('bad')).status, 401);
    assert.equal(world.anthropicCalls.length, 0);
  } finally {
    restore();
  }
});

Deno.test(
  'without an API key it answers with the free ranker and no model call',
  opts,
  async () => {
    const world = newWorld();
    const restore = install(world);
    setEnv(false);
    try {
      const res = await call('good');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.source, 'heuristic');
      assert.equal(body.recommendations[0].podId, 'climb');
      assert.equal(world.anthropicCalls.length, 0);
      assert.equal(world.upserts.length, 0);
    } finally {
      restore();
    }
  },
);

Deno.test('calls Claude once, drops unknown ids, caches, then serves the cache', opts, async () => {
  const world = newWorld();
  const restore = install(world);
  setEnv(true);
  try {
    const first = await (await call('good')).json();
    assert.deepEqual(first.recommendations, [
      { podId: 'climb', reason: 'Matches your interest in climbing.', source: 'claude' },
    ]);
    assert.equal(world.anthropicCalls.length, 1);

    const sent = world.anthropicCalls[0] as { model: string; messages: { content: string }[] };
    assert.equal(sent.model, 'claude-opus-5-5');
    // Same-campus pods only; the other university's pod is not offered.
    assert.ok(sent.messages[0].content.includes('"climb"'));
    assert.ok(!sent.messages[0].content.includes('Harvard Chess'));

    assert.equal(world.upserts.length, 1);
    assert.equal(world.upserts[0].profile_id, USER_ID);
    // The cache is only ever touched with the service role key.
    assert.ok(world.keysUsedForCache.every((k) => k === 'service-key'));

    const second = await (await call('good')).json();
    assert.equal(second.cached, true);
    assert.deepEqual(second.recommendations, first.recommendations);
    assert.equal(world.anthropicCalls.length, 1, 'cache hit must not call the model');
  } finally {
    restore();
  }
});

Deno.test('uses RECOMMENDATION_MODEL when set (no fallbacks param on Haiku)', opts, async () => {
  const world = newWorld();
  const restore = install(world);
  setEnv(true);
  Deno.env.set('RECOMMENDATION_MODEL', 'claude-haiku-5-5');
  try {
    await call('good');
    const sent = world.anthropicCalls[0];
    assert.equal(sent.model, 'claude-haiku-5-5');
    assert.ok(!('fallbacks' in sent));
  } finally {
    Deno.env.delete('RECOMMENDATION_MODEL');
    restore();
  }
});

Deno.test(
  'falls back to the free ranker when the model errors, and applies the cooldown',
  opts,
  async () => {
    const world = newWorld();
    world.anthropicStatus = 500;
    const restore = install(world);
    setEnv(true);
    try {
      const body = await (await call('good')).json();
      assert.equal(body.source, 'heuristic');
      assert.ok(body.recommendations.length > 0);
      const callsAfterFirst = world.anthropicCalls.length;
      assert.ok(callsAfterFirst >= 1);
      // The failed attempt was recorded, so an immediate retry is not sent to the model.
      assert.equal(world.upserts.length, 1);
      await call('good');
      assert.equal(world.anthropicCalls.length, callsAfterFirst);
    } finally {
      restore();
    }
  },
);
