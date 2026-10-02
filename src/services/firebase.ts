import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
  getReactNativePersistence,
  Auth,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Firebase config comes from environment variables (EXPO_PUBLIC_FIREBASE_*),
// wired through app.config.js `extra`. See .env.example. No secrets in git.
const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

const firebaseConfig = {
  apiKey: extra.firebaseApiKey as string,
  authDomain: extra.firebaseAuthDomain as string,
  projectId: extra.firebaseProjectId as string,
  storageBucket: extra.firebaseStorageBucket as string,
  messagingSenderId: extra.firebaseMessagingSenderId as string,
  appId: extra.firebaseAppId as string,
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
