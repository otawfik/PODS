// src/services/supabase.ts refuses to load without these. Tests never reach a
// real project (services are mocked), so placeholder values are enough.
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'sb_publishable_test';
