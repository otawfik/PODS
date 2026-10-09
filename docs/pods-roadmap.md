# Pods — Roadmap from Prototype to App Store

*Prepared September 10, 2026 for Christian & Omar. Based on the six CS411 deliverables and a read-through of the current codebase in `Desktop/PODS/Pods`. Revision 2: decisions from Christian folded in — see the decision log in Section 5. **Revision 3 (October 9, 2026): the app now runs on Supabase instead of Firebase — see the status section directly below; the decision log and next actions are updated to match.***

---

## Status — October 9, 2026

**Done: Firebase → Supabase migration (merged to `main` as commit `1dbaf0b`).** This was a like-for-like port: the app does what it did before, but on Supabase, with the security and atomicity problems from the audit below fixed. It is *not* yet the full Phase 2 data model — that redesign is still ahead.

What changed:

- **Backend.** One migration, `supabase/migrations/20261009000000_initial_schema.sql`, creates `profiles`, `pods`, `activities` and `messages`, mirroring the old Firestore collections (the separate `podInvites` collection became `pods.invite_code`). Applied by pasting it into the Supabase SQL Editor.
- **Security.** Row Level Security on every table, porting the old `firestore.rules`: public pods or your own private pods are readable; activities are visible to pod members or same-university users when university-wide; chats are readable/writable only by participants.
- **Business rules moved server-side.** Join/leave pod, join with invite code, create pod/activity, request/approve/decline/leave activity, grant/remove admin, delete pod/activity and expiry all run as Postgres functions (RPCs) with row locks. Counters are no longer read-then-written by the client; "Activity is full" is race-safe; deleting a pod or activity deletes its chat via cascade.
- **Auth.** Supabase Auth with email + password. Sign-up and password reset use **6-digit codes** typed into the app (no links, so no deep links needed). A database trigger creates the profile row on sign-up.
- **Email.** Custom SMTP through Christian's personal Gmail (app password), which unlocked editing the email templates on the free plan. Fine for testing (~500 emails/day); move to a domain-based sender (e.g. Resend) before the pilot.
- **Chat.** Supabase Realtime on `messages` (pod and activity chats update live).
- **App code.** `src/services/*` rewritten on `@supabase/supabase-js` with the same function names, so screens barely changed. `firebase` package, `firebase.ts`, `firestore.rules`, `firebase.json` and the Firebase type shim are gone. Config comes from `.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; see `.env.example`).
- **UX fixes found while testing.** Screens reload when you navigate back to them (a new activity shows up without leaving the pod); the chat input bar now rises above the keyboard in pod and activity chat.
- **Stack versions.** The app is on **Expo SDK 57 / React Native 0.86** (upgraded Oct 2 for Expo Go compatibility); references to SDK 54 / RN 0.81 below are from the original audit.

Verified: the migration was tested against a local Postgres with fake users (private pods, invite codes, capacity limit, last-admin rule, chat permissions, expiry, cascade deletes); TypeScript compiles; the iOS bundle builds; Christian tested the app end to end in Expo Go, including the sign-up code and password-reset emails.

**Known gaps carried into Phase 2** (both were also true on Firebase):

- **Domain restriction is client-side only.** The app checks for `.edu`, but the server accepts any email. The emailed code proves ownership of the address, but the "BU emails only" auth hook (Phase 2 step 3) isn't in yet.
- **Expiry is still lazy.** An activity flips to `expired` (and its chat is cleared) when someone opens it after the deadline. The `pg_cron` job (Phase 2 step 6) will make it automatic.
- **Schema is still the array-based port** (`pods.members`, `activities.participants` as arrays), not the relational v1 schema (`pod_members`, `join_requests`, `activity_participants`, `universities`, …).

**Operational notes.** Supabase project ref `utnezmiwsftmcijwuika` (free plan). Free projects pause after about a week without activity — un-pause from the dashboard. The old Firebase project is unused and should be deleted (see §6).

---

## 0. Where you actually are (codebase audit)

*Audit as of September 10, 2026. Items marked ✅ were fixed by the October 9 Supabase migration.*

The prototype is further along than "terrible UI" suggests, and further behind than the deliverables suggest. Both matter for planning.

**What exists and works (roughly 3,400 lines of TypeScript):**
Expo SDK 54 / React Native 0.81 / React 19, React Navigation 7 with a 4-tab layout (Discover, My Pods, Messages, Profile), 14 screens, 5 reusable components, a light/dark theme context, and a services layer over the Firebase JS SDK (Auth, Firestore, Realtime Database). Registration, login, pod create/join/leave, admin grant/revoke, activity create, join request/approve/reject, activity chat, and pod chat all exist end to end.

**What is missing or structurally wrong — these drive the plan more than the UI does:**

- ✅ **No real school-email verification.** The app only checks that the address ends in `.edu` on the client. `sendEmailVerification` is never called. Anyone can type `fake@bu.edu` and get in. *(Now: a 6-digit emailed code is required. Server-side domain restriction is still to do.)*
- ✅ **No security rules anywhere.** There is no `firestore.rules` or `database.rules.json` in the repo. If the Firebase project was left in test mode, anyone with the config (which is committed to a public GitHub repo) can read and write everything. If rules were tightened, the app breaks, because every write goes straight from the client. *(Now: Row Level Security on every Supabase table.)*
- ✅ **All business logic is client-side.** Capacity checks, approval, expiry, and counters are enforced only by the app. Two people tapping "Approve" at once on the last slot both succeed. `memberCount` and `postsCount` are read-then-written, not atomic. *(Now: Postgres functions with row locks.)*
- **Expiry is lazy.** An activity only flips to `expired` when someone opens it after the deadline. Nothing ever deletes chats. Pod chats are permanent by design; activity chats are permanent by accident. *(Partly: expired activity chats are now deleted when the activity expires, but expiry is still triggered lazily.)*
- **N+1 reads everywhere.** `getUserPods`, `getActivitiesForPods`, and the member-profile loader each fetch documents one at a time in a loop. Fine at 5 users, expensive and slow at 500. *(Partly: pods and activities now load in one query; the member-profile loader still loops.)*
- **No feature for "host allows members to create activities."** Every pod member can post. The `Pod` type has no settings object at all.
- **No profile fields** beyond name, bio, and university. No interests, major, class year, or photo, and no image upload path.
- **No report/block, no push notifications, no deep links, no error tracking, no analytics, no tests, no CI, no EAS config, no bundle identifiers.** The `app.json` still has the Expo defaults.
- **Small code-quality issues** that will slow Claude down later if not fixed first: `firebaseUser: any` *(✅ gone)*, two different `SafeAreaView` imports, validation via `Alert.alert`, hard-coded `#FFFFFF`, the `Pods.zip` snapshot and `.DS_Store` files sitting in the working folder.

None of this is unusual for a semester project. It just means the honest sequence is **stabilize the foundation → design → rebuild the app against the new backend**, not "polish the UI first." Polishing screens that talk to a backend you're about to replace is wasted work.

---

## 1. The backend decision (the one that gates everything else)

You asked for a comparison. Here it is, weighted for your actual situation: two people, Claude writing most of the code with ChatGPT reviewing, ≤$50/month, iOS + Android, and a must-have list that includes real-time chat and push notifications.

### Option A — Supabase (Postgres + Auth + Realtime + Storage + Edge Functions)

- **Fit to the domain:** Pods, members, activities, join requests, and blocks are relational data with lots of "who can see what" logic. Postgres with Row Level Security expresses this directly ("a user can read an activity if they are a member of its pod"). Firestore forces you to denormalize arrays and re-check rules in client code.
- **Verification:** Supabase Auth supports email OTP (6-digit code) out of the box, and you can restrict sign-ups to `@bu.edu` with a single database trigger or an auth hook. No custom mail server.
- **Realtime chat:** Postgres Changes / Broadcast channels cover activity and pod chat. Expiry is a `pg_cron` job (one SQL statement) that locks and later purges chats.
- **Push:** Expo Push Notifications service is free; a Supabase Edge Function or database webhook calls it when a join request is created or approved.
- **Cost:** Free tier (500 MB DB, 1 GB storage, 50k monthly active users) is more than enough for a BU pilot. Pro is $25/month if you want daily backups and no project pausing after a week of inactivity. Fits your budget with room for Apple's $99/year.
- **Claude-friendliness:** Schema, RLS policies, and edge functions are all plain SQL and TypeScript in your repo, so Claude can write, migrate, and test them; ChatGPT can review them as text. This is the biggest practical advantage for how you plan to work.
- **Cost of choosing it:** The `services/` layer (about 350 lines) and the `types/` file get rewritten. Screens mostly keep their shape. That's a few work packages, not a rewrite of the app.

### Option B — Stay on Firebase (Spark free tier)

- **Fit:** Least churn; Auth/Firestore/RTDB code already exists.
- **The catch:** Everything you're missing (server-side expiry, atomic approvals, push sending, OTP verification with a domain check, report handling) needs Cloud Functions, and Cloud Functions require the Blaze plan. Blaze is pay-as-you-go and would cost ~$0 at your scale, but it requires a card on file, which is presumably why you stopped. You would also need to write and test Firestore + RTDB security rules from scratch, which is notoriously fiddly and hard to review as text.
- **Verdict:** Viable, but you'd end up paying the same effort as Option A to get a weaker data model.

### Option C — Custom Go API + Postgres

- **Fit:** Full control and you know Go, but you said you're not comfortable coding and Claude will write most of it. A custom server means you also own auth, sessions, WebSocket chat, push delivery, hosting (Fly.io/Railway ~$5–20/month), deploys, logs, and security patches. That is a second product to maintain.
- **Verdict:** Not for v1. If Pods grows past what Supabase handles, the relational schema you build now ports to a Go service cleanly later.

### Decision

**Supabase — confirmed by Christian on Sept 10, 2026; migration completed Oct 9, 2026.** It gives you the verification, security, expiry, chat, push, and storage story with the least amount of code you have to own, it is the easiest option to review as plain text, and it stays free through the pilot. Everything below assumes it.

---

## 1b. The pilot wedge: class study pods

*Added Sept 10 after discussing adoption risk.* Pods stays a general-purpose app, but the pilot points at one use case where the cold-start problem is smallest.

**Why classes.** Every course is a pre-existing group of 50–300 people with a shared deadline every week, no stranger-danger problem, and an obvious first activity ("PS3 at Mugar, 7 pm — or on Discord if you're remote"). Nothing currently owns "find two people to work through this problem set with": Piazza is for questions to staff, Discord servers are chaotic and unofficial, GroupMe threads die by week four. A class pod arrives with its members already attached, which is the one thing a social app can't build for itself. Online activities (a Discord/Zoom link instead of a room) fit naturally and remove the show-up barrier entirely, and the same shape works for gaming pods.

**What this changes in the plan:**
- **Validate before building (this month, not Phase 6).** Run 3–4 study sessions the ugly way — through a class GroupMe or the current prototype — for classes you and Omar are in right now. Count who requests, who shows, who comes back. If people show, build with conviction. If nobody does, you've learned the most important fact about the business for the price of a few evenings, and the plan pivots toward the club-tool version before the design system is done.
- **Seeding (Phase 6):** the first pods are the courses the two of you and any early volunteers are enrolled in, seeded on day one of the pilot with a study session already posted; club outreach and the "start a pod" form come second.
- **Activity form (Phase 3):** a location field that accepts either a place or a link, with a clear "online" toggle so remote sessions are first-class, not a hack.
- **Pod templates (Phase 3, small):** creating a pod offers "Class", "Club", "Interest" presets that set the category and a sensible default for `members_can_create_activities` (on for classes).
- **Reliability features (Phase 4, added):** chat helps with the fifteen minutes before an activity, but what actually reduces flaking is the cost of flaking. So: hosts mark who showed up after an activity ends; a visible reliability signal on profiles built from the existing `commendations` idea (kudos from hosts, attendance streak); and a quiet cooldown on requesting for anyone who no-shows twice in 30 days. All three are cheap because the data model already has the pieces.
- **Greek life and large events:** welcome as ordinary pods posting ordinary activities, but no party-specific features and no marketing to them first. Alcohol, under-21 attendees, and off-campus addresses change the liability picture and the App Store review conversation; earn the reputation with study groups and clubs before leaning into it.

---

## 2. How we'll work (read this before Phase 0)

Because Claude will do most of the coding and you'll be verifying rather than writing, the plan is broken into **work packages**. Each one is designed to be a single Claude session with a clear "done" you can check without reading code.

**Every work package has:**

1. A goal in one sentence.
2. The files it touches.
3. A verification script: what you tap in the app or run in the terminal, and what you should see.
4. What to paste to ChatGPT for review (usually the git diff plus the goal).

**Repo conventions to set up in Phase 0 so every Claude session starts with context:** a `CLAUDE.md` at the repo root describing the stack, folder layout, naming rules, and the "don't do" list (no `any`, no `Alert.alert` for validation, no raw hex colors outside the theme file). Claude reads it automatically. This single file is the highest-leverage thing you can do for consistency across sessions.

**Branching:** `main` is always shippable to TestFlight. Each work package is a branch → PR → Omar or ChatGPT reviews → merge. Small PRs (under ~400 lines) review well; big ones don't. Before starting a branch: `git checkout main && git pull`; after a PR merges: pull `main` again and delete the branch.

---

## 3. Phased plan

Phases are ordered by dependency. Rough effort assumes ~10 focused hours a week between the two of you, with Claude doing the typing; adjust to your real pace.

### Phase 0 — Foundation & hygiene (1–2 weeks)

Goal: a repo Claude can work in safely, with credentials out of source and a build pipeline that already produces installable apps, before any features change.

1. **Clean the working folder.** Move `Pods.zip` out of `Desktop/PODS`, delete `.DS_Store` files, confirm `node_modules` and `.expo` are ignored (they are). Decide whether the local folder or `github.com/otawfik-ux/Pods` is the source of truth and sync them.
2. **Retire the Firebase project.** ✅ *No code references Firebase anymore (Oct 9).* The old config is still public in git history, so delete the Firebase project outright from the Firebase console.
3. **Environment config.** ✅ *Done differently (Oct 9):* `app.config.js` exists; Supabase values come from `.env` as `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and are read directly in `src/services/supabase.ts`; `.env.example` is committed and `.env` is ignored. `expo-constants` is not needed for this. Revisit when EAS environment variables are set up (WP-5).
4. **Identifiers.** Choose the bundle ID (`edu.bu.pods` won't work — you don't own bu.edu; use a domain you own or reverse-DNS of something like `app.joinpods` / `com.yourname.pods`). Set `ios.bundleIdentifier`, `android.package`, `scheme` (for deep links later), version `0.1.0`.
5. **EAS.** `npx eas init`, create `eas.json` with `development`, `preview`, `production` profiles. Switch from Expo Go to a **development build** now, because push notifications and image pickers don't work in Expo Go.
6. **Tooling.** ESLint + Prettier with Expo's config, `tsc --noEmit` in a `typecheck` script, a GitHub Action that runs lint + typecheck on every PR. Add Jest with `jest-expo` and one smoke test so the test harness exists before Phase 3 needs it.
7. **`CLAUDE.md`** as described above, plus a `docs/` folder holding this roadmap and the design-decision records that follow. *(Oct 9: `docs/` created with this roadmap and the Phase 0 work packages.)*
8. **Fix the small code-quality items** listed in the audit (types, SafeAreaView, hex colors) as one cleanup PR so later diffs stay focused.

**Verification:** `npm run lint && npm run typecheck && npm test` pass; `eas build --profile development --platform ios` produces an installable build; the app runs on your phone via the dev client.

**Decisions (locked Sept 10):**
- **Domain:** buy one (~$12/year). Pick it before Phase 0 step 4 because the bundle ID is derived from it and cannot change after the first store submission. Candidates to check: `joinpods.app`, `getpods.app`, `podsapp.co`. The domain also hosts the privacy policy, terms, and support email the stores require — and, since Oct 9, it's what lets verification emails move off personal Gmail.
- **Macs:** both of you have one → install Xcode for the iOS simulator; EAS handles the actual builds.
- **Repo:** move to a **free GitHub organization** (e.g. `pods-app`) with both of you as owners, and transfer Omar's repo into it (GitHub's "Transfer ownership" keeps history, PRs, and redirects). This avoids the project living under one person's personal account and makes it trivial to add collaborators or a CI bot later. Talk to Omar; it's a 5-minute operation.

### Phase 1 — Design (2–3 weeks, can overlap with Phase 2)

Goal: a design system and approved mockups for every screen, so the rebuild in Phase 3 is execution, not invention.

1. **Three visual directions** (you asked for options). I'll produce one mood board + a Discover screen and an Activity Detail screen in each: (a) *clean & friendly* — light-first, rounded, warm accent; (b) *bold & energetic* — dark-first, vivid category colors; (c) *minimal & native* — iOS-native lists, pod colors carry personality. You and Omar pick one; mixing is fine.
2. **Design system** for the chosen direction: color tokens (light + dark), type scale, spacing scale, radius, elevation, and the component set: Button (primary/secondary/destructive/ghost), Input with inline error, Chip, Card, Avatar, Badge, Sheet, Tab bar, Empty state, Toast. Written up as a design-tokens file the code will import directly.
3. **Information architecture fix before drawing screens.** Current pain points that are UX, not styling: the "Discover" tab mixes pod discovery and activity feed; Activity Detail, Join Requests and Create Activity are duplicated across three navigation stacks; validation happens in modal alerts; there's no onboarding after sign-up; the profile has no view-other-user route. Proposed IA: **Home** (two segments at the top: *My Pods* — activities from pods you've joined — and *Campus* — free activities not tied to any pod plus pod activities marked university-wide), **Pods** (my pods + explore), **Create** (center FAB → activity or pod; the activity form asks "post to a pod / post to campus"), **Inbox** (chats + join-request notifications; expired activity chats show as "ended" here and on the activity detail for 24 h, then disappear), **Profile**.
4. **Screen mockups** (~18): Welcome, Email entry, Code entry, Profile setup (2 steps), Home feed, Activity detail, Create activity, Join requests, Pods list, Explore pods, Pod detail (Activities / Chat / Members / About), Create pod, Pod settings (incl. "members can create activities" toggle), Chat, Inbox, Profile, Edit profile, Other user's profile, Report sheet, Settings.
5. **Microcopy pass**: empty states, errors, confirmations, and the expired-chat message.

**Verification:** you can tap through the mockups and every state (empty, loading, error, full, expired, pending) is drawn.

**Decisions (locked Sept 10, one pending):**
- Visual direction: **pending** — Christian and Omar choose after seeing the three options.
- App name: **"Pods"**. Christian checked the App Store: no app is listed as plain "Pods" (there are "Pods - …", "Podz", "Pods: Friend Reviews"). Apple requires the *name* to be unique but subtitles differ, so "Pods" with subtitle "Campus activities, together" should clear. Reserve the name early: creating the App Store Connect record reserves it without submitting a build. Do the same on Google Play (names aren't unique there, but the listing is).
- Activity chat is reachable from **both** the activity detail and the inbox. On expiry, both surfaces show it as ended/locked for 24 h, then it's gone.

### Phase 2 — Backend on Supabase (3–4 weeks, overlaps Phase 1)

Goal: a secure backend with the real data model, verification, expiry, chat, push, and storage — all defined as migrations in the repo.

*Progress (Oct 9):* steps 1 (partly — project created, migrations folder in the repo, no CLI/local dev yet), 3 (partly — codes and profile trigger; no domain hook), 4 and 5 (for the current, simpler schema), 7 (messages only) and 11 (code side) are done in the port described in the status section. The v1 schema below replaces the port's array-based tables with a new migration; the RPC names and RLS rules carry over.

1. **Project setup.** Create the Supabase project (region `us-east-1`, close to Boston). Install the Supabase CLI; `supabase init`; all schema changes are numbered migrations in `supabase/migrations/`. Local dev via `supabase start` (Docker) so Claude can test against a real Postgres.
2. **Schema (v1).**
   - `universities` (id, name, email_domain) — seeded with BU only.
   - `profiles` (id = auth user id, university_id, display_name, avatar_path, bio, major, class_year, created_at) — `major`, `class_year`, `avatar_path` nullable, per your "all optional" call.
   - `interests` (id, label) and `profile_interests` (profile_id, interest_id).
   - `pods` (id, university_id, name, description, category, visibility, banner_color, created_by, **members_can_create_activities** boolean, created_at).
   - `pod_members` (pod_id, profile_id, role: `owner` | `admin` | `member`, **role_label** text nullable — e.g. "Treasurer", set by the owner for admins, display-only; joined_at).
   - `activities` (id, **pod_id nullable**, university_id, host_id, title, category, starts_at, expires_at, max_participants, **scope**: `pod` | `university`, auto_approve, status, created_at). `pod_id NULL` + `scope = university` is a "free" campus activity; `pod_id` set + `scope = university` is a pod activity the owner chose to broadcast campus-wide (only owners may do that — enforced in the RPC).
   - `activity_participants` (activity_id, profile_id, joined_at).
   - `join_requests` (id, activity_id, requester_id, status: pending/approved/declined, created_at, decided_at).
   - `messages` (id, room_type: `pod` | `activity`, room_id, sender_id, body, created_at).
   - `blocks` (blocker_id, blocked_id), `reports` (id, reporter_id, target_type, target_id, reason, details, status, created_at).
   - `push_tokens` (profile_id, token, platform).
   - Counts (`member_count`, `participant_count`) are **views or triggers**, never client-written.
3. **Auth.** Email verification codes via Supabase Auth (*in place since Oct 9, with email + password*). A `before user created` auth hook rejects any email whose domain isn't in `universities` (**still to do** — today only the app checks `.edu`). A trigger creates the `profiles` row on sign-up and links the university from the domain. Optional: re-verification every 12 months flag.
4. **Row Level Security** on every table. Examples: profiles readable by same-university users only; pods readable if public or member; activities readable if pod member (or university-wide visibility); messages readable only by room members and only while room is open; blocks hide the blocked user's content both directions.
5. **Business rules as Postgres functions (RPC)** so the client never enforces them: `request_join(activity_id)`, `decide_request(request_id, approve)` (checks host, capacity, race-safe with row locks), `create_activity(...)` (pod activity: checks `members_can_create_activities` or admin/owner role; `scope = university` on a pod activity: owner only; pod-less campus activity: any verified user), `update_activity` (host only, `starts_at > now()`), `leave_activity`, `create_pod`, `join_pod`, `set_member_role(pod_id, profile_id, role, role_label)` (owner only), `remove_member` (owner/admin), `delete_activity` (host, or pod owner/admin), `set_pod_mute`, `report(...)`, `block(...)`.
6. **Expiry.** `pg_cron` job every minute: mark activities `expired` when `expires_at < now()`, mark their pending `join_requests` as `expired`, lock their chat; an hourly job deletes messages from rooms expired > 24 h (the chat then disappears from inbox and detail); expired activities themselves are kept 30 days for the moderation window, then pruned. Activities are editable by the host only while `starts_at > now()` (enforced in the update RPC). *(Today: expiry happens lazily via `expire_activity_if_needed`, and the chat is deleted immediately rather than after 24 h.)*
7. **Realtime.** Enable Realtime on `messages`, `join_requests`, `activity_participants` so chat, pending badges, and spot counts update live.
8. **Storage.** `avatars` bucket, public-read, write restricted to own path; images resized on the client before upload (~512 px).
9. **Push.** Table triggers → `pg_net` HTTP call to an Edge Function → Expo Push API. Events: new join request (to host), request decided (to requester), new activity in a pod you're in (respecting `pod_members.muted` — per-pod mute is in), new message in an activity chat when app is backgrounded.
10. **Seed & test data.** A seed script creating BU, ~8 pods, ~20 fake users, activities in every state, so the UI can be built against realistic data.
11. **Delete the Firebase project** once the app no longer references it. *(The app no longer references it as of Oct 9 — delete now.)*

**Verification:** `supabase db reset` runs all migrations clean; a SQL test file (pgTAP) proves RLS (user B cannot read user A's private pod; a non-host cannot approve; the 6th approval into a 5-cap activity fails); signing up with `test@gmail.com` is rejected, `test@bu.edu` receives a code.

**Decisions (locked Sept 10):**
- Roles: owner + admins + members. The owner can give each admin a free-text **role label** ("President", "Social Chair") shown on the members list; labels don't change permissions.
- Pod **owners** can post an activity university-wide. Anyone can post a **free** campus activity with no pod (the *Campus* segment on Home).
- Join requests expire with the activity.
- Activity chat: locked at expiry, deleted 24 h later.
- Per-pod mute: yes.

### Phase 3 — App rebuild against the design system (5–7 weeks)

Goal: every screen rebuilt on the new components, talking to Supabase, with loading/empty/error states, and no client-side business logic.

1. **Foundations first:** `@supabase/supabase-js` (*installed Oct 9*), `@tanstack/react-query` (caching, refetch, optimistic updates — removes the manual `load()` / `refreshProfile()` juggling), `expo-image`, `expo-image-picker`, `expo-notifications`, `expo-secure-store` for the session (*the session currently persists in AsyncStorage*). Theme tokens from Phase 1 replace `constants/colors.ts`. Build the component library (`src/ui/`) with a Storybook-style gallery screen so you can eyeball every component in both themes.
2. **Services layer rewrite** (`src/services/*` → `src/api/*`): thin typed wrappers around Supabase queries and RPCs, generated types via `supabase gen types`. Delete all Firebase code. *(Oct 9: Firebase code deleted and `src/services/*` already wrap Supabase; still to do — move to `src/api/`, generated types, and rewrite against the v1 schema.)*
3. **Auth flow:** Welcome → email → code → profile setup (name, then optional major/year/interests/photo) → home. Session persisted; auto-login on relaunch. *(Decide whether to keep passwords or go passwordless — see decision #25.)*
4. **Navigation restructure** to the new IA (Home / Pods / Create / Inbox / Profile), single definition of shared screens, typed routes, deep-link config (`pods://activity/123`) so push notifications open the right screen.
5. **Screens**, in dependency order: Home feed (My Pods / Campus segments) → Activity detail → Create activity (pod or campus) → Join requests → Pods list → Explore → Pod detail (public preview for non-members) → Create pod → Pod settings (member posting toggle, mute, admin role labels, remove member) → Chat (incl. ended state) → Inbox → Profile → Edit profile → Other-user profile → Report sheet → Settings/blocked users.
6. **Realtime wiring:** chat (*done for the current screens*), pending badge, spot counts.
7. **Push registration** on first launch after login (ask permission at a moment that makes sense — after the first join request, not on the welcome screen).
8. **Error & offline handling:** global error boundary, toast for failures, retry on network error, "you're offline" banner.
9. **Accessibility pass:** labels on icon buttons, 44 pt touch targets, Dynamic Type doesn't break layouts, contrast ≥ 4.5:1 (checked from the tokens).

Each bullet is 1–4 work packages. Verification is a scripted walkthrough per screen ("create an activity with capacity 2, approve one request, confirm the second shows Full") that you or Omar run on the dev build.

**Decisions (locked Sept 10):**
- Non-members **can** see a public pod's activity list before joining (read-only; the Request to Join button becomes "Join pod to request").
- Hosts **cannot** remove approved participants in v1 — Christian's reasoning is that troll hosts could approve and then dump people. The safety valve instead: any participant can *report* the host or *leave*; the pod owner/admin can delete an activity in their pod (which ends its chat); reports are reviewed. Revisit after the pilot if hosts ask for it.
- Activities are editable **until start time**, not expiry.

### Phase 4 — Trust, safety & store compliance features (2 weeks)

These aren't optional: Apple's guideline 1.2 requires user-generated-content apps to have content filtering, a report mechanism, a block mechanism, and a published way to contact you; Google Play has the equivalent UGC policy.

1. **Report** any user, pod, activity, or message (reason picker + free text) → `reports` table → email to a moderation inbox you check.
2. **Block** hides the other user's content in both directions and prevents them joining your activities; Blocked Users list in settings.
3. **Moderation admin:** simplest version is the Supabase dashboard plus a saved SQL view of open reports; a tiny internal web page can come later.
4. **Community guidelines + Terms of Service + Privacy Policy** pages (in-app and at a public URL). I'll draft them; have someone sanity-check them — I'm not a lawyer.
5. **Account deletion** inside the app (Apple requires it) — an RPC that anonymizes the profile and removes auth.
6. **Basic content filtering:** a profanity/slur list check on pod names, activity titles, and messages, done in a Postgres function; not perfect, but it satisfies the "filter" requirement.
7. **Rate limits** on activity creation, join requests, and messages to blunt spam (a simple per-user counter in Postgres).
8. **Reliability (from the pilot wedge, §1b):** host marks attendance after an activity ends (`activity_participants.attended`); profile shows a reliability signal (kudos + attendance) instead of raw counts; a `no_show_count` in the last 30 days ≥ 2 puts a 7-day cooldown on new join requests, enforced in the `request_join` RPC with a friendly message. Not a public shaming mechanic — the count is private, only the cooldown is visible to the user it applies to.

**Decisions (locked Sept 10, one pending):** Pod owners (and admins) can **remove members** from their pod and **delete activities** in it — first-line moderation. App-level moderator of record is still needed for the store listings: this is an email address (e.g. `support@<yourdomain>`) that Apple and Google display and that receives report notifications; pod owners can't fill that role because reports about *owners* need to go somewhere. Decide who between you monitors it — **pending**.

### Phase 5 — Quality, observability & testing (1–2 weeks, partly overlapping)

1. **Sentry** (free tier) via `sentry-expo` for crash reports with source maps.
2. **PostHog** (free tier) or Expo's built-in analytics for: sign-up funnel, activities created, join-request conversion, chat messages per activity. These are the numbers that tell you whether the app works as a product.
3. **Tests:** pgTAP for RLS and RPCs (the part that must not break), Jest + React Native Testing Library for the join-request state machine in the UI, and a Maestro end-to-end flow (sign up → create pod → create activity → request → approve → chat) that runs on every release build.
4. **Performance check** with the seed data at 10× size: home feed under 1 s, chat opens instantly.
5. **Device matrix:** iPhone SE (small), iPhone 15 Pro (Dynamic Island), a mid-range Android, and one tablet just to confirm nothing is broken (you can set `supportsTablet: false` to avoid iPad review).

### Phase 6 — Invite-only pilot at BU (3–4 weeks of running, not building)

1. **Seed real pods — classes first (§1b):** every course you, Omar, and early volunteers are in gets a pod with a study session already posted on day one. Then 5–10 clubs/groups (CS association, a gym crew, an intramural team), each with an owner account and a short "how to run your pod" one-pager.
2. **Distribution:** TestFlight external testing (up to 10,000 testers via a public link — needs a light Apple review) and Google Play internal/closed testing (requires **12 testers opted in for 14 consecutive days** before a personal developer account can publish to production — start this clock early).
3. **Invite gate:** an `invite_codes` table checked at sign-up so it stays invite-only during the pilot; flip a flag to open it to all of bu.edu at launch.
4. **Feedback loop:** an in-app "Send feedback" sheet, a weekly 30-minute review of analytics + reports + feedback, and a changelog you post to the pilot pods.
5. **Success criteria to define now** (so you know when it's "ready"): e.g. ≥ 40% of sign-ups join a pod within a day; ≥ 25% of activities get at least one approved join; no unresolved P1 bugs for two weeks; crash-free rate ≥ 99%.
6. **Email sender (added Oct 9):** before inviting pilot users, move Supabase's SMTP from personal Gmail to a domain sender (e.g. Resend's free tier, `no-reply@<yourdomain>`), so codes don't land in spam or hit Gmail's limits.

**Decisions (locked Sept 10, one pending):** No existing club contacts, so the seeding strategy is two-pronged: (a) Christian approaches a handful of BU's 400+ clubs directly (BU's Engage/club directory lists officer emails; CS-adjacent clubs and intramural sports are the easiest first asks because the pitch is concrete), and (b) an **"I want to start a pod" interest form** — anyone who signs up during the pilot can claim a pod topic and becomes its owner. Most pods will be **public with open join**, so the schema's `visibility` default is `public` and pods don't need join approval in v1 (the `private` option stays for invite-only groups). Pilot start week: **pending** — set it once Phase 0 is done and you can see your real pace.

### Phase 7 — Store submission (2–3 weeks including review turnaround)

**Accounts:** Apple Developer Program ($99/year; if enrolling as an individual, use your legal name — the developer name shows publicly; a company/LLC costs more and takes longer). Google Play Console ($25 one-time; new personal accounts have the 12-tester requirement above and identity verification).

**Assets to prepare:** app icon (1024 px, no alpha), screenshots for 6.7" and 6.5" iPhones and, if you keep tablet support, 12.9" iPad; Android phone screenshots + 1024×500 feature graphic; app name, subtitle, description, keywords; support URL; marketing URL (optional); privacy policy URL (required).

**Apple-specific:** App Privacy "nutrition label" (you collect email, name, photos, user content, identifiers for push — declare each); age rating questionnaire (UGC → likely 12+ or 17+ depending on answers; unrestricted chat pushes it higher); a **demo account** with pre-seeded data and a reviewer note explaining the bu.edu restriction — reviewers won't have a BU email, so give them a bypass account or a whitelisted test domain; Sign in with Apple is **not** required because you don't offer any third-party social login — keep it that way for v1 to avoid the rule.

**Google-specific:** Data Safety form (mirror of Apple's), content rating questionnaire, target API level compliance (Expo handles this), and the closed-test requirement.

**Release mechanics:** `eas build --profile production` → `eas submit`; use `expo-updates` (EAS Update) so bug fixes ship over the air without a store review — configure it now, it's free at your scale. Staged rollout on Play; phased release on iOS.

**Rejection risks specific to Pods** and how to pre-empt them: missing report/block (Phase 4), no account deletion (Phase 4), reviewer can't sign up (demo account), "app is a test/beta" wording anywhere in the listing (remove), crashes on iPad if tablet enabled (disable), privacy label mismatch (double-check against what Sentry/PostHog collect).

### Phase 8 — Launch & operate

1. Open sign-ups to all of bu.edu (flip the invite flag), announce via the pilot pods and BU channels.
2. Weekly rhythm: review reports within 24 h, look at the funnel, ship an OTA fix or a store release every 1–2 weeks.
3. Backups: Supabase Pro daily backups, or a weekly `pg_dump` in a GitHub Action if you stay on the free tier.
4. Second campus: add a row to `universities` — the schema already supports it — but only after BU is healthy; the deliverables' own risk register says density is the whole game.
5. Post-launch roadmap candidates, in rough priority: recommendations from interests, pod-level permanent announcements, activity recurring templates, commendations/kudos, SheerID verification if fake .edu addresses ever become a problem.

---

## 4. Sequencing at a glance

| Order | Phase | Effort | Can overlap with | Status (Oct 9) |
|---|---|---|---|---|
| 1 | 0 Foundation | 1–2 wks | — | In progress (env config, Firebase removal, `docs/` done) |
| 2 | 1 Design | 2–3 wks | Phase 2 | Waiting on visual direction |
| 3 | 2 Backend | 3–4 wks | Phase 1 | Port done; v1 schema, domain hook, cron expiry, push, storage to do |
| 4 | 3 App rebuild | 5–7 wks | Phase 4 tail | Not started (services already on Supabase) |
| 5 | 4 Safety & compliance | 2 wks | Phase 3 tail | Not started |
| 6 | 5 Quality | 1–2 wks | Phase 4 | Not started |
| 7 | 6 Pilot | 3–4 wks running | store account setup | Not started |
| 8 | 7 Store submission | 2–3 wks | — | Not started |
| 9 | 8 Launch & operate | ongoing | — | — |

At ~10 hours/week with Claude doing the typing, that's roughly **4–6 months** to a public store listing, with a working pilot on phones around month 3. If Omar and you can put in more, Phases 1/2 and 3/4 overlap well because they touch different files.

---

## 5. Decision log

| # | Phase | Decision | Status |
|---|---|---|---|
| 1 | 1 | Backend | **Supabase** — migration done Oct 9 |
| 2 | 0 | Domain | Buy one (~$12/yr); name pending |
| 3 | 0 | Repo | Move to a shared GitHub org; Christian to raise with Omar |
| 4 | 1 | Visual direction | Pending — choose from the three options |
| 5 | 1 | App name | "Pods" (available as plain name per Christian's App Store check) |
| 6 | 1 | Activity chat entry | Activity detail **and** inbox; both show "ended" for 24 h |
| 7 | 2 | Roles | Owner + admins (+ owner-set role labels) + members |
| 8 | 2 | University-wide activities | Pod owners may broadcast; separate **Campus** feed for pod-less activities |
| 9 | 2 | Join requests | Expire with the activity |
| 10 | 2 | Expired chat | Locked at expiry, deleted after 24 h |
| 11 | 2 | Per-pod mute | Yes |
| 12 | 3 | Public pod activity preview | Yes, read-only |
| 13 | 3 | Host removes participant | **No** (troll risk); report/leave/owner-delete instead |
| 14 | 3 | Activity editing | Until start time |
| 15 | 4 | First-line moderation | Pod owner/admin can remove members and delete activities |
| 16 | 4 | Moderator email of record | Pending — who monitors `support@` |
| 17 | 6 | Pilot seeding | Direct club outreach + "start a pod" interest form; pods default public/open join |
| 18 | 6 | Pilot start week | Pending — set after Phase 0 |
| 19 | 7 | Apple enrollment | Pending — individual vs LLC (individual is faster and fine for a pilot; an LLC matters only if you want a company name shown and liability separation) |
| 20 | 1b | Pilot wedge | **Class study pods first**; clubs second; Greek life/events as ordinary pods only |
| 21 | 1b | Pre-build validation | Run 3–4 study sessions this month before Phase 1/2 start in earnest |
| 22 | 4 | Reliability features | Attendance marking, reliability signal, private no-show cooldown |
| 23 | — | Company | Form later (before public listing), likely Florida LLC; founders' agreement with vesting now; Pranav/Manar as earn-in contributors, not equal partners |
| 24 | 2 | Migration approach (Oct 9) | Like-for-like port first ("functionality stays the same"), relational v1 schema later as new migrations |
| 25 | 2 | Sign-in (Oct 9) | Email + password, with 6-digit emailed codes for sign-up verification and password reset (no links/deep links). Revisit passwordless code-only login in Phase 3 |
| 26 | 2 | Email sending (Oct 9) | Gmail SMTP (app password) for testing; domain sender (e.g. Resend) before the pilot |
| 27 | 0 | Git workflow (Oct 9) | Branch from freshly pulled `main` → PR → merge → pull `main` and delete the branch |

---

## 6. Immediate next actions

*Updated October 9, 2026.*

1. **Christian (10 min): delete the old Firebase project.** Nothing uses it, and its config is public in git history.
2. **Christian + Omar: run the validation sessions (§1b).** The app now works end to end on Supabase, so it can be used for them. Pick two classes, post a study session, and count who shows.
3. **Christian: start the calendar-time items** — buy the domain (unblocks the bundle ID, the support address and the email sender), start Apple Developer enrollment, and move the repo into a shared GitHub org with Omar.
4. **Claude: remaining Phase 0 packages** — WP-6 (`CLAUDE.md`; the stack is now Supabase), WP-4 (lint, typecheck, tests, CI), WP-5 (EAS development build; needs the bundle ID from the domain).
5. **Both: pick a visual direction**, then Phase 1 (design system) and the rest of Phase 2 (v1 schema, `.edu`/BU domain hook, `pg_cron` expiry) run in parallel.
