import type { User as SupabaseUser } from '@supabase/supabase-js';
import { supabase, check } from './supabase';
import { registerForPushNotifications, unregisterPushToken } from './notifications';
import { User } from '../types';

// ---------- Row mapping (Postgres snake_case <-> app camelCase) ----------

export type ProfileRow = {
  id: string;
  display_name: string;
  email: string;
  university: string;
  profile_photo: string | null;
  bio: string | null;
  major: string;
  interests: string[];
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
    major: row.major ?? '',
    interests: row.interests ?? [],
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
  displayName: string,
): Promise<void> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // University is derived from the email on the server (handle_new_user).
    options: { data: { display_name: displayName } },
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
  // While still signed in: stop pushes for this account on this device.
  await unregisterPushToken();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

// ---------- Account deletion ----------

/** What the delete-account function requires as proof of intent. */
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE';

/** The server's own explanation, when a failed function call carries one. */
async function functionErrorMessage(error: {
  message: string;
  context?: unknown;
}): Promise<string> {
  const context = error.context;
  if (context && typeof (context as Response).json === 'function') {
    try {
      const body: unknown = await (context as Response).json();
      const message = (body as { error?: unknown } | null)?.error;
      if (typeof message === 'string' && message) return message;
    } catch {
      // Not JSON: fall through to the generic message.
    }
  }
  return error.message;
}

/**
 * Permanently delete the signed-in user's account through the
 * `delete-account` Edge Function (supabase/functions/delete-account), then
 * clear the local session so the app returns to the sign-in screens.
 * Throws, leaving the user signed in, if the server could not delete it.
 */
export async function deleteAccount(): Promise<void> {
  // While still signed in: stop pushes for this account on this device.
  await unregisterPushToken();
  const { error } = await supabase.functions.invoke<{ deleted: boolean }>('delete-account', {
    method: 'POST',
    body: { confirm: DELETE_ACCOUNT_CONFIRMATION },
  });
  if (error) {
    // The account is still there, so this device should keep getting pushes.
    void registerForPushNotifications({ prompt: false });
    throw new Error(await functionErrorMessage(error));
  }
  // The server-side session died with the account; only local state is left.
  // A failure here must not look like a failed deletion.
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
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
  newPassword: string,
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
 * Self-heal: if a user is authed but their profile row is missing, the
 * server creates a minimal one (ensure_profile) instead of leaving the app in
 * a permanent loading state. Email and university come from the verified
 * auth record, never from the client.
 */
export async function ensureUserProfile(authUser: SupabaseUser): Promise<User> {
  const existing = await getUserProfile(authUser.id);
  if (existing) return existing;
  const row = check(await supabase.rpc('ensure_profile').single());
  return toUser(row as ProfileRow);
}

/**
 * Load several profiles in one query. Missing ids are simply absent from
 * the result, which is keyed by uid.
 */
export async function getUserProfiles(uids: string[]): Promise<Record<string, User>> {
  const unique = [...new Set(uids)];
  if (unique.length === 0) return {};
  const rows = check(await supabase.from('profiles').select('*').in('id', unique));
  const byId: Record<string, User> = {};
  for (const row of rows as ProfileRow[]) byId[row.id] = toUser(row);
  return byId;
}

export async function getUserProfile(uid: string): Promise<User | null> {
  const row = check(await supabase.from('profiles').select('*').eq('id', uid).maybeSingle());
  return row ? toUser(row as ProfileRow) : null;
}

/** The profile fields a user may edit. Identity columns are server-owned. */
export type EditableProfile = Partial<
  Pick<User, 'displayName' | 'bio' | 'profilePhoto' | 'major' | 'interests'>
>;

export async function updateUserProfile(uid: string, updates: EditableProfile): Promise<void> {
  const row: Partial<ProfileRow> = {};
  if (updates.displayName !== undefined) row.display_name = updates.displayName;
  if (updates.profilePhoto !== undefined) row.profile_photo = updates.profilePhoto;
  if (updates.bio !== undefined) row.bio = updates.bio;
  if (updates.major !== undefined) row.major = updates.major;
  if (updates.interests !== undefined) row.interests = updates.interests;
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
