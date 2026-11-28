// Supabase Edge Function: POST /functions/v1/delete-account
//
// Permanently deletes the signed-in user's account (App Store guideline
// 5.1.1(v)). Body: { "confirm": "DELETE" }.
//
// Deploy (after migration 20261123000100_account_deletion.sql is applied):
//   supabase functions deploy delete-account
//
// Security: the caller is identified only by their own JWT, verified with
// the anon-key client; the user id never comes from the request body, so a
// user can delete nobody but themselves. The service role key, which the
// Edge runtime provides and which never leaves the server, is used for the
// two privileged steps (see handler.ts for why they run in that order).

import { handler } from './handler.ts';

Deno.serve(handler);
