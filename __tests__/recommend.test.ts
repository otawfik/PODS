import {
  buildClaudeRequest,
  CACHE_TTL_MS,
  cacheDecision,
  buildUserMessage,
  CandidatePod,
  heuristicRank,
  MAX_RESULTS,
  parseClaudeRanking,
  pickCandidates,
  RECOMMENDATION_MODEL,
  RECOMPUTE_COOLDOWN_MS,
  signalsKey,
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

describe('heuristic reasons and filler', () => {
  it('matches word variants and says why', () => {
    const [top] = heuristicRank({ ...student, interests: ['Climb'], bio: '', major: '' }, catalog);
    expect(top.podId).toBe('climb');
    expect(top.reason).toBe('Matches "climb" from your profile');
  });

  it('does not pad with unrelated pods once three match', () => {
    const three = [
      pod('a', 'Climbing A', 'Sports'),
      pod('b', 'Climbing B', 'Sports'),
      pod('c', 'Climbing C', 'Sports'),
      pod('z', 'Huge Unrelated', 'Food', '', 999),
    ];
    const ranked = heuristicRank(
      { ...student, interests: ['Climbing'], bio: '', major: '', joinedPods: [] },
      three,
    );
    expect(ranked.map((r) => r.podId)).not.toContain('z');
  });

  it('fills with popular pods for a student with no signals', () => {
    const blank = { ...student, interests: [], bio: '', major: '', joinedPods: [] };
    const ranked = heuristicRank(blank, catalog);
    expect(ranked).toHaveLength(3);
    expect(ranked[0].podId).toBe('hoops');
    expect(ranked[0].reason).toMatch(/^Popular/);
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

describe('model choice', () => {
  it('asks for server-side fallback on Opus but not on Haiku', () => {
    const opus = buildClaudeRequest(student, catalog, 'claude-opus-5-5');
    expect(opus).toMatchObject({
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    const haiku = buildClaudeRequest(student, catalog, 'claude-haiku-5-5');
    expect(haiku.model).toBe('claude-haiku-5-5');
    expect(haiku).not.toHaveProperty('fallbacks');
    expect(haiku).not.toHaveProperty('betas');
  });
});

describe('recommendation cache', () => {
  const key = signalsKey(student, RECOMMENDATION_MODEL);
  const now = Date.parse('2026-11-18T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const recs = [{ podId: 'climb', reason: 'Climbing!', source: 'claude' as const }];

  it('ignores interest order and case, but not content or model', () => {
    const shuffled = { ...student, interests: ['algorithms', 'CLIMBING'] };
    expect(signalsKey(shuffled, RECOMMENDATION_MODEL)).toBe(key);
    expect(signalsKey({ ...student, interests: ['Chess'] }, RECOMMENDATION_MODEL)).not.toBe(key);
    expect(signalsKey(student, 'claude-haiku-5-5')).not.toBe(key);
  });

  it('serves a fresh cache with the same signals', () => {
    expect(
      cacheDecision({ signalsKey: key, createdAt: ago(60_000), recommendations: recs }, key, now),
    ).toBe('hit');
  });

  it('recomputes when the cache is stale, empty, or missing', () => {
    expect(cacheDecision(null, key, now)).toBe('recompute');
    expect(
      cacheDecision(
        { signalsKey: key, createdAt: ago(CACHE_TTL_MS + 1), recommendations: recs },
        key,
        now,
      ),
    ).toBe('recompute');
    expect(
      cacheDecision({ signalsKey: key, createdAt: ago(60_000), recommendations: [] }, key, now),
    ).toBe('recompute');
  });

  it('enforces the cooldown when signals change quickly', () => {
    const recent = {
      signalsKey: 'old',
      createdAt: ago(RECOMPUTE_COOLDOWN_MS - 1000),
      recommendations: recs,
    };
    expect(cacheDecision(recent, key, now)).toBe('cooldown');
    const older = { ...recent, createdAt: ago(RECOMPUTE_COOLDOWN_MS + 1000) };
    expect(cacheDecision(older, key, now)).toBe('recompute');
  });
});
