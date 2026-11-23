// Request handler for send-push (see index.ts for the overview).
// Kept separate from Deno.serve so handler.test.ts can call it directly.

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import {
  buildPushJobs,
  chunk,
  EXPO_PUSH_URL,
  interpretTickets,
  type ClaimedNotification,
} from '../_shared/push.ts';

const CLAIM_LIMIT = 100;
const MAX_ROUNDS = 5;
const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time string comparison for the shared secret. */
function sameSecret(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function postToExpo(
  messages: unknown[],
): Promise<{ ok: boolean; body: unknown; status: number }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const accessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await res.json().catch(() => null);
    return { ok: res.ok, body, status: res.status };
  } catch (err) {
    console.error('send-push: Expo request failed', err);
    return { ok: false, body: null, status: 0 };
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('PUSH_WEBHOOK_SECRET');
  if (!secret) {
    console.error('send-push: PUSH_WEBHOOK_SECRET is not set');
    return json({ error: 'Not configured' }, 500);
  }
  if (!sameSecret(req.headers.get('x-push-secret') ?? '', secret)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const totals = { notifications: 0, messages: 0, deadTokens: 0, retry: 0 };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data, error } = await admin.rpc('claim_push_notifications', { p_limit: CLAIM_LIMIT });
    if (error) {
      console.error('send-push: claim failed', error.message);
      return json({ error: 'Claim failed' }, 500);
    }
    const claimed = (data ?? []) as ClaimedNotification[];
    if (claimed.length === 0) break;
    totals.notifications += claimed.length;

    const jobs = buildPushJobs(claimed);
    const retry = new Set<string>();
    const deadTokens: string[] = [];

    for (const batch of chunk(jobs)) {
      const messages = batch.map((j) => j.message);
      const res = await postToExpo(messages);
      const tickets = res.ok ? interpretTickets(messages, res.body) : null;
      if (!tickets || tickets.failed) {
        console.error('send-push: Expo request not accepted', res.status, JSON.stringify(res.body));
        batch.forEach((j) => retry.add(j.outboxId));
        continue;
      }
      totals.messages += messages.length;
      deadTokens.push(...tickets.deadTokens);
      for (const e of tickets.errors) console.warn('send-push: ticket error', e.message);
    }

    if (deadTokens.length > 0) {
      const { error: delError } = await admin.from('push_tokens').delete().in('token', deadTokens);
      if (delError) console.error('send-push: could not delete dead tokens', delError.message);
      else totals.deadTokens += deadTokens.length;
    }

    // Rows whose Expo request failed keep sent_at null; claim hands them out
    // again when their lease expires (at most 5 attempts).
    const sentIds = claimed.map((n) => n.id).filter((id) => !retry.has(id));
    if (sentIds.length > 0) {
      const { error: markError } = await admin
        .from('notification_outbox')
        .update({ sent_at: new Date().toISOString(), last_error: null })
        .in('id', sentIds);
      if (markError) console.error('send-push: could not mark sent', markError.message);
    }
    if (retry.size > 0) {
      totals.retry += retry.size;
      await admin
        .from('notification_outbox')
        .update({ last_error: 'Expo request failed' })
        .in('id', [...retry]);
    }
    if (claimed.length < CLAIM_LIMIT) break;
  }

  return json(totals);
}
