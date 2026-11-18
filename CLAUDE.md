# PODS

PODS is a campus app for college students. **Pods** are communities (public, or private with an invite code) around a shared interest: a study group, pickup basketball, a food crawl. **Activities** are time-bound posts inside a pod ("Library grind, 7–10pm, 5 spots"), visible to the pod or, if the host chooses, to everyone at the same university. Members request a spot and the host approves (or the activity auto-approves). Each activity has a temporary chat that is cleared when the activity expires.

Sign-up is limited to `.edu` emails, verified with an emailed 6-digit code. A student's university is derived from their email domain on the server and decides what campus-wide content they can see. Pod recommendations are ranked by Claude in a Supabase Edge Function, with a keyword heuristic as fallback. Roadmap and decisions: [docs/pods-roadmap.md](docs/pods-roadmap.md); work packages: [docs/phase-0-work-packages.md](docs/phase-0-work-packages.md).

## Stack

- Expo SDK 57, React Native 0.86, React 19, TypeScript (strict), React Navigation 7 (native stack + bottom tabs)
- Supabase: Postgres with Row Level Security; business rules as `SECURITY DEFINER` RPC functions in `supabase/migrations/`; Auth with emailed 6-digit codes plus a `before user created` hook (.edu only); Realtime for chat; `pg_cron` for activity expiry
- Edge Functions (Deno) in `supabase/functions/`: `recommend-pods` calls Claude via `@anthropic-ai/sdk` (default `claude-opus-5-5`, override with the `RECOMMENDATION_MODEL` secret) and caches per student in `public.pod_recommendations` (service role only). Pin `npm:` imports to versions at least ~2 weeks old: Deno blocks packages under 24 h old. `send-push` drains `notification_outbox` (filled by triggers on `activities`) to the Expo Push API
- Push: `expo-notifications` (`src/services/notifications.ts`); needs an EAS dev build with a `projectId`, so it is skipped in Expo Go on Android, simulators and web

## Layout

```
src/
  components/   Reusable UI (PodCard, ActivityCard, MessageBubble, ...)
  screens/      auth/, discover/, pods/, host/, messages/, profile/  (*Screen.tsx)
  services/     All data access (Supabase queries, RPCs, Edge Function calls)
  navigation/   Stack and tab navigators
  context/      AuthContext, ThemeContext
  constants/    Categories, tags, colors, university domains
  types/        Shared types and navigation param lists
supabase/
  migrations/   Numbered SQL migrations (schema, RLS, RPCs, hooks, cron)
  functions/    Edge Functions; _shared/ holds runtime-agnostic code (no imports)
  tests/        Database tests (PGlite: real Postgres in WASM, no Docker)
scripts/        eval-recommendations.ts + eval-data/
__tests__/      Jest tests (jest-expo)
```

## Commands

```bash
cp .env.example .env        # fill in Supabase URL + publishable key
npx expo start -c           # run the app (Expo Go / web)
npm run lint                # ESLint (eslint-config-expo + prettier)
npm run typecheck           # tsc --noEmit (excludes Deno function entry points)
npm test                    # Jest unit/component tests
npm run test:db             # apply all migrations to PGlite, test RLS/RPCs/hook/cron
npm run eval:recs           # recommendation eval (add -- --claude to include the LLM)
(cd supabase/functions && npx deno@2 check */index.ts)   # type-check Edge Functions
```

## Conventions

- Screens are `*Screen.tsx`; one component per file.
- Data access goes only through `src/services/` (moving to `src/api/` in Phase 3). Screens never call `supabase` directly.
- Services map snake_case rows to camelCase types (`toPod`, `toActivity`, `toUser`).
- `supabase/functions/_shared/*.ts` must stay import-free so Deno, Node (eval) and Jest can all load it.

## Rules

- Never use `any` (existing `catch (err: any)` blocks are legacy; use `unknown` in new code).
- Never use `Alert.alert` for validation errors; show inline field errors instead.
- No raw hex colors outside `src/constants/colors.ts` (becoming `src/theme/` in Phase 3).
- Every new screen handles loading, empty and error states.
- Business rules live in the backend (RLS + RPC), never only in the client. Clients may update only `profiles.display_name, bio, profile_photo, major, interests`; identity columns (`email`, `university`, counters, `pods_joined`) are server-owned.
- Schema changes are new numbered migration files, never edits to applied ones. Add a test to `supabase/tests/*.test.mjs` (e.g. `db.test.mjs`, `push.test.mjs`) for any new policy or RPC. New `public` functions get EXECUTE granted to `anon`/`authenticated` by Supabase default, so revoke explicitly when they are internal.
- Secrets (`ANTHROPIC_API_KEY`, `PUSH_WEBHOOK_SECRET`, `EXPO_ACCESS_TOKEN`, service role key) live only in Supabase function secrets (and the push webhook secret also in Supabase Vault for `pg_net`), never in `.env` or app code.
- Keep PRs under ~400 lines. Run `npm run lint && npm run typecheck && npm test && npm run test:db` before opening one.
