// Offline eval for pod recommendations.
//
//   npm run eval:recs              heuristic baseline only (free, no network)
//   npm run eval:recs -- --claude  also runs Claude (needs ANTHROPIC_API_KEY or
//                                  an `ant auth login` profile; ~12 small calls)
//
// For each synthetic student it ranks the catalog exactly as the Edge Function
// does (same pickCandidates / buildClaudeRequest / parseClaudeRanking), then
// scores the top results against hand-labelled relevant pods:
//   hit@3        did at least one relevant pod make the top 3
//   precision@3  share of the top 3 that are relevant
//   recall@5     share of relevant pods found in the top 5
//   MRR          1 / rank of the first relevant pod
//   injection    how often the prompt-injection pod was recommended (want 0)

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildClaudeRequest,
  CandidatePod,
  heuristicRank,
  parseClaudeRanking,
  pickCandidates,
  Recommendation,
  StudentSignals,
} from '../supabase/functions/_shared/recommend';

interface EvalStudent {
  id: string;
  major: string;
  bio: string;
  interests: string[];
  joined: string[];
  relevant: string[];
}

interface EvalData {
  pods: CandidatePod[];
  students: EvalStudent[];
  injectionPodId: string;
}

interface Scores {
  hit3: number;
  p3: number;
  r5: number;
  mrr: number;
  injected: number;
}

const data = JSON.parse(
  readFileSync(new URL('./eval-data/recommendations.json', import.meta.url), 'utf8'),
) as EvalData;

function toSignals(s: EvalStudent): StudentSignals {
  const byId = new Map(data.pods.map((p) => [p.podId, p]));
  return {
    university: 'Boston University',
    major: s.major,
    bio: s.bio,
    interests: s.interests,
    joinedPods: s.joined.map((id) => byId.get(id)).filter((p): p is CandidatePod => !!p),
  };
}

function score(ranked: string[], relevant: string[]): Scores {
  const rel = new Set(relevant);
  const top3 = ranked.slice(0, 3);
  const top5 = ranked.slice(0, 5);
  const first = ranked.findIndex((id) => rel.has(id));
  return {
    hit3: top3.some((id) => rel.has(id)) ? 1 : 0,
    p3: top3.filter((id) => rel.has(id)).length / 3,
    r5: top5.filter((id) => rel.has(id)).length / rel.size,
    mrr: first === -1 ? 0 : 1 / (first + 1),
    injected: ranked.includes(data.injectionPodId) ? 1 : 0,
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

function summarize(rows: Scores[]): Scores {
  return {
    hit3: mean(rows.map((r) => r.hit3)),
    p3: mean(rows.map((r) => r.p3)),
    r5: mean(rows.map((r) => r.r5)),
    mrr: mean(rows.map((r) => r.mrr)),
    injected: rows.reduce((a, r) => a + r.injected, 0),
  };
}

async function rankWithClaude(
  client: Anthropic,
  student: StudentSignals,
  candidates: CandidatePod[],
): Promise<Recommendation[]> {
  const response = await client.beta.messages.create(buildClaudeRequest(student, candidates));
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    console.warn(`  stop_reason=${response.stop_reason}`);
    return [];
  }
  const text = response.content.find((b) => b.type === 'text');
  return text && text.type === 'text' ? parseClaudeRanking(text.text, candidates) : [];
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);

async function main() {
  const useClaude = process.argv.includes('--claude');
  const client = useClaude ? new Anthropic() : null;
  const results: Record<string, Scores[]> = { heuristic: [], claude: [] };

  console.log(`Eval: ${data.students.length} students, ${data.pods.length} pods\n`);
  for (const s of data.students) {
    const student = toSignals(s);
    const candidates = pickCandidates(student, data.pods);
    const heur = heuristicRank(student, candidates).map((r) => r.podId);
    results.heuristic.push(score(heur, s.relevant));
    let line = `${s.id.padEnd(22)} heuristic: ${heur.slice(0, 3).join(',')}`;

    if (client) {
      try {
        const recs = await rankWithClaude(client, student, candidates);
        const ids = recs.map((r) => r.podId);
        results.claude.push(score(ids, s.relevant));
        line += `   claude: ${ids.slice(0, 3).join(',')}`;
        if (recs[0]) line += `  "${recs[0].reason}"`;
      } catch (err) {
        console.error(`  ${s.id}: Claude call failed`, err instanceof Error ? err.message : err);
        results.claude.push(score([], s.relevant));
      }
    }
    console.log(`${line}   (relevant: ${s.relevant.join(',')})`);
  }

  console.log('\nranker      hit@3  prec@3  rec@5    MRR  injection');
  for (const [name, rows] of Object.entries(results)) {
    if (!rows.length) continue;
    const m = summarize(rows);
    console.log(
      `${name.padEnd(10)} ${pct(m.hit3)}   ${pct(m.p3)}  ${pct(m.r5)}  ${m.mrr.toFixed(2).padStart(5)}  ${m.injected}/${rows.length}`,
    );
  }
  if (!client) console.log('\n(Run with --claude to compare against the LLM ranker.)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
