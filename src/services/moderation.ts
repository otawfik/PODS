import { supabase, check } from './supabase';

// Report and block. The rules live in the database
// (supabase/migrations/20261123000000_reports_and_blocks.sql): a block hides
// chat messages and university activities in both directions, stops join
// requests between the two people and silences pushes about each other.
// Reports are write-only for the app; moderators read them in the dashboard.

export type ReportTargetType = 'user' | 'pod' | 'activity' | 'message';

/** Must match the `reason` check in the migration. */
export const REPORT_REASONS = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate', label: 'Hate speech' },
  { value: 'sexual', label: 'Sexual or explicit content' },
  { value: 'violence', label: 'Threats or violence' },
  { value: 'self_harm', label: 'Self-harm concern' },
  { value: 'spam', label: 'Spam or scam' },
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'other', label: 'Something else' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['value'];

export const REPORT_DETAILS_MAX = 1000;

export interface BlockedUser {
  uid: string;
  displayName: string;
  blockedAt: string;
}

type BlockRow = { blocked_id: string; created_at: string };
type NameRow = { id: string; display_name: string };

export async function blockUser(userId: string): Promise<void> {
  check(await supabase.rpc('block_user', { p_user_id: userId }));
}

export async function unblockUser(userId: string): Promise<void> {
  check(await supabase.rpc('unblock_user', { p_user_id: userId }));
}

/** File a report. Returns the report id (the open one, if already reported). */
export async function reportContent(
  targetType: ReportTargetType,
  targetId: string,
  reason: ReportReason,
  details?: string,
): Promise<string> {
  const trimmed = details?.trim() ?? '';
  if (trimmed.length > REPORT_DETAILS_MAX) {
    throw new Error(`Details must be ${REPORT_DETAILS_MAX} characters or fewer`);
  }
  const id = check(
    await supabase.rpc('report_content', {
      p_target_type: targetType,
      p_target_id: targetId,
      p_reason: reason,
      p_details: trimmed || null,
    }),
  );
  return id as string;
}

/** People the signed-in user has blocked, most recent first. */
export async function getBlockedUsers(): Promise<BlockedUser[]> {
  // Row Level Security returns only the caller's own blocks.
  const blocks = check(
    await supabase
      .from('blocks')
      .select('blocked_id, created_at')
      .order('created_at', { ascending: false }),
  ) as BlockRow[];
  if (blocks.length === 0) return [];
  const names = check(
    await supabase
      .from('profiles')
      .select('id, display_name')
      .in(
        'id',
        blocks.map((b) => b.blocked_id),
      ),
  ) as NameRow[];
  const nameById = new Map(names.map((n) => [n.id, n.display_name]));
  return blocks.map((b) => ({
    uid: b.blocked_id,
    displayName: nameById.get(b.blocked_id) ?? 'Member',
    blockedAt: b.created_at,
  }));
}
