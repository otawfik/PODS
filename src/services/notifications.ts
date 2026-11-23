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
// It also reports notification taps (subscribeToNotificationTaps) so the
// navigation layer can open the right screen, and keeps chat pushes quiet
// while that chat is on screen (setActiveChat).
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

/** The `data` the server attaches to every push (supabase/functions/_shared/push.ts). */
export interface PushData {
  type: string;
  activityId?: string;
  podId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a notification's `data`. Ids that are not UUIDs are dropped. */
export function parsePushData(data: unknown): PushData | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, activityId, podId } = data as Record<string, unknown>;
  if (typeof type !== 'string' || !type) return null;
  const parsed: PushData = { type };
  if (typeof activityId === 'string' && UUID.test(activityId)) parsed.activityId = activityId;
  if (typeof podId === 'string' && UUID.test(podId)) parsed.podId = podId;
  return parsed;
}

// ---------- Chat on screen ----------

export const activityChatKey = (activityId: string) => `activity:${activityId}`;
export const podChatKey = (podId: string) => `pod:${podId}`;

/** The chat the user is looking at right now, if any. */
let activeChat: string | null = null;

/**
 * Tell the notification handler which chat is on screen. Returns a cleanup
 * to call when the chat is hidden (use it as an effect cleanup).
 */
export function setActiveChat(key: string): () => void {
  activeChat = key;
  return () => {
    if (activeChat === key) activeChat = null;
  };
}

/** True for a chat_message push that belongs to the chat on screen. */
export function isForActiveChat(data: unknown): boolean {
  const push = parsePushData(data);
  if (!activeChat || push?.type !== 'chat_message') return false;
  const key = push.activityId
    ? activityChatKey(push.activityId)
    : push.podId
      ? podChatKey(push.podId)
      : null;
  return key === activeChat;
}

/**
 * Show notifications that arrive while the app is open, except chat messages
 * for the chat already on screen. Call once at startup.
 */
export function configureForegroundNotifications(): void {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = !isForActiveChat(notification.request.content.data);
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        // On Android, no sound also means no heads-up banner.
        shouldPlaySound: show,
        shouldSetBadge: false,
      };
    },
  });
}

// ---------- Taps ----------

/** Last tap handled, so a cold-start response is not delivered twice. */
let lastHandledTap: string | null = null;

/**
 * Calls `onTap` with the notification's `data` when the user taps a
 * notification: while the app is running or in the background, and once for
 * the tap that launched the app. Returns an unsubscribe function.
 */
export function subscribeToNotificationTaps(onTap: (data: unknown) => void): () => void {
  if (Platform.OS === 'web') return () => {};
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (id === lastHandledTap) return;
    lastHandledTap = id;
    onTap(response.notification.request.content.data);
  };
  try {
    // The tap that opened the app (cold start) arrives before any listener.
    handle(Notifications.getLastNotificationResponse());
    Notifications.clearLastNotificationResponse();
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    return () => subscription.remove();
  } catch (err: unknown) {
    console.warn('Notification taps unavailable', err);
    return () => {};
  }
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
