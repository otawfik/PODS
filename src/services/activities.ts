import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  arrayUnion,
  arrayRemove,
  increment,
  runTransaction,
  query,
  where,
  orderBy,
} from 'firebase/firestore';
import { db } from './firebase';
import { Activity } from '../types';
import { getUserProfile } from './auth';

export async function createActivity(
  data: Omit<Activity, 'activityId' | 'currentParticipants' | 'participants' | 'pendingRequests' | 'status' | 'university'>,
  userId: string
): Promise<string> {
  // Only pod members can post activities into a pod.
  const podSnap = await getDoc(doc(db, 'pods', data.podId));
  const podMembers: string[] = podSnap.data()?.members ?? [];
  if (!podSnap.exists() || !podMembers.includes(userId)) {
    throw new Error('You must be a pod member to post an activity');
  }

  // Stamp the creator's university so university-wide discovery can query it.
  const profile = await getUserProfile(userId);
  const university = profile?.university ?? 'Unknown University';

  const ref = await addDoc(collection(db, 'activities'), {
    ...data,
    university,
    hostId: userId,
    currentParticipants: 1,
    participants: [userId],
    pendingRequests: [],
    status: 'active',
  });
  await updateDoc(ref, { activityId: ref.id });

  // Update host's postsCount atomically.
  await updateDoc(doc(db, 'users', userId), {
    postsCount: increment(1),
  });

  return ref.id;
}

export async function getActivity(activityId: string): Promise<Activity | null> {
  const snap = await getDoc(doc(db, 'activities', activityId));
  if (!snap.exists()) return null;
  const data = snap.data() as Activity;
  // Auto-expire check
  if (data.status === 'active' && new Date(data.expiresAt) < new Date()) {
    await updateDoc(doc(db, 'activities', activityId), { status: 'expired' });
    data.status = 'expired';
  }
  return data;
}

export async function getActivitiesForPod(podId: string): Promise<Activity[]> {
  const q = query(
    collection(db, 'activities'),
    where('podId', '==', podId)
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data() as Activity)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

export async function getActivitiesForPods(podIds: string[]): Promise<Activity[]> {
  if (podIds.length === 0) return [];
  const activities: Activity[] = [];
  for (const podId of podIds) {
    const podActivities = await getActivitiesForPod(podId);
    activities.push(...podActivities);
  }
  return activities.sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
}

/**
 * University-wide discovery: activities marked university-visible at the
 * given university, regardless of pod membership. Requires the composite
 * index in firestore.indexes.json (deployed via firebase.json).
 */
export async function getUniversityActivities(university: string): Promise<Activity[]> {
  if (!university) return [];
  const q = query(
    collection(db, 'activities'),
    where('visibility', '==', 'university'),
    where('university', '==', university),
    where('status', '==', 'active')
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data() as Activity)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

export async function requestJoinActivity(activityId: string, userId: string): Promise<void> {
  const activity = await getActivity(activityId);
  if (!activity) throw new Error('Activity not found');

  if (activity.autoApprove) {
    await approveJoinRequest(activityId, userId);
    return;
  }

  await updateDoc(doc(db, 'activities', activityId), {
    pendingRequests: arrayUnion(userId),
  });
}

export async function approveJoinRequest(activityId: string, userId: string): Promise<void> {
  const activityRef = doc(db, 'activities', activityId);
  // Transaction: re-check capacity atomically so two hosts approving at the
  // same time can't overfill the activity.
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(activityRef);
    if (!snap.exists()) throw new Error('Activity not found');
    const activity = snap.data() as Activity;
    if (activity.participants.includes(userId)) {
      // Already in — just clear any stale pending request.
      tx.update(activityRef, { pendingRequests: arrayRemove(userId) });
      return;
    }
    if (activity.currentParticipants >= activity.maxParticipants) {
      throw new Error('Activity is full');
    }
    tx.update(activityRef, {
      participants: arrayUnion(userId),
      pendingRequests: arrayRemove(userId),
      currentParticipants: increment(1),
    });
  });
}

export async function rejectJoinRequest(activityId: string, userId: string): Promise<void> {
  await updateDoc(doc(db, 'activities', activityId), {
    pendingRequests: arrayRemove(userId),
  });
}

export async function leaveActivity(activityId: string, userId: string): Promise<void> {
  const activity = await getActivity(activityId);
  if (!activity) return;

  await updateDoc(doc(db, 'activities', activityId), {
    participants: arrayRemove(userId),
    currentParticipants: Math.max(0, activity.currentParticipants - 1),
  });
}
