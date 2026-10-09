# Pods — Phase 0 Work Packages (Foundation & Hygiene)

*Companion to `pods-roadmap.md`. Each package is one Claude session. Do them in order; WP-0 through WP-2 are yours, the rest are Claude's. Every package ends with a "You check" list you can run without reading code.*

**Status — October 9, 2026.** The Firebase → Supabase migration landed early (see the status section of `pods-roadmap.md`). That changes several packages below; each change is marked **Update (Oct 9)**. Summary: the Supabase project exists (WP-0 step 3 ✅); environment config is done (WP-3 step 2–3, done differently); Firebase code is gone, so WP-7 becomes "delete the project"; `docs/` now exists in the repo (WP-6 partly ✅). The app is on Expo SDK 57 / React Native 0.86, not SDK 54 / RN 0.81.

**How to run a Claude package:** open the repo folder in Claude (Cowork or Claude Code), paste the block under **Prompt** verbatim, let it work, run the **You check** steps, then paste `git diff main` plus the goal line to ChatGPT with "review this for bugs and anything that contradicts the goal." Merge when both are happy.

**Git routine for every package:** `git checkout main && git pull` → `git checkout -b <branch>` → work → `git push` (first push of a branch needs `--set-upstream origin <branch>`, or set `git config --global push.autoSetupRemote true` once) → open the PR on GitHub → merge → `git checkout main && git pull && git branch -d <branch>`.

---

## WP-0 · Accounts & purchases (you, ~1 hour of clicking, several days of waiting)

Nothing here needs code, but all of it is calendar time, so start today.

1. **Domain.** Buy one (Cloudflare Registrar or Porkbun are the cheap, no-upsell options — around $10–15/year for `.app` or `.co`). `.app` domains force HTTPS, which is fine for you. Write the domain down; WP-3 needs it.
2. **GitHub organization.** Create a free org (e.g. `pods-app`), add Omar as an owner. Ask Omar to *Transfer ownership* of `otawfik/PODS` to the org (repo Settings → Danger Zone → Transfer). History, PRs, and the old URL redirect all survive.
3. **Supabase.** ✅ **Update (Oct 9):** done — project ref `utnezmiwsftmcijwuika`, free plan, schema applied. Keep the database password in a password manager.
4. **Expo account.** Sign up at expo.dev (free). Create an organization there too and invite Omar, so builds aren't tied to one personal account.
5. **Apple Developer Program.** Enroll at developer.apple.com/programs as an **individual** ($99/year). Use your legal name; it shows as the seller. Enrollment can take 24–48 h and sometimes asks for ID. Decide later if you want an LLC — you can transfer the app to a company account afterwards.
6. **Google Play Console.** Register at play.google.com/console ($25 one-time). Identity verification can take a few days. Once in, note the "12 testers for 14 days" requirement — you'll satisfy it during the pilot.
7. **A shared email.** Create `hello@<yourdomain>` (Cloudflare Email Routing forwards it to both your Gmails for free). This becomes the support/moderation address in both store listings. **Update (Oct 9):** verification codes currently send through Christian's personal Gmail (Supabase → Authentication → Emails → SMTP Settings); once the domain exists, switch SMTP to a domain sender such as Resend.

**You check:** you can log in to all six services; Omar is an owner on GitHub org and Expo org; the repo lives at `github.com/<org>/PODS`.

---

## WP-1 · Local working copy hygiene (you, 15 minutes)

1. Move `Desktop/PODS/Pods.zip` somewhere outside the repo folder (or delete it — it's a stale April snapshot).
2. After the org transfer, in Terminal: `cd ~/Desktop/PODS/PODS && git remote set-url origin https://github.com/<org>/PODS.git && git pull` so your local copy points at the org repo.
3. **Update (Oct 9):** the roadmap files now live inside the repo in `docs/`. The copies in the claude.ai "Pods" project are kept in sync with them.

**You check:** `git remote -v` shows the org URL; `git status` is clean.

---

## WP-2 · Decide the identifiers (you, 5 minutes — write the answers down)

Claude needs these literal values in WP-3. Fill in and keep in a note:

- Domain: `________` (from WP-0)
- Reverse-DNS prefix: `app.<domain-without-tld>` → e.g. domain `joinpods.app` → prefix `app.joinpods`
- iOS bundle identifier: `<prefix>.pods` → e.g. `app.joinpods.pods`
- Android package: same string
- URL scheme for deep links: `pods`
- App display name: `Pods`
- Expo org slug: `________` (from WP-0 step 4)

---

## WP-3 · Repo cleanup and identifiers (Claude)

**Goal:** the repo has no stray files and has the real app identifiers.

**Update (Oct 9):** environment config is already done — `app.config.js` exists, Supabase settings come from `.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) and are read in `src/services/supabase.ts`, `.env.example` is committed, `.env` is ignored, and there are no Firebase keys left in source. The prompt below is trimmed to what remains.

**Prompt:**

> You are working in the Pods repo (Expo SDK 57, React Native 0.86, TypeScript, Supabase backend). Do the following and nothing else, in one branch called `chore/foundation`:
>
> 1. Remove every `.DS_Store` file from the repo and confirm `.DS_Store`, `.env` and `.env.*` (except `.env.example`) are in `.gitignore`.
> 2. Convert `app.config.js` to `app.config.ts`. Set: `name: "Pods"`, `slug: "pods"`, `owner: "<EXPO ORG SLUG>"`, `version: "0.1.0"`, `scheme: "pods"`, `ios.bundleIdentifier: "<BUNDLE ID>"`, `ios.supportsTablet: false`, `android.package: "<BUNDLE ID>"`, `userInterfaceStyle: "automatic"`. Keep the existing icon/splash/adaptive-icon paths and plugins. Keep reading Supabase settings from the `EXPO_PUBLIC_SUPABASE_*` variables as today.
> 3. Run `npx expo-doctor` and fix anything it flags that is within the scope above.
> 4. Make sure the app still starts, then commit with a clear message and open a PR titled "Foundation: identifiers, repo hygiene". In the PR description list every file changed and why.
>
> Replace `<EXPO ORG SLUG>` and `<BUNDLE ID>` with: `________` and `________`.

**You check:**
- `git status` on `main` after merge shows no `.DS_Store`.
- `npx expo start` → the app opens to the Welcome screen and you can log in.
- `app.config.ts` contains your bundle ID; `app.config.js` is gone.

---

## WP-4 · Tooling: lint, format, typecheck, tests, CI (Claude)

**Goal:** every PR is automatically checked, and the checks pass on the current code.

**Prompt:**

> In the Pods repo, on a branch `chore/tooling`, set up developer tooling. Do not change application behavior.
>
> 1. Add ESLint using `eslint-config-expo` and Prettier (2-space, single quotes, trailing commas `all`, print width 100). Add scripts: `lint`, `lint:fix`, `format`, `typecheck` (`tsc --noEmit`), `test` (`jest`).
> 2. Add Jest via `jest-expo` with `@testing-library/react-native`. Write one real smoke test that renders `src/components/CategoryChip.tsx` and asserts the label appears.
> 3. Add `.github/workflows/ci.yml` that runs `npm ci`, `lint`, `typecheck`, and `test` on every pull request and on push to `main`, Node 20, with npm caching.
> 4. Run `lint:fix` and `format` across the repo, then fix any remaining lint or type errors by hand. Report each non-trivial fix in the PR description. If a fix would change behavior, leave a `// TODO(phase-3):` comment instead and list it in the PR.
> 5. Open a PR titled "Tooling: ESLint, Prettier, Jest, CI".

**You check:**
- The PR page on GitHub shows a green check named "CI".
- Locally: `npm run lint && npm run typecheck && npm test` all pass.

---

## WP-5 · EAS + development build (Claude, with you on the phone)

**Goal:** you can install a development build of Pods on your real iPhone and Android phone from EAS, without Expo Go.

**Prompt:**

> In the Pods repo, on branch `chore/eas`, set up EAS Build.
>
> 1. Install `expo-dev-client`. Run `npx eas init` (I will log in when prompted) and `npx eas build:configure`.
> 2. Write `eas.json` with three profiles: `development` (`developmentClient: true`, `distribution: internal`, iOS simulator variant too), `preview` (`distribution: internal`, for TestFlight/Play internal later), `production` (`autoIncrement: true`). Provide `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to builds via EAS environment variables per profile (local development keeps using `.env`), and document in `README.md` how to set them with `eas env:create`.
> 3. Install `expo-updates` and configure it for EAS Update with `runtimeVersion: { policy: "appversion" }` and a `channel` per profile matching the profile name. Do not publish an update yet.
> 4. Add a `README.md` section "Running the app" that explains, for a non-expert: install the dev build on a phone via the QR code EAS prints, then `npx expo start --dev-client`.
> 5. Open a PR titled "EAS Build, dev client, EAS Update config".

Then, with you present: `eas build --profile development --platform ios` (needs your Apple account signed in; EAS creates certificates for you) and `--platform android`. Builds take 10–20 minutes on the free queue.

**You check:**
- A Pods app icon appears on your iPhone and on an Android phone/emulator, and it opens to the Welcome screen when Metro (`npx expo start --dev-client`) is running on your Mac.
- The EAS dashboard at expo.dev shows both builds as finished.

---

## WP-6 · `CLAUDE.md` and code-quality cleanup (Claude)

**Goal:** every future Claude session starts with the right context, and the small inconsistencies that would otherwise get copied into new screens are gone.

**Update (Oct 9):** `docs/` already exists with the roadmap and this file. `firebaseUser: any` is gone (AuthContext now exposes a typed Supabase `authUser`), and the read-then-write counters were moved into Postgres functions, so those cleanup items are dropped.

**Prompt:**

> In the Pods repo, on branch `chore/claude-md`, do two things.
>
> **A. Project context.** Create `CLAUDE.md` at the repo root containing: a two-paragraph description of Pods (campus app; pods are communities; activities are time-bound posts inside a pod or campus-wide; hosts approve join requests; temporary chats expire); the stack (Expo SDK 57, RN 0.86, TypeScript strict, React Navigation 7, Supabase — Postgres with Row Level Security, business rules as RPC functions in `supabase/migrations/`, Auth with emailed 6-digit codes, Realtime chat); the folder layout; how to run the app (`.env` from `.env.example`, `npx expo start -c`); naming conventions (screens `*Screen.tsx`, one component per file, data access only through `src/services/` — moving to `src/api/` in Phase 3); and a "Rules" list: never use `any`; never use `Alert.alert` for validation errors (inline field errors instead); no raw hex colors outside `src/theme/`; every new screen handles loading, empty and error states; business rules live in the backend (RLS + RPC), never in the client; schema changes are new numbered migration files, never edits to applied ones; every PR under ~400 lines; run `npm run lint && npm run typecheck && npm test` before opening a PR. Link to `docs/pods-roadmap.md`.
>
> **B. Cleanup, no behavior change.** (1) Use `SafeAreaView` from `react-native-safe-area-context` everywhere; remove the import from `react-native` in `RegisterScreen`, `LoginScreen`, `WelcomeScreen`, `VerifyEmailScreen`. (2) Move the string `'#FFFFFF'` used for button text into the theme as `colors.onPrimary` and replace usages. (3) Delete any dead imports lint reports.
>
> Open a PR titled "CLAUDE.md and small cleanup" and list every change.

**You check:**
- `CLAUDE.md` exists and reads accurately to you — edit any sentence that's wrong; it's the file that steers every future session.
- CI is green; the app still starts.

---

## WP-7 · Delete the old Firebase project (you, 5 minutes)

**Update (Oct 9):** the app no longer uses Firebase at all, so instead of locking the rules, delete the project. Its config stays visible in git history, and deleting the project makes it useless.

1. Firebase console → select the old Pods project → Project settings (gear icon) → General → scroll to the bottom → **Delete project**, and confirm.
2. If you'd rather keep it around for a while, at minimum set Firestore rules to `allow read, write: if false;` and Realtime Database rules to `{ "rules": { ".read": false, ".write": false } }`.

**You check:** the project no longer appears in the Firebase console (or its rules deny everything), and the Pods app still works — it talks only to Supabase.

---

## Phase 0 exit criteria

- [ ] Org repo, Expo org, Apple + Google accounts, domain, shared email — all exist (Supabase project ✅)
- [ ] `main` has: `app.config.ts` with real identifiers, `.env.example` ✅, ESLint/Prettier/Jest, CI green, `eas.json`, `expo-updates`, `CLAUDE.md`, `docs/` ✅
- [ ] Development build installed on at least one iPhone and one Android device
- [ ] Firebase project deleted (or locked)
- [ ] Visual direction chosen (from the design canvas) → Phase 1 design system starts

**Then:** Phase 1 (design system + mockups) and the rest of Phase 2 (v1 relational schema, BU domain hook, `pg_cron` expiry, push, storage) start in parallel. The Phase 2 packages build on the October 9 migration rather than starting from scratch.
