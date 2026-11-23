// src/navigation/linking.ts: which screen a pods:// path opens, and which
// path a tapped notification maps to.

import { getStateFromPath } from '@react-navigation/native';
import {
  actionForPath,
  linking,
  pathFromNotificationData,
  pathFromUrl,
} from '../src/navigation/linking';

jest.mock('../src/services/supabase', () => ({ supabase: {}, check: jest.fn() }));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-device', () => ({ isDevice: true }));

const ACTIVITY = '11111111-1111-4111-8111-111111111111';
const POD = '22222222-2222-4222-8222-222222222222';

type RouteNode = {
  name: string;
  params?: Record<string, unknown>;
  state?: { index?: number; routes: RouteNode[] };
};

/** Route names from the root down to the focused screen, plus its params. */
function resolve(path: string): { names: string[]; params?: Record<string, unknown> } | null {
  const state = getStateFromPath(path, linking.config) as { routes: RouteNode[] } | undefined;
  if (!state) return null;
  const names: string[] = [];
  let node: RouteNode = state.routes[state.routes.length - 1];
  for (;;) {
    names.push(node.name);
    if (!node.state) return { names, params: node.params };
    node = node.state.routes[node.state.index ?? node.state.routes.length - 1];
  }
}

describe('linking config', () => {
  it('uses the pods:// scheme', () => {
    expect(linking.prefixes).toEqual(['pods://']);
  });

  it('parses each path to its screen and params', () => {
    expect(resolve(`activity/${ACTIVITY}`)).toEqual({
      names: ['Main', 'Discover', 'ActivityDetail'],
      params: { activityId: ACTIVITY },
    });
    expect(resolve(`pod/${POD}`)).toEqual({
      names: ['Main', 'MyPods', 'PodDetail'],
      params: { podId: POD },
    });
    expect(resolve(`chat/${ACTIVITY}`)).toEqual({
      names: ['Main', 'Messages', 'Chat'],
      params: { activityId: ACTIVITY },
    });
  });

  it("puts the tab's home screen under a linked screen, so Back works", () => {
    const state = getStateFromPath(`chat/${ACTIVITY}`, linking.config) as { routes: RouteNode[] };
    const stack = state.routes[0].state!.routes[0].state!;
    expect(stack.routes.map((r) => r.name)).toEqual(['MessagesList', 'Chat']);
  });

  it('does not match unknown paths', () => {
    expect(resolve('settings')).toBeNull();
    expect(resolve('expo-development-client/?url=http://localhost:8081')).toBeNull();
    expect(actionForPath('nope/123')).toBeUndefined();
  });

  it('builds a navigate action into the nested screen', () => {
    expect(actionForPath(`activity/${ACTIVITY}`)).toMatchObject({
      type: 'NAVIGATE',
      payload: {
        name: 'Main',
        params: {
          screen: 'Discover',
          params: { screen: 'ActivityDetail', params: { activityId: ACTIVITY }, initial: false },
        },
      },
    });
  });
});

describe('pathFromUrl', () => {
  it('strips the scheme and ignores other URLs', () => {
    expect(pathFromUrl(`pods://activity/${ACTIVITY}`)).toBe(`activity/${ACTIVITY}`);
    expect(pathFromUrl(`pods:///pod/${POD}`)).toBe(`pod/${POD}`);
    expect(pathFromUrl('pods://')).toBeNull();
    expect(pathFromUrl('exp://192.168.1.5:8081')).toBeNull();
    expect(pathFromUrl('https://example.com/activity/1')).toBeNull();
    expect(pathFromUrl(null)).toBeNull();
  });
});

describe('pathFromNotificationData', () => {
  it('opens the activity for requests, decisions and new activities', () => {
    for (const type of [
      'join_request',
      'participant_joined',
      'request_approved',
      'request_declined',
      'new_activity',
    ]) {
      expect(pathFromNotificationData({ type, activityId: ACTIVITY, podId: POD })).toBe(
        `activity/${ACTIVITY}`,
      );
    }
  });

  it('opens the activity chat or the pod for chat messages', () => {
    expect(pathFromNotificationData({ type: 'chat_message', activityId: ACTIVITY })).toBe(
      `chat/${ACTIVITY}`,
    );
    expect(pathFromNotificationData({ type: 'chat_message', podId: POD })).toBe(`pod/${POD}`);
    expect(pathFromNotificationData({ type: 'chat_message' })).toBeNull();
  });

  it('falls back to the pod, and to nothing', () => {
    expect(pathFromNotificationData({ type: 'new_activity', podId: POD })).toBe(`pod/${POD}`);
    expect(pathFromNotificationData({ type: 'something_new', activityId: ACTIVITY })).toBe(
      `activity/${ACTIVITY}`,
    );
    expect(pathFromNotificationData({ type: 'join_request' })).toBeNull();
  });

  it('ignores data that is missing, malformed, or carries a non-UUID id', () => {
    expect(pathFromNotificationData(null)).toBeNull();
    expect(pathFromNotificationData('activity/1')).toBeNull();
    expect(pathFromNotificationData({ activityId: ACTIVITY })).toBeNull(); // no type
    expect(pathFromNotificationData({ type: 'join_request', activityId: 42 })).toBeNull();
    expect(
      pathFromNotificationData({ type: 'join_request', activityId: '../pod/x?admin=1' }),
    ).toBeNull();
  });

  it('every path it produces is one the linking config can open', () => {
    const samples = [
      { type: 'join_request', activityId: ACTIVITY },
      { type: 'chat_message', activityId: ACTIVITY },
      { type: 'chat_message', podId: POD },
    ];
    for (const data of samples) {
      expect(actionForPath(pathFromNotificationData(data)!)).toBeDefined();
    }
  });
});
