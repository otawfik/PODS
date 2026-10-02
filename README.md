# PODS

### Find your people. Do the thing.

**PODS** is a cross-platform mobile and web app that helps college students turn "we should hang out sometime" into actual plans. Create or join temporary, activity-based communities ("Pods") for studying, working out, grabbing food, playing sports, gaming, and more. When the activity ends, the Pod ends. No dead group chats, no planning paralysis.

![React Native](https://img.shields.io/badge/React_Native-61DAFB?logo=react&logoColor=black) ![Expo](https://img.shields.io/badge/Expo-000020?logo=expo&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Firebase](https://img.shields.io/badge/Firebase-FFCA28?logo=firebase&logoColor=black) ![iOS](https://img.shields.io/badge/iOS-000000?logo=apple&logoColor=white) ![Android](https://img.shields.io/badge/Android-3DDC84?logo=android&logoColor=white) ![Web](https://img.shields.io/badge/Web-4285F4?logo=googlechrome&logoColor=white)

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
- Pod group chats powered by Firebase Realtime Database
- Direct 1:1 messaging between members
- Live message updates, no refresh needed

**Accounts & profiles**
- Email sign-up and login with Firebase Authentication
- Editable user profiles

**Polish**
- Cross-platform: iOS, Android, and web from a single codebase
- Light and dark mode

---

## Tech stack

| Layer | Technology |
|---|---|
| App | React Native, Expo SDK 54, TypeScript |
| Auth | Firebase Authentication |
| Database | Cloud Firestore |
| Real-time messaging | Firebase Realtime Database |
| Navigation | React Navigation (stack + bottom tabs) |

---

## Getting started

**Prerequisites:** Node.js, npm, and the Expo Go app on your phone for device testing.

```bash
git clone https://github.com/otawfik/PODS.git
cd PODS
npm install
```

**Run it:**

```bash
npx expo start
```

- **On your phone:** scan the QR code with the Expo Go app (phone and computer on the same Wi-Fi).
- **On the web:** press `w` in the terminal, or run `npx expo start --web`.
- **Clear the cache if something looks stale:** `npx expo start -c`

**Firebase setup:** the app uses Firebase for auth, database, and messaging. Add your Firebase web config to the environment (see `src/services/firebase.ts`) before running.

---

## Project structure

```
src/
  components/    Reusable UI (PodCard, ActivityCard, MessageBubble, ...)
  screens/       Auth, Discover, Pods, Activities, Messages, Profile
  services/      Firebase-backed data layer (auth, pods, activities, chat)
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
