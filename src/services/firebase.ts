import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
  getReactNativePersistence,
  Auth,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// Firebase config comes from environment variables (EXPO_PUBLIC_FIREBASE_*)
// in .env (see .env.example). Expo inlines EXPO_PUBLIC_* vars at bundle time,
// so they must be referenced with static `process.env.X` access. No secrets in git.
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY as string,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN as string,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID as string,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID as string,
};

const missingKeys = (['apiKey', 'authDomain', 'projectId', 'appId'] as const).filter(
  (k) => !firebaseConfig[k]
);
if (missingKeys.length > 0) {
  throw new Error(
    `Missing Firebase config (${missingKeys.join(', ')}). ` +
      `Copy .env.example to .env, fill in your Firebase project values, and restart Expo.`
  );
}

const app: FirebaseApp =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// On native, getAuth() defaults to in-memory persistence, which signs users
// out on every cold start. Use AsyncStorage-backed persistence instead.
let auth: Auth;
if (Platform.OS === 'web') {
  auth = getAuth(app);
} else {
  try {
    auth = initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    // Module re-executed (e.g. Fast Refresh): reuse the existing instance.
    auth = getAuth(app);
  }
}

export { auth };
export const db = getFirestore(app);
export default app;
