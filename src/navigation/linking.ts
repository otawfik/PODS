import {
  createNavigationContainerRef,
  getActionFromState,
  getStateFromPath,
  type LinkingOptions,
  type PathConfig,
} from '@react-navigation/native';
import {
  DiscoverStackParamList,
  MessagesStackParamList,
  PodsStackParamList,
  RootStackParamList,
} from '../types';
import { parsePushData } from '../services/notifications';

// Deep links. One table (`linking.config`) says which path opens which
// screen; both `pods://…` URLs and notification taps go through it.
//
//   pods://activity/<activityId>  → Discover tab → ActivityDetail
//   pods://pod/<podId>            → My Pods tab  → PodDetail (opens on its chat)
//   pods://chat/<activityId>      → Messages tab → Chat (activity chat)
//
// Each stack names its first screen, so Back from a linked screen lands on
// the tab's home instead of leaving the app.
//
// Links are dispatched by useDeepLinks (which waits for sign-in) rather than
// by NavigationContainer's built-in handling, which drops a link that
// arrives while the signed-in screens are not mounted.

export const URL_SCHEME = 'pods';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Each tab's stack is typed on its own: TypeScript checks the screen names,
// and `initialRouteName` puts the tab's home under the linked screen.
const discover: PathConfig<DiscoverStackParamList> = {
  initialRouteName: 'DiscoverFeed',
  screens: { ActivityDetail: 'activity/:activityId' },
};
const myPods: PathConfig<PodsStackParamList> = {
  initialRouteName: 'MyPods',
  screens: { PodDetail: 'pod/:podId' },
};
const messages: PathConfig<MessagesStackParamList> = {
  initialRouteName: 'MessagesList',
  screens: { Chat: 'chat/:activityId' },
};

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [`${URL_SCHEME}://`],
  config: {
    screens: {
      Main: { screens: { Discover: discover, MyPods: myPods, Messages: messages } },
    },
  },
};

/** `pods://activity/123` → `activity/123`; null for other schemes. */
export function pathFromUrl(url: string | null | undefined): string | null {
  const prefix = `${URL_SCHEME}://`;
  if (!url || !url.toLowerCase().startsWith(prefix)) return null;
  const path = url.slice(prefix.length).replace(/^\/+/, '');
  return path || null;
}

/**
 * Which path a tapped notification opens, from its `data`
 * ({ type, activityId, podId }; see supabase/functions/_shared/push.ts).
 * Null when there is nothing to open.
 */
export function pathFromNotificationData(data: unknown): string | null {
  const push = parsePushData(data);
  if (!push) return null;
  if (push.type === 'chat_message') {
    // Activity chat → that chat; pod chat → the pod (its first tab is Chat).
    if (push.activityId) return `chat/${push.activityId}`;
    return push.podId ? `pod/${push.podId}` : null;
  }
  // Requests, decisions and new activities all open the activity.
  if (push.activityId) return `activity/${push.activityId}`;
  return push.podId ? `pod/${push.podId}` : null;
}

/** The navigation action for a path, or undefined if no screen matches it. */
export function actionForPath(path: string) {
  const state = getStateFromPath(path, linking.config);
  return state ? getActionFromState(state, linking.config) : undefined;
}
