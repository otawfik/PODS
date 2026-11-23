// Supabase Edge Function: POST /functions/v1/recommend-pods
//
// Ranks open public pods for the signed-in student with Claude, falling back
// to a keyword heuristic when the model is unavailable.
//
// Runs on Deno at Supabase's edge. Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase secrets set RECOMMENDATION_MODEL=claude-haiku-5-5   # optional
//   supabase functions deploy recommend-pods
//
// Security: student data is read with the caller's JWT, so Row Level
// Security decides what the function can read (the same rows the app can
// read). Only the per-student cache table uses the service role key, which
// the Edge runtime provides. The Anthropic key never leaves the server.
//
// Cost: each student's ranking is cached for 24 h (public.pod_recommendations)
// and reused while their interests, major, bio and pods are unchanged; model
// calls are at most one per student per 30 s.

import { handler } from './handler.ts';

Deno.serve(handler);
