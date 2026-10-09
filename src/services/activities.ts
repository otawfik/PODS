import { supabase, check } from './supabase';
import { Activity, ActivityCategory } from '../types';

// Writes run as Postgres functions (supabase/migrations) so capacity checks,
// counters and permissions are enforced atomically on the server.

type ActivityRow = {
  id: string;
  pod_id: string;
  host_id: string;
  host_name: string;
  title: string;
  category: ActivityCategory;
  tags: string[];
  start_time: string;
  expires_at: string;
  max_participants: number;
  current_participants: number;
  participants: string[];
  pending_requests: string[];
  status: 'active' | 'expired';
  visibility: 'pod' | 'university';
  university: string;
  auto_approve: boolean;
};

function toActivity(row: ActivityRow): Activity {
  return {
    activityId: row.id,
    podId: row.pod_id,
    hostId: row.host_id,
    hostName: row.host_name,
    title: row.title,
    category: row.category,
    tags: row.tags ?? [],
    startTime: row.start_time,
    expiresAt: row.expires_at,
    maxParticipants: row.max_participants,
    currentParticipants: row.current_participants,
    participants: row.participants ?? [],
    pendingRequests: row.pending_requests ?? [],
    status: row.status,
    visibility: row.visibility,
    university: row.university,
    autoApprove: row.auto_approve,
  };
}

const byStartTime = (a: Activity, b: Activity) =>
  new Date(a.startTime).getTime() - new Date(b.startTime).getTime();

export async function createActivity(
  data: Omit<Activity, 'activityId' | 'currentParticipants' | 'participants' | 'pendingRequests' | 'status' | 'university'>,
  _userId: string
): Promise<string> {
  // The server checks pod membership, stamps the host's university and
  // bumps their postsCount.
  const id = check(
    await supabase.rpc('create_activity', {
      p_pod_id: data.podId,
      p_host_name: data.hostName,
      p_title: data.title,
      p_category: data.category,
      p_tags: data.tags,
      p_start_time: data.startTime,
      p_expires_at: data.expiresAt,
      p_max_participants: data.maxParticipants,
      p_visibility: data.visibility,
      p_auto_approve: data.autoApprove,
    })
  );
  return id as string;
}

export async function getActivity(activityId: string): Promise<Activity | null> {
  const row = check(
    await supabase.from('activities').select('*').eq('id', activityId).maybeSingle()
  );
  if (!row) return null;
  const data = toActivity(row as ActivityRow);
  // Auto-expire check. The server marks it expired and clears its chat.
  if (data.status === 'active' && new Date(data.expiresAt) < new Date()) {
    const { data: status } = await supabase.rpc('expire_activity_if_needed', {
      p_activity_id: activityId,
    });
    if (status === 'expired') data.status = 'expired';
  }
  return data;
}

export async function getActivitiesForPod(podId: string): Promise<Activity[]> {
  const rows = check(await supabase.from('activities').select('*').eq('pod_id', podId));
  return (rows as ActivityRow[]).map(toActivity).sort(byStartTime);
}

export async function getActivitiesForPods(podIds: string[]): Promise<Activity[]> {
  if (podIds.length === 0) return [];
  const rows = check(await supabase.from('activities').select('*').in('pod_id', podIds));
  return (rows as ActivityRow[]).map(toActivity).sort(byStartTime);
}

/**
 * University-wide discovery: activities marked university-visible at the
 * given university, regardless of pod membership.
 */
export async function getUniversityActivities(university: string): Promise<Activity[]> {
  if (!university) return [];
  const rows = check(
    await supabase
      .from('activities')
      .select('*')
      .eq('visibility', 'university')
      .eq('university', university)
      .eq('status', 'active')
  );
  return (rows as ActivityRow[]).map(toActivity).sort(byStartTime);
}

/** Request a spot. Auto-approve activities add the user straight away. */
export async function requestJoinActivity(activityId: string, _userId: string): Promise<void> {
  const activity = await getActivity(activityId);
  if (!activity) throw new Error('Activity not found');
  check(await supabase.rpc('request_join_activity', { p_activity_id: activityId }));
}

/** Host approves a request; capacity is re-checked atomically on the server. */
export async function approveJoinRequest(activityId: string, userId: string): Promise<void> {
  check(
    await supabase.rpc('approve_join_request', { p_activity_id: activityId, p_user_id: userId })
  );
}

export async function rejectJoinRequest(activityId: string, userId: string): Promise<void> {
  check(
    await supabase.rpc('reject_join_request', { p_activity_id: activityId, p_user_id: userId })
  );
}

export async function leaveActivity(activityId: string, _userId: string): Promise<void> {
  check(await supabase.rpc('leave_activity', { p_activity_id: activityId }));
}

/** Delete an activity and its chat. Allowed for the host or a pod admin. */
export async function deleteActivity(activityId: string, _userId: string): Promise<void> {
  check(await supabase.rpc('delete_activity', { p_activity_id: activityId }));
}
