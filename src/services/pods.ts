import { supabase, check } from './supabase';
import { Pod, PodCategory } from '../types';

// Membership changes, creation and deletion run as Postgres functions
// (supabase/migrations) so they are atomic and permission-checked on the
// server. Reads are filtered by Row Level Security.

type PodRow = {
  id: string;
  name: string;
  description: string;
  category: PodCategory;
  created_by: string | null;
  created_at: string;
  member_count: number;
  visibility: 'public' | 'private';
  members: string[];
  admins: string[];
  banner_color: string;
  invite_code: string | null;
};

function toPod(row: PodRow): Pod {
  return {
    podId: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    createdBy: row.created_by ?? '',
    createdAt: row.created_at,
    memberCount: row.member_count,
    visibility: row.visibility,
    members: row.members ?? [],
    admins: row.admins ?? [],
    bannerColor: row.banner_color,
    inviteCode: row.invite_code ?? '',
  };
}

/** Short, unambiguous invite code (no 0/O, 1/I/L). Codes are now generated server-side. */
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
  _userId: string
): Promise<string> {
  const podId = check(
    await supabase.rpc('create_pod', {
      p_name: data.name,
      p_description: data.description,
      p_category: data.category,
      p_visibility: data.visibility,
      p_banner_color: data.bannerColor,
    })
  );
  return podId as string;
}

export async function getPod(podId: string): Promise<Pod | null> {
  const row = check(await supabase.from('pods').select('*').eq('id', podId).maybeSingle());
  return row ? toPod(row as PodRow) : null;
}

export async function getPublicPods(): Promise<Pod[]> {
  const rows = check(
    await supabase
      .from('pods')
      .select('*')
      .eq('visibility', 'public')
      .order('member_count', { ascending: false })
  );
  return (rows as PodRow[]).map(toPod);
}

export async function getUserPods(podIds: string[]): Promise<Pod[]> {
  if (podIds.length === 0) return [];
  const rows = check(await supabase.from('pods').select('*').in('id', podIds));
  // Keep the order of the user's podsJoined list.
  const byId = new Map((rows as PodRow[]).map((r) => [r.id, toPod(r)]));
  return podIds.map((id) => byId.get(id)).filter((p): p is Pod => !!p);
}

export async function joinPod(podId: string, _userId: string, inviteCode?: string): Promise<void> {
  check(await supabase.rpc('join_pod', { p_pod_id: podId, p_invite_code: inviteCode ?? null }));
}

/** Join a (possibly private) pod with an invite code. Returns the pod id. */
export async function joinPodWithCode(code: string, _userId: string): Promise<string> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error('Enter an invite code');
  const podId = check(await supabase.rpc('join_pod_with_code', { p_code: normalized }));
  return podId as string;
}

export async function leavePod(podId: string, _userId: string): Promise<void> {
  check(await supabase.rpc('leave_pod', { p_pod_id: podId }));
}

export async function grantAdmin(podId: string, userId: string): Promise<void> {
  check(await supabase.rpc('grant_pod_admin', { p_pod_id: podId, p_user_id: userId }));
}

export async function removeAdmin(podId: string, userId: string): Promise<void> {
  check(await supabase.rpc('remove_pod_admin', { p_pod_id: podId, p_user_id: userId }));
}

export interface PodUpdates {
  name?: string;
  description?: string;
  category?: PodCategory;
  bannerColor?: string;
}

/** Edit pod metadata. Admins only (enforced by Row Level Security). */
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
  if (updates.bannerColor !== undefined) allowed.banner_color = updates.bannerColor;
  if (Object.keys(allowed).length === 0) return;
  check(await supabase.from('pods').update(allowed).eq('id', podId));
}

/**
 * Delete a pod and everything under it (activities and chat messages are
 * removed by the database). Admins only. Also removes the pod from every
 * member's podsJoined list.
 */
export async function deletePod(podId: string, _userId: string): Promise<void> {
  check(await supabase.rpc('delete_pod', { p_pod_id: podId }));
}

/**
 * Remove pod IDs that no longer exist from a user's podsJoined list
 * (e.g. after a pod was deleted). Call after loading the user's pods.
 */
export async function removePodsFromUser(_userId: string, podIds: string[]): Promise<void> {
  if (podIds.length === 0) return;
  check(await supabase.rpc('remove_pods_from_user', { p_pod_ids: podIds }));
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

// ---------- Per-pod mute ----------

/** Whether the signed-in user muted this pod (RLS returns only their own row). */
export async function isPodMuted(podId: string): Promise<boolean> {
  const rows = check(
    await supabase.from('pod_mutes').select('pod_id').eq('pod_id', podId).limit(1)
  );
  return (rows as { pod_id: string }[]).length > 0;
}

/**
 * Mute or unmute a pod's notifications (new activities and pod chat) for the
 * signed-in user. Join requests and activities they joined still notify them.
 */
export async function setPodMute(podId: string, muted: boolean): Promise<void> {
  check(await supabase.rpc('set_pod_mute', { p_pod_id: podId, p_muted: muted }));
}
