import {
  ANDROID_CHANNEL_ID,
  buildContent,
  buildPushJobs,
  chunk,
  ClaimedNotification,
  EXPO_MAX_BATCH,
  ExpoPushMessage,
  interpretTickets,
  isExpoPushToken,
} from '../supabase/functions/_shared/push';

const token = (s: string) => `ExponentPushToken[${s}]`;

const row = (overrides: Partial<ClaimedNotification> = {}): ClaimedNotification => ({
  id: 'n1',
  type: 'join_request',
  activity_id: 'act-1',
  pod_id: 'pod-1',
  payload: { activityTitle: 'Library grind', actorName: 'Milo' },
  tokens: [token('a')],
  ...overrides,
});

const message = (to: string): ExpoPushMessage => ({
  to,
  title: 't',
  body: 'b',
  data: { type: 'join_request' },
  sound: 'default',
  channelId: ANDROID_CHANNEL_ID,
});

describe('buildContent', () => {
  it('writes a message for each event type', () => {
    const cases: [string, string, string][] = [
      ['join_request', 'New join request', 'Milo wants to join "Library grind"'],
      ['participant_joined', 'New participant', 'Milo joined "Library grind"'],
      ['request_approved', "You're in!", 'Your request to join "Library grind" was approved'],
      ['request_declined', 'Request declined', 'Your request to join "Library grind" was declined'],
    ];
    for (const [type, title, body] of cases) {
      expect(buildContent(row({ type }))).toMatchObject({ title, body });
    }
    expect(
      buildContent(
        row({
          type: 'new_activity',
          payload: { activityTitle: 'PS3', podName: 'CS 330', actorName: 'Hana' },
        }),
      ),
    ).toMatchObject({ title: 'New in CS 330', body: 'Hana posted "PS3"' });
  });

  it('carries the type and ids in data for deep links', () => {
    expect(buildContent(row())?.data).toEqual({
      type: 'join_request',
      activityId: 'act-1',
      podId: 'pod-1',
    });
    expect(buildContent(row({ activity_id: null, pod_id: null }))?.data).toEqual({
      type: 'join_request',
    });
  });

  it('falls back when payload text is missing and truncates long text', () => {
    expect(buildContent(row({ payload: null }))?.body).toBe('Someone wants to join "an activity"');
    const long = 'x'.repeat(500);
    const content = buildContent(row({ payload: { activityTitle: long, actorName: long } }));
    expect(content!.body.length).toBeLessThanOrEqual(160);
    expect(content!.body).toContain('…');
  });

  it('ignores unknown types', () => {
    expect(buildContent(row({ type: 'chat_message' }))).toBeNull();
  });
});

describe('buildPushJobs', () => {
  it('makes one message per valid, distinct token and keeps the outbox id', () => {
    const jobs = buildPushJobs([
      row({ id: 'n1', tokens: [token('a'), token('a'), 'garbage', 'ExpoPushToken[b]'] }),
      row({ id: 'n2', tokens: [] }),
      row({ id: 'n3', tokens: null }),
      row({ id: 'n4', type: 'unknown', tokens: [token('c')] }),
    ]);
    expect(jobs.map((j) => [j.outboxId, j.message.to])).toEqual([
      ['n1', token('a')],
      ['n1', 'ExpoPushToken[b]'],
    ]);
    expect(jobs[0].message).toMatchObject({ sound: 'default', channelId: ANDROID_CHANNEL_ID });
  });
});

describe('chunk', () => {
  it('splits into batches of at most 100', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const batches = chunk(items);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(items);
    expect(EXPO_MAX_BATCH).toBe(100);
    expect(chunk([])).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('interpretTickets', () => {
  const sent = [message(token('ok')), message(token('gone')), message(token('big'))];

  it('collects DeviceNotRegistered tokens and other errors', () => {
    const result = interpretTickets(sent, {
      data: [
        { status: 'ok', id: 'ticket-1' },
        {
          status: 'error',
          message: '"ExponentPushToken[gone]" is not a registered push notification recipient',
          details: { error: 'DeviceNotRegistered' },
        },
        { status: 'error', message: 'Message too big', details: { error: 'MessageTooBig' } },
      ],
    });
    expect(result).toEqual({
      deadTokens: [token('gone')],
      errors: [{ token: token('big'), message: 'MessageTooBig: Message too big' }],
      failed: false,
    });
  });

  it('marks the batch failed when the reply does not match the request', () => {
    expect(interpretTickets(sent, null).failed).toBe(true);
    expect(
      interpretTickets(sent, { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] }).failed,
    ).toBe(true);
    expect(interpretTickets(sent, { data: [{ status: 'ok' }] }).failed).toBe(true);
  });
});

describe('isExpoPushToken', () => {
  it('accepts Expo tokens only', () => {
    expect(isExpoPushToken(token('abc'))).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc]')).toBe(true);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
    expect(isExpoPushToken('fcm-device-token')).toBe(false);
  });
});
