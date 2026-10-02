import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  increment,
  query,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import { Pod, PodCategory } from '../types';
import { deletePodMessages } from './chat';

/** Short, unambiguous invite code (no 0/O, 1/I/L). */
export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function createPod(
  data: Omit<Pod, 'podId' | 'createdAt' | 'memberCount' | 'members' | 'admins' | 'inviteCode'>,
  userId: string
): Promise<string> {
  const inviteCode = generateInviteCode();
  const ref = await addDoc(collection(db, 'pods'), {
    ...data,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    memberCount: 1,
    members: [userId],
    admins: [userId],
    inviteCode,
  });
  await updateDoc(ref, { podId: ref.id });

  // Mirror code -> podId so "join with code" works without exposing
  // private pod documents (see firestore.rules).
  await setDoc(doc(db, 'podInvites', inviteCode), {
    podId: ref.id,
    createdAt: new Date().toISOString(),
  });

  // Add pod to user's joined list
  await updateDoc(doc(db, 'users', userId), {
    podsJoined: arrayUnion(ref.id),
  });

  return ref.id;
}

export async function getPod(podId: string): Promise<Pod | null> {
  const snap = await getDoc(doc(db, 'pods', podId));
  return snap.exists() ? (snap.data() as Pod) : null;
}

export async function getPublicPods(): Promise<Pod[]> {
  const q = query(
    collection(db, 'pods'),
    where('visibility', '==', 'public')
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data() as Pod)
    .sort((a, b) => b.memberCount - a.memberCount);
}

export async function getUserPods(podIds: string[]): Promise<Pod[]> {
  if (podIds.length === 0) return [];
  const pods: Pod[] = [];
  for (const id of podIds) {
    const p = await getPod(id);
    if (p) pods.push(p);
  }
  return pods;
}

export async function joinPod(podId: string, userId: string, inviteCode?: string): Promise<void> {
  const podRef = doc(db, 'pods', podId);
  const snap = await getDoc(podRef);
  if (!snap.exists()) throw new Error('Pod not found');
  const pod = snap.data() as Pod;
  // Already a member: arrayUnion would dedupe the uid but a naive
  // read-then-write counter would still double-count. Bail out early.
  if (pod.members.includes(userId)) return;
  // Private pods require the invite code (pods created before invite codes
  // existed have none stored and remain joinable).
  if (pod.visibility === 'private' && pod.inviteCode) {
    const attempt = (inviteCode ?? '').trim().toUpperCase();
    if (!attempt || attempt !== pod.inviteCode.toUpperCase()) {
      throw new Error('This pod is private. Enter a valid invite code to join.');
    }
  }
  await updateDoc(podRef, {
    members: arrayUnion(userId),
    memberCount: increment(1),
  });
  await updateDoc(doc(db, 'users', userId), {
    podsJoined: arrayUnion(podId),
  });
}

/**
 * Join a (possibly private) pod with an invite code. Resolves the code via
 * the podInvites collection so private pod documents stay unreadable to
 * non-members (enforced by firestore.rules).
 */
export async function joinPodWithCode(code: string, userId: string): Promise<string> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error('Enter an invite code');
  const inviteSnap = await getDoc(doc(db, 'podInvites', normalized));
  if (!inviteSnap.exists()) throw new Error('Invalid invite code');
  const podId = (inviteSnap.data() as { podId: string }).podId;

  // Already a member? Check the user's own doc (readable) instead of the
  // pod doc (not readable for private pods).
  const userSnap = await getDoc(doc(db, 'users', userId));
  const joined: string[] = userSnap.data()?.podsJoined ?? [];
  if (joined.includes(podId)) throw new Error('You are already a member of this pod');

  // arrayUnion dedupes members; the code itself was the authorization.
  // Security rules restrict this update to self-only membership changes.
  await updateDoc(doc(db, 'pods', podId), {
    members: arrayUnion(userId),
    memberCount: increment(1),
  });
  await updateDoc(doc(db, 'users', userId), {
    podsJoined: arrayUnion(podId),
  });
  return podId;
}

export async function leavePod(podId: string, userId: string): Promise<void> {
  const podRef = doc(db, 'pods', podId);
  const snap = await getDoc(podRef);
  if (!snap.exists()) return;
  const pod = snap.data() as Pod;
  if (!pod.members.includes(userId)) return;
  // Never strand a pod without admins.
  if (pod.admins.includes(userId) && pod.admins.length === 1) {
    throw new Error(
      'You are the last admin. Grant admin to another member or delete the pod instead.'
    );
  }
  await updateDoc(podRef, {
    members: arrayRemove(userId),
    admins: arrayRemove(userId),
    memberCount: increment(-1),
  });
  await updateDoc(doc(db, 'users', userId), {
    podsJoined: arrayRemove(podId),
  });
}

export async function grantAdmin(podId: string, userId: string): Promise<void> {
  await updateDoc(doc(db, 'pods', podId), {
    admins: arrayUnion(userId),
  });
}

export async function removeAdmin(podId: string, userId: string): Promise<void> {
  await updateDoc(doc(db, 'pods', podId), {
    admins: arrayRemove(userId),
  });
}

export interface PodUpdates {
  name?: string;
  description?: string;
  category?: PodCategory;
  bannerColor?: string;
}

/** Edit pod metadata. Admins only (mirrored in firestore.rules). */
export async function updatePod(podId: string, userId: string, updates: PodUpdates): Promise<void> {
  const pod = await getPod(podId);
  if (!pod) throw new Error('Pod not found');
  if (!pod.admins.includes(userId)) throw new Error('Only admins can edit this pod');
  const allowed: Record<string, string> = {};
  if (updates.name !== undefined && updates.name.trim()) allowed.name = updates.name.trim();
  if (updates.description !== undefined && updates.description.trim()) {
    allowed.description = updates.description.trim();
  }
  if (updates.category !== undefined) allowed.category = updates.category;
  if (updates.bannerColor !== undefined) allowed.bannerColor = updates.bannerColor;
  if (Object.keys(allowed).length === 0) return;
  await updateDoc(doc(db, 'pods', podId), allowed);
}

/**
 * Delete a pod and everything under it: its activities, its chat messages,
 * and its invite code. Admins only (mirrored in firestore.rules).
 * Members' podsJoined lists are cleaned opportunistically on next load
 * (see removePodsFromUser) since rules only let users edit their own doc.
 */
export async function deletePod(podId: string, userId: string): Promise<void> {
  const pod = await getPod(podId);
  if (!pod) return;
  if (!pod.admins.includes(userId)) throw new Error('Only admins can delete this pod');

  // Delete the pod's activities and their chat messages. Security rules
  // permit pod admins to delete activities in their pod.
  const activitiesSnap = await getDocs(
    query(collection(db, 'activities'), where('podId', '==', podId))
  );
  for (const activityDoc of activitiesSnap.docs) {
    await deleteActivityMessages(activityDoc.id).catch(() => {});
    await deleteDoc(activityDoc.ref).catch(() => {});
  }

  await deletePodMessages(podId).catch(() => {});
  if (pod.inviteCode) {
    await deleteDoc(doc(db, 'podInvites', pod.inviteCode)).catch(() => {});
  }
  await deleteDoc(doc(db, 'pods', podId));
  await updateDoc(doc(db, 'users', userId), {
    podsJoined: arrayRemove(podId),
  }).catch(() => {});
}

/**
 * Remove pod IDs that no longer exist from a user's podsJoined list
 * (e.g. after a pod was deleted). Call after loading the user's pods.
 */
export async function removePodsFromUser(userId: string, podIds: string[]): Promise<void> {
  if (podIds.length === 0) return;
  const userRef = doc(db, 'users', userId);
  for (const podId of podIds) {
    await updateDoc(userRef, { podsJoined: arrayRemove(podId) });
  }
}

export async function searchPods(searchTerm: string): Promise<Pod[]> {
  const all = await getPublicPods();
  const term = searchTerm.toLowerCase();
  return all.filter(
    (p) =>
      p.name.toLowerCase().includes(term) ||
      p.description.toLowerCase().includes(term) ||
      p.category.toLowerCase().includes(term)
  );
}
