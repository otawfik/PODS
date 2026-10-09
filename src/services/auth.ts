import type { User as SupabaseUser } from '@supabase/supabase-js';
import { supabase, check } from './supabase';
import { User } from '../types';
import { getUniversityFromEmail } from '../constants/categories';

// ---------- Row mapping (Postgres snake_case <-> app camelCase) ----------

export type ProfileRow = {
  id: string;
  display_name: string;
  email: string;
  university: string;
  profile_photo: string | null;
  bio: string | null;
  join_date: string;
  pods_joined: string[];
  commendations: number;
  posts_count: number;
};

export function toUser(row: ProfileRow): User {
  return {
    uid: row.id,
    displayName: row.display_name,
    email: row.email,
    university: row.university,
    profilePhoto: row.profile_photo ?? undefined,
    bio: row.bio ?? undefined,
    joinDate: row.join_date,
    podsJoined: row.pods_joined ?? [],
    commendations: row.commendations,
    postsCount: row.posts_count,
  };
}

/** Thrown by loginUser when the account exists but the email isn't verified yet. */
export class EmailNotConfirmedError extends Error {
  constructor(public email: string) {
    super('Please verify your email. We sent you a new code.');
    this.name = 'EmailNotConfirmedError';
  }
}

// ---------- Sign up / verification ----------

/**
 * Create the account. Supabase emails a verification code; the user is not
 * signed in until they enter it (see verifyEmailCode). The profile row is
 * created server-side by the on_auth_user_created trigger.
 */
export async function registerUser(
  email: string,
  password: string,
  displayName: string
): Promise<void> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName, university: getUniversityFromEmail(email) },
    },
  });
  if (error) throw new Error(error.message);
  // With email confirmation on, signing up an already-registered address
  // returns a placeholder user with no identities instead of an error.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    throw new Error('An account with this email already exists. Log in instead.');
  }
}

/** Confirm the sign-up with the code from the email. Signs the user in. */
export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const token = code.trim();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (!error) return;
  // Older auth servers only accept sign-up codes under the 'signup' type.
  const { error: legacyError } = await supabase.auth.verifyOtp({ email, token, type: 'signup' });
  if (legacyError) throw new Error(error.message);
}

/** Send (or re-send) the sign-up verification code. */
export async function resendVerificationCode(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({ type: 'signup', email });
  if (error) throw new Error(error.message);
}

// ---------- Sign in / out ----------

export async function loginUser(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) return;
  if (error.code === 'email_not_confirmed') {
    await resendVerificationCode(email).catch(() => {});
    throw new EmailNotConfirmedError(email);
  }
  throw new Error(error.message);
}

export async function logoutUser(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

// ---------- Password reset (code-based) ----------

/** Email a password-reset code to the address. */
export async function sendPasswordResetCode(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw new Error(error.message);
}

/** Verify the reset code, then set the new password. Leaves the user signed in. */
export async function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string
): Promise<void> {
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email,
    token: code.trim(),
    type: 'recovery',
  });
  if (verifyError) throw new Error(verifyError.message);
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

// ---------- Profiles ----------

/**
 * Self-heal: if a user is authed but their profile row is missing, create a
 * minimal one instead of leaving the app in a permanent loading state.
 */
export async function ensureUserProfile(authUser: SupabaseUser): Promise<User> {
  const existing = await getUserProfile(authUser.id);
  if (existing) return existing;
  const email = authUser.email ?? '';
  const meta = (authUser.user_metadata ?? {}) as { display_name?: string };
  const row = check(
    await supabase
      .from('profiles')
      .upsert(
        {
          id: authUser.id,
          display_name: meta.display_name || 'Member',
          email,
          university: getUniversityFromEmail(email),
        },
        { onConflict: 'id' }
      )
      .select()
      .single()
  );
  return toUser(row as ProfileRow);
}

export async function getUserProfile(uid: string): Promise<User | null> {
  const row = check(await supabase.from('profiles').select('*').eq('id', uid).maybeSingle());
  return row ? toUser(row as ProfileRow) : null;
}

export async function updateUserProfile(uid: string, updates: Partial<User>): Promise<void> {
  const row: Partial<ProfileRow> = {};
  if (updates.displayName !== undefined) row.display_name = updates.displayName;
  if (updates.email !== undefined) row.email = updates.email;
  if (updates.university !== undefined) row.university = updates.university;
  if (updates.profilePhoto !== undefined) row.profile_photo = updates.profilePhoto;
  if (updates.bio !== undefined) row.bio = updates.bio;
  if (updates.podsJoined !== undefined) row.pods_joined = updates.podsJoined;
  if (updates.commendations !== undefined) row.commendations = updates.commendations;
  if (updates.postsCount !== undefined) row.posts_count = updates.postsCount;
  if (Object.keys(row).length > 0) {
    check(await supabase.from('profiles').update(row).eq('id', uid));
  }
  // Keep the auth user's metadata in sync with the display name.
  if (updates.displayName !== undefined) {
    const { data } = await supabase.auth.getUser();
    if (data.user?.id === uid) {
      await supabase.auth.updateUser({ data: { display_name: updates.displayName } });
    }
  }
}
