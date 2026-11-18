import {
  buildClaudeRequest,
  buildUserMessage,
  CandidatePod,
  heuristicRank,
  MAX_RESULTS,
  parseClaudeRanking,
  pickCandidates,
  RECOMMENDATION_MODEL,
  StudentSignals,
} from '../supabase/functions/_shared/recommend';

const pod = (
  podId: string,
  name: string,
  category: string,
  description = '',
  memberCount = 5,
): CandidatePod => ({
  podId,
  name,
  description,
  category,
  memberCount,
});

const catalog: CandidatePod[] = [
  pod('climb', 'Bouldering Crew', 'Sports', 'Climbing gym sessions on weekends', 12),
  pod('cs330', 'CS 330 Algorithms Study', 'Study', 'Problem sets and exam prep for algorithms', 8),
  pod('hoops', 'Pickup Basketball', 'Sports', 'Casual basketball at the rec center', 40),
  pod('ramen', 'Ramen Run', 'Food', 'Trying every ramen spot in town', 15),
];

const student: StudentSignals = {
  university: 'Boston University',
  major: 'Computer Science',
  bio: 'I like climbing and algorithms',
  interests: ['Climbing', 'Algorithms'],
  joinedPods: [pod('chess', 'Chess Club', 'Social')],
};

describe('heuristic ranking', () => {
  it('puts interest matches above merely popular pods', () => {
    const ranked = heuristicRank(student, catalog).map((r) => r.podId);
    expect(ranked.slice(0, 2).sort()).toEqual(['climb', 'cs330']);
    expect(ranked.indexOf('hoops')).toBeGreaterThan(1);
  });

  it('marks results as heuristic and caps the count', () => {
    const many = Array.from({ length: 20 }, (_, i) => pod(`p${i}`, `Pod ${i}`, 'Social'));
    const ranked = heuristicRank(student, many);
    expect(ranked).toHaveLength(MAX_RESULTS);
    expect(ranked.every((r) => r.source === 'heuristic')).toBe(true);
  });
});

describe('pickCandidates', () => {
  it('excludes pods the student already joined and respects the cap', () => {
    const withJoined = [...catalog, pod('chess', 'Chess Club', 'Social')];
    const picked = pickCandidates(student, withJoined, 3);
    expect(picked).toHaveLength(3);
    expect(picked.map((p) => p.podId)).not.toContain('chess');
  });
});

describe('Claude request', () => {
  it('uses the configured model, a JSON schema, and no assistant prefill', () => {
    const req = buildClaudeRequest(student, catalog);
    expect(req.model).toBe(RECOMMENDATION_MODEL);
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
  });

  it('sends pod ids and interests but no names or emails of people', () => {
    const msg = buildUserMessage(student, catalog);
    for (const p of catalog) expect(msg).toContain(p.podId);
    expect(msg).toContain('Climbing');
    expect(msg).not.toMatch(/@/);
  });

  it('clips very long user-written text', () => {
    const long = pod('long', 'x'.repeat(500), 'Social', 'y'.repeat(5000));
    const msg = buildUserMessage(student, [long]);
    expect(msg.length).toBeLessThan(2000);
  });
});

describe('parseClaudeRanking', () => {
  it('keeps offered ids in order with their reasons', () => {
    const text = JSON.stringify({
      recommendations: [
        { pod_id: 'cs330', reason: 'Matches your algorithms interest.' },
        { pod_id: 'climb', reason: 'You like climbing.' },
      ],
    });
    expect(parseClaudeRanking(text, catalog)).toEqual([
      { podId: 'cs330', reason: 'Matches your algorithms interest.', source: 'claude' },
      { podId: 'climb', reason: 'You like climbing.', source: 'claude' },
    ]);
  });

  it('drops hallucinated ids, duplicates and empty reasons', () => {
    const text = JSON.stringify({
      recommendations: [
        { pod_id: 'made-up', reason: 'Not a real pod' },
        { pod_id: 'climb', reason: 'Climbing!' },
        { pod_id: 'climb', reason: 'Again' },
        { pod_id: 'ramen', reason: '' },
      ],
    });
    expect(parseClaudeRanking(text, catalog).map((r) => r.podId)).toEqual(['climb']);
  });

  it('returns [] for malformed output', () => {
    expect(parseClaudeRanking('not json', catalog)).toEqual([]);
    expect(parseClaudeRanking('{"foo": 1}', catalog)).toEqual([]);
  });
});
