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

**Accounts & profiles**
- Email sign-up and login with Supabase Auth (6-digit email verification and password-reset codes)
- Editable user profiles

**Polish**
- Cross-platform: iOS, Android, and web from a single codebase
- Light and dark mode

---

## Tech stack

| Layer | Technology |
|---|---|
| App | React Native, Expo SDK 54, TypeScript |
| Auth | Supabase Auth (email + password, emailed codes) |
| Database | Supabase Postgres with Row Level Security (`supabase/migrations/`) |
| Real-time messaging | Supabase Realtime |
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

---

## Project structure

```
src/
  components/    Reusable UI (PodCard, ActivityCard, MessageBubble, ...)
  screens/       Auth, Discover, Pods, Activities, Messages, Profile
  services/      Supabase-backed data layer (auth, pods, activities, chat)
  navigation/    Stack and tab navigators
  context/       Auth and theme providers
  constants/     Categories, tags, colors
  types/         Shared TypeScript types
```

---

## Roadmap

- Push notifications for activity reminders and new messages
- Location-based Pod discovery ("what's happening near me")
- Recurring activities and RSVP headcounts
- Pod ratings and member reputation
- Campus ambassador program for launch at new schools

---

## Team

- **Omar Tawfik** — co-founder, engineering
- **Christian Johnson** — co-founder, engineering

Built by students, for students.
