import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  deleteUser,
  sendEmailVerification,
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { User } from '../types';
import { getUniversityFromEmail } from '../constants/categories';

export async function registerUser(
  email: string,
  password: string,
  displayName: string
): Promise<User> {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  try {
    await updateProfile(credential.user, { displayName });

    const university = getUniversityFromEmail(email);
    const userData: User = {
      uid: credential.user.uid,
      displayName,
      email,
      university,
      joinDate: new Date().toISOString(),
      podsJoined: [],
      commendations: 0,
      postsCount: 0,
    };

    await setDoc(doc(db, 'users', credential.user.uid), userData);
    return userData;
  } catch (err) {
    // setDoc/updateProfile failed after the auth account was created —
    // delete it so we don't strand an authed user with no profile doc.
    await deleteUser(credential.user).catch(() => {});
    throw err;
  }
}

/** Send (or re-send) the verification email to the current user. */
export async function sendVerificationEmail(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('No signed-in user');
  await sendEmailVerification(user);
}

/**
 * Self-heal: if a user is authed but their Firestore profile doc is missing
 * (e.g. setDoc failed mid-register on an older build), create a minimal one
 * instead of leaving the app in a permanent loading state.
 */
export async function ensureUserProfile(
  fbUser: { uid: string; displayName: string | null; email: string | null }
): Promise<User> {
  const existing = await getUserProfile(fbUser.uid);
  if (existing) return existing;
  const email = fbUser.email ?? '';
  const minimal: User = {
    uid: fbUser.uid,
    displayName: fbUser.displayName ?? 'Member',
    email,
    university: getUniversityFromEmail(email),
    joinDate: new Date().toISOString(),
    podsJoined: [],
    commendations: 0,
    postsCount: 0,
  };
  await setDoc(doc(db, 'users', fbUser.uid), minimal);
  return minimal;
}

export async function loginUser(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export async function getUserProfile(uid: string): Promise<User | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? (snap.data() as User) : null;
}

export async function updateUserProfile(uid: string, updates: Partial<User>): Promise<void> {
  await setDoc(doc(db, 'users', uid), updates, { merge: true });
}
