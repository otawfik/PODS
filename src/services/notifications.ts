import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { supabase, check } from './supabase';

// Push notifications: permission, Expo push token, and registering the token
// with the backend (register_push_token). The server decides who gets what
// (supabase/migrations/20261118000100_push_notifications.sql); the app only
// tells it where this device can be reached.
//
// Push needs a real device and a development/production build with an EAS
// projectId. Expo Go on Android, simulators, web, and builds without a
// projectId are skipped quietly.

export type PushSkipReason =
  | 'unsupported-platform'
  | 'simulator'
  | 'expo-go-android'
  | 'no-project-id'
  | 'permission-denied'
  | 'error';

export type PushRegistrationResult =
  { status: 'registered'; token: string } | { status: 'skipped'; reason: PushSkipReason };

/** Token registered by this app session, so sign-out can remove it. */
let registeredToken: string | null = null;
/** Ask for permission at most once per app session. */
let askedThisSession = false;

/** Show notifications that arrive while the app is open. Call once at startup. */
export function configureForegroundNotifications(): void {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      // On Android, no sound also means no heads-up banner.
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

function getProjectId(): string | null {
  const fromConfig: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromConfig === 'string' && fromConfig) return fromConfig;
  const fromEas = Constants.easConfig?.projectId;
  return typeof fromEas === 'string' && fromEas ? fromEas : null;
}

function unavailableReason(): PushSkipReason | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 'unsupported-platform';
  if (!Device.isDevice) return 'simulator';
  if (
    Platform.OS === 'android' &&
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  ) {
    return 'expo-go-android';
  }
  if (!getProjectId()) return 'no-project-id';
  return null;
}

async function hasPermission(prompt: boolean): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!prompt || !current.canAskAgain || askedThisSession) return false;
  askedThisSession = true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

/**
 * Register this device for push. With `prompt: false` (on sign-in) it only
 * refreshes the token if permission was already granted. With `prompt: true`
 * (after the user's first join request or created activity) it may show the
 * system permission dialog. Never throws.
 */
export async function registerForPushNotifications({
  prompt,
}: {
  prompt: boolean;
}): Promise<PushRegistrationResult> {
  const reason = unavailableReason();
  if (reason) {
    if (reason === 'no-project-id') {
      console.info('Push notifications skipped: no EAS projectId in the app config yet.');
    }
    return { status: 'skipped', reason };
  }
  try {
    if (Platform.OS === 'android') {
      // Android 13+ shows the permission dialog only once a channel exists.
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    if (!(await hasPermission(prompt))) return { status: 'skipped', reason: 'permission-denied' };

    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId: getProjectId() ?? undefined,
    });
    check(await supabase.rpc('register_push_token', { p_token: token, p_platform: Platform.OS }));
    registeredToken = token;
    return { status: 'registered', token };
  } catch (err: unknown) {
    console.warn('Push registration failed', err);
    return { status: 'skipped', reason: 'error' };
  }
}

/** Fire-and-forget prompt after a user action that makes push worthwhile. */
export function askForPushAfterAction(): void {
  void registerForPushNotifications({ prompt: true });
}

/** Remove this device's token before signing out. Never throws. */
export async function unregisterPushToken(): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  registeredToken = null;
  try {
    check(await supabase.rpc('unregister_push_token', { p_token: token }));
  } catch (err: unknown) {
    console.warn('Could not unregister push token', err);
  }
}
