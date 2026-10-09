import 'react-native-url-polyfill/auto';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Supabase config comes from environment variables (EXPO_PUBLIC_SUPABASE_*)
// in .env (see .env.example). Expo inlines EXPO_PUBLIC_* vars at bundle time,
// so they must be referenced with static `process.env.X` access.
// The publishable key is safe to ship in the app: Row Level Security
// (supabase/migrations) decides what each signed-in user can read or write.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase config (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY). ' +
      'Copy .env.example to .env, fill in your Supabase project values, and restart Expo.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // Persist the session so users stay signed in across cold starts.
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// On native, only refresh the session token while the app is in the
// foreground (recommended by Supabase for React Native).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}

/** Throw a plain Error carrying Supabase's message (screens show err.message). */
export function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export default supabase;
