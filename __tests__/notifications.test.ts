// src/services/notifications.ts: skips cleanly where push can't work, and
// registers / unregisters the token through the RPCs where it can.

type NotificationsModule = typeof import('../src/services/notifications');

const mockRpc = jest.fn();
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetToken = jest.fn();
let mockIsDevice = true;
let mockExtra: Record<string, unknown> = {};

jest.mock('../src/services/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  check: <T>(r: { data: T; error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  },
}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: () => mockGetPermissions(),
  requestPermissionsAsync: () => mockRequestPermissions(),
  getExpoPushTokenAsync: (opts: unknown) => mockGetToken(opts),
}));
jest.mock('expo-device', () => ({
  get isDevice() {
    return mockIsDevice;
  },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' },
  default: {
    executionEnvironment: 'standalone',
    get expoConfig() {
      return { extra: mockExtra };
    },
    easConfig: null,
  },
}));

const TOKEN = 'ExponentPushToken[device-1]';

function load(): NotificationsModule {
  let mod: NotificationsModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<NotificationsModule>('../src/services/notifications');
  });
  return mod!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDevice = true;
  mockExtra = { eas: { projectId: 'project-123' } };
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockGetPermissions.mockResolvedValue({ granted: true, canAskAgain: true });
  mockRequestPermissions.mockResolvedValue({ granted: true });
  mockGetToken.mockResolvedValue({ data: TOKEN });
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

it('skips without an EAS projectId, without calling Expo or the backend', async () => {
  mockExtra = {};
  const result = await load().registerForPushNotifications({ prompt: true });
  expect(result).toEqual({ status: 'skipped', reason: 'no-project-id' });
  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRpc).not.toHaveBeenCalled();
});

it('skips on simulators', async () => {
  mockIsDevice = false;
  const result = await load().registerForPushNotifications({ prompt: true });
  expect(result).toEqual({ status: 'skipped', reason: 'simulator' });
  expect(mockRpc).not.toHaveBeenCalled();
});

it('registers the token, then unregisters it on sign-out', async () => {
  const mod = load();
  const result = await mod.registerForPushNotifications({ prompt: false });
  expect(result).toEqual({ status: 'registered', token: TOKEN });
  expect(mockGetToken).toHaveBeenCalledWith({ projectId: 'project-123' });
  expect(mockRpc).toHaveBeenCalledWith('register_push_token', {
    p_token: TOKEN,
    p_platform: 'ios',
  });

  await mod.unregisterPushToken();
  expect(mockRpc).toHaveBeenLastCalledWith('unregister_push_token', { p_token: TOKEN });
});

it('only shows the permission dialog when asked to, and once per session', async () => {
  mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequestPermissions.mockResolvedValue({ granted: false });
  const mod = load();

  expect(await mod.registerForPushNotifications({ prompt: false })).toEqual({
    status: 'skipped',
    reason: 'permission-denied',
  });
  expect(mockRequestPermissions).not.toHaveBeenCalled();

  await mod.registerForPushNotifications({ prompt: true });
  await mod.registerForPushNotifications({ prompt: true });
  expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
  expect(mockRpc).not.toHaveBeenCalled();
});

it('never throws when the backend call fails', async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'network down' } });
  const mod = load();
  expect(await mod.registerForPushNotifications({ prompt: false })).toEqual({
    status: 'skipped',
    reason: 'error',
  });
  await expect(mod.unregisterPushToken()).resolves.toBeUndefined();
});
