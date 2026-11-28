// Push notifications: the pure, runtime-agnostic half of send-push.
//
// No imports, so it runs unchanged in the Edge Function (Deno,
// supabase/functions/send-push) and in Jest (__tests__/push.test.ts).
//
// Flow: the function claims outbox rows (claim_push_notifications) →
// buildPushJobs() turns them into Expo messages → chunk() splits them into
// requests of at most 100 → interpretTickets() reads Expo's reply, collecting
// tokens to delete (DeviceNotRegistered) and outbox ids to retry.

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
export const EXPO_MAX_BATCH = 100;
/** Android channel the app creates (src/services/notifications.ts). */
export const ANDROID_CHANNEL_ID = 'default';

export type NotificationType =
  | 'join_request'
  | 'participant_joined'
  | 'request_approved'
  | 'request_declined'
  | 'new_activity'
  | 'chat_message';

/** A row returned by public.claim_push_notifications. */
export interface ClaimedNotification {
  id: string;
  type: string;
  activity_id: string | null;
  pod_id: string | null;
  payload: Record<string, unknown> | null;
  tokens: string[] | null;
}

/**
 * Sent as the notification's `data`; the app turns it into a screen to open
 * (src/navigation/linking.ts). A chat_message carries activityId for an
 * activity chat, or only podId for a pod chat.
 */
export interface PushData {
  type: NotificationType;
  activityId?: string;
  podId?: string;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: PushData;
  sound: 'default';
  channelId: string;
}

/** One message plus the outbox row it came from. */
export interface PushJob {
  outboxId: string;
  message: ExpoPushMessage;
}

export interface TicketResult {
  /** Tokens Expo says are no longer valid: delete them. */
  deadTokens: string[];
  /** Other per-message errors (logged, not retried). */
  errors: { token: string; message: string }[];
  /** True when the reply could not be matched to the request: retry it. */
  failed: boolean;
}

const MAX_TITLE = 60;
const MAX_BODY = 160;
/** Chat text shown in a push (the database already clips it to 140). */
const MAX_PREVIEW = 100;

const KNOWN_TYPES: readonly NotificationType[] = [
  'join_request',
  'participant_joined',
  'request_approved',
  'request_declined',
  'new_activity',
  'chat_message',
];

export function isNotificationType(value: string): value is NotificationType {
  return (KNOWN_TYPES as readonly string[]).includes(value);
}

export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[.+\]$/.test(token);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function text(payload: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Title, body and data for one outbox row, or null for an unknown type. */
export function buildContent(
  n: Pick<ClaimedNotification, 'type' | 'activity_id' | 'pod_id' | 'payload'>,
): { title: string; body: string; data: PushData } | null {
  if (!isNotificationType(n.type)) return null;
  const activity = `"${truncate(text(n.payload, 'activityTitle', 'an activity'), 60)}"`;
  const actor = truncate(text(n.payload, 'actorName', 'Someone'), 40);
  const pod = truncate(text(n.payload, 'podName', 'your pod'), 40);

  let title: string;
  let body: string;
  switch (n.type) {
    case 'join_request':
      title = 'New join request';
      body = `${actor} wants to join ${activity}`;
      break;
    case 'participant_joined':
      title = 'New participant';
      body = `${actor} joined ${activity}`;
      break;
    case 'request_approved':
      title = "You're in!";
      body = `Your request to join ${activity} was approved`;
      break;
    case 'request_declined':
      title = 'Request declined';
      body = `Your request to join ${activity} was declined`;
      break;
    case 'new_activity':
      title = `New in ${pod}`;
      body = `${actor} posted ${activity}`;
      break;
    case 'chat_message': {
      // Title is the room, like a messaging app: the activity or the pod.
      title = n.activity_id ? truncate(text(n.payload, 'activityTitle', 'Activity chat'), 60) : pod;
      const preview = truncate(text(n.payload, 'preview', 'sent a message'), MAX_PREVIEW);
      body = `${actor}: ${preview}`;
      break;
    }
  }

  const data: PushData = { type: n.type };
  if (n.activity_id) data.activityId = n.activity_id;
  if (n.pod_id) data.podId = n.pod_id;
  return { title: truncate(title, MAX_TITLE), body: truncate(body, MAX_BODY), data };
}

/**
 * One message per (notification, valid token). Rows with an unknown type or
 * no tokens produce no jobs; the caller still marks them sent.
 */
export function buildPushJobs(notifications: ClaimedNotification[]): PushJob[] {
  const jobs: PushJob[] = [];
  for (const n of notifications) {
    const content = buildContent(n);
    if (!content) continue;
    const tokens = new Set((n.tokens ?? []).filter(isExpoPushToken));
    for (const to of tokens) {
      jobs.push({
        outboxId: n.id,
        message: { to, ...content, sound: 'default', channelId: ANDROID_CHANNEL_ID },
      });
    }
  }
  return jobs;
}

export function chunk<T>(items: T[], size = EXPO_MAX_BATCH): T[][] {
  if (size < 1) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read Expo's reply to one request. `body` is the parsed JSON; tickets come
 * back in the same order as the messages sent.
 * https://docs.expo.dev/push-notifications/sending-notifications/#push-tickets
 */
export function interpretTickets(messages: ExpoPushMessage[], body: unknown): TicketResult {
  const result: TicketResult = { deadTokens: [], errors: [], failed: false };
  const tickets = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(tickets) || tickets.length !== messages.length) {
    result.failed = true;
    return result;
  }
  tickets.forEach((ticket, i) => {
    const token = messages[i].to;
    if (!isRecord(ticket) || ticket.status === 'ok') return;
    const details = isRecord(ticket.details) ? ticket.details : {};
    if (details.error === 'DeviceNotRegistered') {
      result.deadTokens.push(token);
      return;
    }
    const message = typeof ticket.message === 'string' ? ticket.message : 'Unknown push error';
    const code = typeof details.error === 'string' ? `${details.error}: ` : '';
    result.errors.push({ token, message: `${code}${message}` });
  });
  return result;
}
