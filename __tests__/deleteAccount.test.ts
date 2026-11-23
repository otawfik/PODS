// src/services/auth.ts deleteAccount(): unregister the push token, call the
// delete-account Edge Function with the confirmation, then sign out locally.

import { deleteAccount } from '../src/services/auth';

const mockInvoke = jest.fn();
const mockSignOut = jest.fn();
const mockUnregister = jest.fn();
const mockRegister = jest.fn();
const order: string[] = [];

jest.mock('../src/services/supabase', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => mockInvoke(...args) },
    auth: { signOut: (...args: unknown[]) => mockSignOut(...args) },
  },
  check: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({
  unregisterPushToken: () => mockUnregister(),
  registerForPushNotifications: (opts: unknown) => mockRegister(opts),
}));

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  mockUnregister.mockImplementation(async () => {
    order.push('unregister');
  });
  mockInvoke.mockImplementation(async () => {
    order.push('invoke');
    return { data: { deleted: true }, error: null };
  });
  mockSignOut.mockImplementation(async () => {
    order.push('signOut');
    return { error: null };
  });
  mockRegister.mockResolvedValue({ status: 'skipped', reason: 'error' });
});

test('unregisters the push token, deletes on the server, then signs out locally', async () => {
  await deleteAccount();
  expect(order).toEqual(['unregister', 'invoke', 'signOut']);
  expect(mockInvoke).toHaveBeenCalledWith('delete-account', {
    method: 'POST',
    body: { confirm: 'DELETE' },
  });
  // The server session is already gone, so only local state is cleared.
  expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  expect(mockRegister).not.toHaveBeenCalled();
});

test('a server failure throws its message, keeps the session and restores push', async () => {
  mockInvoke.mockResolvedValue({
    data: null,
    error: {
      message: 'Edge Function returned a non-2xx status code',
      context: { json: async () => ({ error: 'Could not delete your account.' }) },
    },
  });
  await expect(deleteAccount()).rejects.toThrow('Could not delete your account.');
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockRegister).toHaveBeenCalledWith({ prompt: false });
});

test('falls back to the generic message when the failure has no JSON body', async () => {
  mockInvoke.mockResolvedValue({ data: null, error: { message: 'Network request failed' } });
  await expect(deleteAccount()).rejects.toThrow('Network request failed');

  mockInvoke.mockResolvedValue({
    data: null,
    error: {
      message: 'Bad gateway',
      context: {
        json: async () => {
          throw new Error('not json');
        },
      },
    },
  });
  await expect(deleteAccount()).rejects.toThrow('Bad gateway');
  expect(mockSignOut).not.toHaveBeenCalled();
});

test('a local sign-out failure after deletion is not reported as a failed deletion', async () => {
  mockSignOut.mockRejectedValue(new Error('storage unavailable'));
  await expect(deleteAccount()).resolves.toBeUndefined();
});
