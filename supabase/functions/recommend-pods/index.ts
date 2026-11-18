// Supabase Edge Function: POST /functions/v1/recommend-pods
//
// Ranks open public pods for the signed-in student with Claude, falling back
// to a keyword heuristic when the model is unavailable.
//
// Runs on Deno at Supabase's edge. Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy recommend-pods
//
// Security: the database client is created with the caller's JWT, so Row
// Level Security decides what the function can read (the same rows the app
// can read). The Anthropic key never leaves the server.

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0';
import {
  buildClaudeRequest,
  heuristicRank,
  parseClaudeRanking,
  pickCandidates,
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

async function rankWithClaude(
  student: StudentSignals,
  candidates: CandidatePod[],
): Promise<Recommendation[]> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return [];
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
  const response = await client.beta.messages.create(buildClaudeRequest(student, candidates));
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    console.warn('recommend-pods: unusable stop_reason', response.stop_reason);
    return [];
  }
  const text = response.content.find((b) => b.type === 'text');
  return text && text.type === 'text' ? parseClaudeRanking(text.text, candidates) : [];
}

Deno.serve(async (req) => {
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

  // --- Rank: Claude first, heuristic fallback ------------------------------
  let recommendations: Recommendation[] = [];
  try {
    recommendations = await rankWithClaude(student, candidates);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn('recommend-pods: rate limited');
    else if (err instanceof Anthropic.APIError)
      console.error('recommend-pods: API error', err.status, err.message);
    else console.error('recommend-pods: unexpected error', err);
  }
  if (recommendations.length === 0) recommendations = heuristicRank(student, candidates);

  return json({ recommendations, source: recommendations[0]?.source ?? 'none' });
});
