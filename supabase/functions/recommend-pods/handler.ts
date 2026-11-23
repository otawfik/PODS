// Request handler for recommend-pods (see index.ts for the overview).
// Kept separate from Deno.serve so handler.test.ts can call it directly.

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0';
import {
  buildClaudeRequest,
  cacheDecision,
  heuristicRank,
  RECOMMENDATION_MODEL,
  signalsKey,
  parseClaudeRanking,
  pickCandidates,
  type CachedRanking,
  type CandidatePod,
  type Recommendation,
  type StudentSignals,
} from '../_shared/recommend.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PodRow = {
  id: string;
  name: string;
  description: string;
  category: string;
  member_count: number;
  creator: { university: string } | null;
};

const toCandidate = (r: PodRow): CandidatePod => ({
  podId: r.id,
  name: r.name,
  description: r.description,
  category: r.category,
  memberCount: r.member_count,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function rankWithClaude(
  apiKey: string,
  model: string,
  student: StudentSignals,
  candidates: CandidatePod[],
): Promise<Recommendation[]> {
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
  const response = await client.beta.messages.create(
    buildClaudeRequest(student, candidates, model),
  );
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    console.warn('recommend-pods: unusable stop_reason', response.stop_reason);
    return [];
  }
  const text = response.content.find((b) => b.type === 'text');
  return text && text.type === 'text' ? parseClaudeRanking(text.text, candidates) : [];
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in' }, 401);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return json({ error: 'Not signed in' }, 401);

  // --- Load the student's signals (RLS applies) ---------------------------
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('university, major, bio, interests, pods_joined')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return json({ error: 'Profile not found' }, 404);

  const podFields =
    'id, name, description, category, member_count, creator:profiles!created_by(university)';
  const joinedIds: string[] = profile.pods_joined ?? [];
  const [{ data: joinedRows }, { data: publicRows, error: podsError }] = await Promise.all([
    joinedIds.length
      ? supabase.from('pods').select(podFields).in('id', joinedIds)
      : Promise.resolve({ data: [] as PodRow[] }),
    supabase
      .from('pods')
      .select(podFields)
      .eq('visibility', 'public')
      .order('member_count', { ascending: false })
      .limit(300),
  ]);
  if (podsError) return json({ error: podsError.message }, 500);

  const student: StudentSignals = {
    university: profile.university ?? '',
    major: profile.major ?? '',
    bio: profile.bio ?? '',
    interests: profile.interests ?? [],
    joinedPods: ((joinedRows ?? []) as unknown as PodRow[]).map(toCandidate),
  };

  // Prefer pods started by students at the same university; pods have no
  // university column yet (v1 schema adds pods.university_id).
  const all = (publicRows ?? []) as unknown as PodRow[];
  const sameCampus = all.filter((r) => r.creator?.university === student.university);
  const pool = (sameCampus.length ? sameCampus : all).map(toCandidate);
  const candidates = pickCandidates(student, pool);
  if (candidates.length === 0) return json({ recommendations: [], source: 'none' });

  // --- Rank: cache → Claude → heuristic ----------------------------------
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json({ recommendations: heuristicRank(student, candidates), source: 'heuristic' });
  }
  const model = Deno.env.get('RECOMMENDATION_MODEL') || RECOMMENDATION_MODEL;
  const offered = new Set(candidates.map((c) => c.podId));
  const key = await sha256(signalsKey(student, model));

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data: cacheRow, error: cacheError } = await admin
    .from('pod_recommendations')
    .select('signals_key, created_at, recommendations')
    .eq('profile_id', auth.user.id)
    .maybeSingle();
  if (cacheError) console.error('recommend-pods: cache read failed', cacheError.message);
  const cached: CachedRanking | null = cacheRow
    ? {
        signalsKey: cacheRow.signals_key,
        createdAt: cacheRow.created_at,
        recommendations: cacheRow.recommendations ?? [],
      }
    : null;

  const decision = cacheDecision(cached, key, Date.now());
  if (decision === 'hit' && cached) {
    // Drop pods that were deleted, went private or were joined since.
    const still = cached.recommendations.filter((r) => offered.has(r.podId));
    if (still.length) return json({ recommendations: still, source: 'claude', cached: true });
  }

  let recommendations: Recommendation[] = [];
  if (decision === 'recompute') {
    try {
      recommendations = await rankWithClaude(apiKey, model, student, candidates);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) console.warn('recommend-pods: rate limited');
      else if (err instanceof Anthropic.APIError)
        console.error('recommend-pods: API error', err.status, err.message);
      else console.error('recommend-pods: unexpected error', err);
    }
    // Record every model attempt (even an empty one) so the cooldown applies.
    const { error: writeError } = await admin.from('pod_recommendations').upsert({
      profile_id: auth.user.id,
      signals_key: key,
      model,
      recommendations,
      created_at: new Date().toISOString(),
    });
    if (writeError) console.error('recommend-pods: cache write failed', writeError.message);
  }
  if (recommendations.length === 0) recommendations = heuristicRank(student, candidates);

  return json({ recommendations, source: recommendations[0]?.source ?? 'none' });
}
