import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
  writeBatch,
  Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import { Message } from '../types';

// Chat lives in the `messages` Firestore collection. Each document carries
// either activityId (activity group chat) or podId (pod group chat).
// Security rules (firestore.rules) restrict reads/writes to participants.
const MESSAGES_COLLECTION = 'messages';
const PAGE_SIZE = 50;

function toMessage(id: string, data: Record<string, any>): Message {
  return {
    messageId: id,
    activityId: data.activityId,
    podId: data.podId,
    senderId: data.senderId,
    senderName: data.senderName,
    message: data.message,
    timestamp: data.timestamp,
  };
}

// ---------- Activity chat ----------

export async function sendMessage(
  activityId: string,
  senderId: string,
  senderName: string,
  message: string
): Promise<void> {
  await addDoc(collection(db, MESSAGES_COLLECTION), {
    activityId,
    senderId,
    senderName,
    message,
    timestamp: Date.now(),
  });
}

export function subscribeToMessages(
  activityId: string,
  callback: (messages: Message[]) => void
): Unsubscribe {
  const q = query(
    collection(db, MESSAGES_COLLECTION),
    where('activityId', '==', activityId),
    orderBy('timestamp', 'desc'),
    limit(PAGE_SIZE)
  );
  return onSnapshot(q, (snapshot) => {
    const messages = snapshot.docs.map((d) => toMessage(d.id, d.data()));
    messages.reverse(); // chronological order for display
    callback(messages);
  });
}

// ---------- Pod chat ----------

export async function sendPodMessage(
  podId: string,
  senderId: string,
  senderName: string,
  message: string
): Promise<void> {
  await addDoc(collection(db, MESSAGES_COLLECTION), {
    podId,
    senderId,
    senderName,
    message,
    timestamp: Date.now(),
  });
}

export function subscribeToPodMessages(
  podId: string,
  callback: (messages: Message[]) => void
): Unsubscribe {
  const q = query(
    collection(db, MESSAGES_COLLECTION),
    where('podId', '==', podId),
    orderBy('timestamp', 'desc'),
    limit(PAGE_SIZE)
  );
  return onSnapshot(q, (snapshot) => {
    const messages = snapshot.docs.map((d) => toMessage(d.id, d.data()));
    messages.reverse(); // chronological order for display
    callback(messages);
  });
}

// ---------- Cleanup (expiry / deletion) ----------

async function deleteMessagesWhere(
  field: 'activityId' | 'podId',
  value: string
): Promise<void> {
  const snap = await getDocs(
    query(collection(db, MESSAGES_COLLECTION), where(field, '==', value))
  );
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

/** Delete all chat messages for an activity (used when it expires or is deleted). */
export async function deleteActivityMessages(activityId: string): Promise<void> {
  await deleteMessagesWhere('activityId', activityId);
}

/** Delete all chat messages for a pod (used when the pod is deleted). */
export async function deletePodMessages(podId: string): Promise<void> {
  await deleteMessagesWhere('podId', podId);
}
