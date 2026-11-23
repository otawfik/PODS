// Request handler for delete-account (see index.ts for the overview).
// Kept separate from Deno.serve so handler.test.ts can call it directly.
//
// Order of the two privileged steps, and why:
//   1. public.delete_account_data(uid): one transaction that removes the
//      user from every pod/activity array, hands off or deletes their pods,
//      and deletes their activities, messages, push tokens and caches. The
//      profile and the login stay.
//   2. auth.admin.deleteUser(uid): removes the login; the profile row (and
//      anything still hanging off it) cascades.
// If 1 fails, nothing changed. If 2 fails, the user still has a working,
// signed-in account with no pods, and trying again finishes the job (1 is
// idempotent). The other order would be unrecoverable: with the login gone
// the user could never call this function again to clean up what was left.

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

/** What the client must send as `confirm`. */
export const CONFIRMATION = 'DELETE';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  const supabase = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return json({ error: 'Not signed in' }, 401);
  const userId = auth.user.id;

  const body: unknown = await req.json().catch(() => null);
  const confirm =
    body && typeof body === 'object' ? (body as Record<string, unknown>).confirm : undefined;
  if (confirm !== CONFIRMATION) {
    return json({ error: `Send { "confirm": "${CONFIRMATION}" } to delete your account.` }, 400);
  }

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: cleanupError } = await admin.rpc('delete_account_data', { p_user_id: userId });
  if (cleanupError) {
    console.error('delete-account: cleanup failed', cleanupError.message);
    return json(
      { error: 'Could not delete your account. Nothing was removed; please try again.' },
      500,
    );
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    console.error('delete-account: auth delete failed', deleteError.message);
    return json(
      { error: 'Your data was removed but the account is still open. Please try again.' },
      500,
    );
  }

  return json({ deleted: true });
}
