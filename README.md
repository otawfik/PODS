# PODS

### Find your people. Do the thing.

**PODS** is a cross-platform mobile and web app that helps college students turn "we should hang out sometime" into actual plans. Create or join temporary, activity-based communities ("Pods") for studying, working out, grabbing food, playing sports, gaming, and more. When the activity ends, the Pod ends. No dead group chats, no planning paralysis.

![React Native](https://img.shields.io/badge/React_Native-61DAFB?logo=react&logoColor=black) ![Expo](https://img.shields.io/badge/Expo-000020?logo=expo&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?logo=supabase&logoColor=white) ![iOS](https://img.shields.io/badge/iOS-000000?logo=apple&logoColor=white) ![Android](https://img.shields.io/badge/Android-3DDC84?logo=android&logoColor=white) ![Web](https://img.shields.io/badge/Web-4285F4?logo=googlechrome&logoColor=white)

**Watch it in action:** [PODS showcase video](https://www.youtube.com/watch?v=ln0N_B_wY80)

---

## The problem

College is full of people who want to do things and empty of ways to coordinate them. Group chats die, flyers get ignored, and meeting people outside your existing circle is mostly luck. Existing social apps optimize for scrolling, not showing up.

## The idea

Pods are lightweight, purpose-built groups with a shelf life. You open the app, see who's playing basketball at 6pm or grinding problem sets at the library, and join in one tap. Hosts get simple admin tools, members get real-time chat, and nobody has to maintain another permanent group thread.

---

## Features

**Pods**
- Create public or private Pods around any activity, with categories (Sports, Study, Social, Food, Gaming) and tags (Casual, Competitive, Beginner Friendly, Weekend...)
- Discover and search Pods happening around you
- One-tap join and leave, with member lists and profiles
- Host admin controls: grant or remove admin rights, manage members

**Activities**
- Schedule activities inside a Pod (time, place, details)
- Join-request flow: members request a spot, hosts approve or decline
- Browse upcoming activities across all your Pods

**Real-time chat**
- Pod and activity group chats powered by Supabase Realtime
- Direct 1:1 messaging between members
- Live message updates, no refresh needed

**AI pod recommendations**
- "Recommended for you" on Discover Pods, with a one-line reason for each pick
- Ranked by Claude in a Supabase Edge Function from the student's interests, major, bio and current pods; falls back to a keyword ranker if the model is unavailable
- Offline eval with labelled students to compare the LLM against the baseline (see below)

**Accounts & profiles**
- Email sign-up and login with Supabase Auth (6-digit email verification and password-reset codes)
- `.edu`-only sign-up enforced on the server by an auth hook; university derived from the email domain
- Editable profiles with major and interests

**Polish**
- Cross-platform: iOS, Android, and web from a single codebase
- Light and dark mode

---

## Tech stack

| Layer | Technology |
|---|---|
| App | React Native, Expo SDK 57, TypeScript |
| Auth | Supabase Auth (email + password, emailed codes) |
| Database | Supabase Postgres with Row Level Security (`supabase/migrations/`) |
| Real-time messaging | Supabase Realtime |
| Scheduled jobs | `pg_cron` (activity expiry every minute) |
| AI | Supabase Edge Function (Deno) → Claude API (`claude-opus-5-5`, structured JSON output) |
| Quality | ESLint, Prettier, Jest, PGlite database tests, GitHub Actions CI |
| Navigation | React Navigation (stack + bottom tabs) |

---

## Getting started

**Prerequisites:** Node.js, npm, and the Expo Go app on your phone for device testing.

```bash
git clone https://github.com/otawfik/PODS.git
cd PODS
npm install
cp .env.example .env   # then fill in your Supabase URL and publishable key
```

The database schema lives in `supabase/migrations/`. On a new Supabase project, run that SQL once (Dashboard → SQL Editor).

**Run it:**

```bash
npx expo start
```

- **On your phone:** scan the QR code with the Expo Go app (phone and computer on the same Wi-Fi).
- **On the web:** press `w` in the terminal, or run `npx expo start --web`.
- **Clear the cache if something looks stale:** `npx expo start -c`

**Supabase setup:** the app uses Supabase for auth, database, and chat. Put your project URL and publishable key in `.env` (see `.env.example` and `src/services/supabase.ts`) before running.

### Backend setup (once per Supabase project)

1. Run the SQL files in `supabase/migrations/` in order (or `supabase db push`).
2. Turn on the sign-up hook: Dashboard → Authentication → Hooks → **Before User Created** → Postgres → `public.hook_before_user_created`.
3. Deploy the recommendations function:
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase functions deploy recommend-pods
   ```
   Without the key the function still works and uses the keyword ranker (free).
   To use a cheaper model: `supabase secrets set RECOMMENDATION_MODEL=claude-haiku-5-5`.
4. Push notifications. The migration turns on `pg_net` and `pg_cron`; pick a random secret, then:
   ```sql
   -- SQL Editor
   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
   select vault.create_secret('<random secret>', 'push_webhook_secret');
   ```
   ```bash
   supabase secrets set PUSH_WEBHOOK_SECRET=<same random secret>
   # optional, only if "Enhanced push security" is on in Expo:
   supabase secrets set EXPO_ACCESS_TOKEN=...
   supabase functions deploy send-push --no-verify-jwt
   ```
   Until the vault secrets exist, events wait in `notification_outbox` (pruned after 7 days). Devices only get a token in a development/production build with an EAS `projectId`.

---

## How recommendations work

```
App (PodDiscoveryScreen)
  └─ supabase.functions.invoke('recommend-pods')        src/services/recommendations.ts
       └─ Edge Function (Deno, runs with the user's JWT → RLS applies)
            1. load profile (interests, major, bio) + joined pods + open public pods
            2. pickCandidates: drop joined pods, keep the 40 best by keyword score
            3. Claude: one Messages API call, JSON-schema output
               → [{ pod_id, reason }], ids not in the candidate list are discarded
            4. on no key / error / refusal → heuristicRank
```

- Code: `supabase/functions/recommend-pods/index.ts` (handler) and `supabase/functions/_shared/recommend.ts` (prompt, schema, parsing, heuristic; shared with tests and the eval).
- **Cost control:** each student's ranking is cached for 24 h (`public.pod_recommendations`) and reused while their interests, major, bio and pods are unchanged; the model is called at most once per student per 30 s. A call is ~2–3K input tokens: about $0.02 on Claude Opus 5.5 (the default) or well under $0.001 on Claude Haiku 5.5. With the cache, a 20-student pilot is at most ~$12/month on Opus and pennies on Haiku. Set a monthly spend limit on the Anthropic Console key.
- Claude gets no names or emails, only interests, major, bio, university and pod text. Pod descriptions are user-written, so the prompt treats them as data, and the output is checked against the candidate ids.
- **Eval:** `npm run eval:recs` scores the rankers on 12 labelled synthetic students and 30 pods (hit@3, precision@3, recall@5, MRR, and whether a prompt-injection pod gets recommended). Add `-- --claude` with `ANTHROPIC_API_KEY` set to include the LLM, and `--model claude-haiku-5-5` to compare models. Current keyword baseline: hit@3 75%, precision@3 33%, MRR 0.64.

## How push notifications work

```
request / approve / decline / create activity (RPCs)
  └─ AFTER trigger on activities diffs the request/participant arrays
       └─ notification_outbox row (type, activity, recipients, text)   never rolls back the action
            └─ pg_net POST (after commit; pg_cron retries every minute) → send-push Edge Function
                 1. claim_push_notifications(): lease pending rows + recipients' tokens
                 2. build messages, batches of ≤100 → Expo Push API
                 3. delete DeviceNotRegistered tokens, mark rows sent (failed requests retry, max 5)
```

- Events: join request → host; auto-approve join → host; approved / declined → requester; new activity → the other pod members. Nobody is notified about their own action.
- Code: `supabase/migrations/20261118000100_push_notifications.sql`, `supabase/functions/send-push/index.ts`, `supabase/functions/_shared/push.ts` (message text, batching, tickets), `src/services/notifications.ts` (permission + token).
- The app asks for permission after the first join request or created activity, and removes the device's token on sign-out. Notification `data` is `{ type, activityId, podId }` for deep links later.

---

## Testing

```bash
npm run lint && npm run typecheck   # static checks
npm test                            # Jest: components, recommendation + push logic, helpers
npm run test:db                     # every migration on PGlite + RLS / RPC / hook / cron / push tests
```

CI (`.github/workflows/ci.yml`) runs all of these plus a Deno type-check of the Edge Functions on every PR.

---

## Project structure

```
src/
  components/    Reusable UI (PodCard, ActivityCard, MessageBubble, ...)
  screens/       Auth, Discover, Pods, Activities, Messages, Profile
  services/      Supabase-backed data layer (auth, pods, activities, chat, recommendations)
  navigation/    Stack and tab navigators
  context/       Auth and theme providers
  constants/     Categories, tags, colors
  types/         Shared TypeScript types
supabase/
  migrations/    SQL schema, RLS, RPCs, auth hook, cron
  functions/     Edge Functions (recommend-pods)
  tests/         Database tests
scripts/         Recommendation eval
```

---

## Roadmap

- Push notifications for activity reminders and new chat messages
- Location-based Pod discovery ("what's happening near me")
- Recurring activities and RSVP headcounts
- Pod ratings and member reputation
- Campus ambassador program for launch at new schools

---

## Team

- **Omar Tawfik** — co-founder, engineering
- **Christian Johnson** — co-founder, engineering

Built by students, for students.
