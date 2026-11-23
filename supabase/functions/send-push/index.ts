// Supabase Edge Function: POST /functions/v1/send-push
//
// Delivers queued push notifications. The database calls it (pg_net, see
// supabase/migrations/20261118000100_push_notifications.sql) with an empty
// body after events are queued and once a minute as a retry sweep; it then
// drains public.notification_outbox through the Expo Push API.
//
// Deploy (no user JWT: it is called by the database with a shared secret):
//   supabase secrets set PUSH_WEBHOOK_SECRET=<random secret, also in vault>
//   supabase secrets set EXPO_ACCESS_TOKEN=...   # optional, if push security is on
//   supabase functions deploy send-push --no-verify-jwt
//
// Security: callers must send `x-push-secret: <PUSH_WEBHOOK_SECRET>`. The
// function reads tokens with the service role key, which the Edge runtime
// provides as SUPABASE_SERVICE_ROLE_KEY and which never leaves the server.

import { handler } from './handler.ts';

Deno.serve(handler);
