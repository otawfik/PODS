import { supabase, check } from './supabase';
import { Message } from '../types';

// Chat lives in the `messages` table. Each row carries either activity_id
// (activity group chat) or pod_id (pod group chat). Row Level Security
// restricts reads/writes to participants; realtime pushes new rows live.
const PAGE_SIZE = 50;

export type Unsubscribe = () => void;

type MessageRow = {
  id: string;
  activity_id: string | null;
  pod_id: string | null;
  sender_id: string;
  sender_name: string;
  message: string;
  created_at: string;
};

function toMessage(row: MessageRow): Message {
  return {
    messageId: row.id,
    activityId: row.activity_id ?? undefined,
    podId: row.pod_id ?? undefined,
    senderId: row.sender_id,
    senderName: row.sender_name,
    message: row.message,
    timestamp: new Date(row.created_at).getTime(),
  };
}

type Room = { column: 'activity_id' | 'pod_id'; id: string };

async function fetchLatest(room: Room): Promise<Message[]> {
  const rows = check(
    await supabase
      .from('messages')
      .select('*')
      .eq(room.column, room.id)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE),
  );
  return (rows as MessageRow[]).map(toMessage).reverse(); // chronological for display
}

/**
 * Live view of the latest PAGE_SIZE messages in a room. Calls back with the
 * full list on load and after every change, like a Firestore snapshot.
 */
function subscribeToRoom(room: Room, callback: (messages: Message[]) => void): Unsubscribe {
  let closed = false;
  let latestRequest = 0;

  const refresh = () => {
    const requestId = ++latestRequest;
    fetchLatest(room)
      .then((messages) => {
        // Ignore stale responses that finish after a newer one.
        if (!closed && requestId === latestRequest) callback(messages);
      })
      .catch((err) => console.warn('Chat load failed', err));
  };

  const channel = supabase
    .channel(`messages:${room.column}:${room.id}:${Date.now()}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `${room.column}=eq.${room.id}`,
      },
      refresh,
    )
    // Deletes can't be filtered server-side; refetching is cheap.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, refresh)
    .subscribe((status) => {
      // (Re)load once the channel is live so nothing sent in between is missed.
      if (status === 'SUBSCRIBED') refresh();
    });

  refresh();

  return () => {
    closed = true;
    supabase.removeChannel(channel);
  };
}

async function insertMessage(row: Omit<MessageRow, 'id' | 'created_at'>): Promise<void> {
  check(await supabase.from('messages').insert(row));
}

// ---------- Activity chat ----------

export async function sendMessage(
  activityId: string,
  senderId: string,
  senderName: string,
  message: string,
): Promise<void> {
  await insertMessage({
    activity_id: activityId,
    pod_id: null,
    sender_id: senderId,
    sender_name: senderName,
    message,
  });
}

export function subscribeToMessages(
  activityId: string,
  callback: (messages: Message[]) => void,
): Unsubscribe {
  return subscribeToRoom({ column: 'activity_id', id: activityId }, callback);
}

// ---------- Pod chat ----------

export async function sendPodMessage(
  podId: string,
  senderId: string,
  senderName: string,
  message: string,
): Promise<void> {
  await insertMessage({
    activity_id: null,
    pod_id: podId,
    sender_id: senderId,
    sender_name: senderName,
    message,
  });
}

export function subscribeToPodMessages(
  podId: string,
  callback: (messages: Message[]) => void,
): Unsubscribe {
  return subscribeToRoom({ column: 'pod_id', id: podId }, callback);
}

// Message cleanup on expiry/deletion now happens in the database
// (expire_activity_if_needed and ON DELETE CASCADE), so there are no
// client-side delete helpers anymore.

// ---------- Messages list ----------

export interface ChatPreview {
  activityId: string;
  senderId: string;
  senderName: string;
  message: string;
  timestamp: number;
}

/** The latest message in each of the given activity chats, keyed by activity id. */
export async function getChatPreviews(activityIds: string[]): Promise<Record<string, ChatPreview>> {
  if (activityIds.length === 0) return {};
  const rows = check(await supabase.rpc('get_chat_previews', { p_activity_ids: activityIds }));
  const byId: Record<string, ChatPreview> = {};
  for (const row of (rows ?? []) as Omit<MessageRow, 'id' | 'pod_id'>[]) {
    if (!row.activity_id) continue;
    byId[row.activity_id] = {
      activityId: row.activity_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      message: row.message,
      timestamp: new Date(row.created_at).getTime(),
    };
  }
  return byId;
}
