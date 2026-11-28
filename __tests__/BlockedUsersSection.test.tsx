import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import BlockedUsersSection from '../src/components/BlockedUsersSection';

const mockGetBlocked = jest.fn();
const mockUnblock = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (fn: () => void) => useEffect(fn, [fn]) };
});
jest.mock('../src/services/moderation', () => ({
  getBlockedUsers: () => mockGetBlocked(),
  unblockUser: (...args: unknown[]) => mockUnblock(...args),
}));

const ben = { uid: 'ben', displayName: 'Ben', blockedAt: '2026-11-22T10:00:00Z' };
const cy = { uid: 'cy', displayName: 'Cy', blockedAt: '2026-11-20T10:00:00Z' };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBlocked.mockResolvedValue([ben, cy]);
  mockUnblock.mockResolvedValue(undefined);
});

it('shows the empty state', async () => {
  mockGetBlocked.mockResolvedValue([]);
  await render(<BlockedUsersSection />);
  expect(await screen.findByText(/haven't blocked anyone/)).toBeTruthy();
});

it('lists blocked users and removes one on unblock', async () => {
  await render(<BlockedUsersSection />);
  expect(await screen.findByText('Ben')).toBeTruthy();
  expect(screen.getByText('Cy')).toBeTruthy();

  await fireEvent.press(screen.getByLabelText('Unblock Ben'));
  await waitFor(() => expect(screen.queryByText('Ben')).toBeNull());
  expect(mockUnblock).toHaveBeenCalledWith('ben');
  expect(screen.getByText('Cy')).toBeTruthy();
});

it('shows a load error with a retry that works', async () => {
  mockGetBlocked.mockRejectedValueOnce(new Error('Network request failed'));
  await render(<BlockedUsersSection />);
  expect(await screen.findByText('Network request failed')).toBeTruthy();

  await fireEvent.press(screen.getByText('Retry'));
  expect(await screen.findByText('Ben')).toBeTruthy();
  expect(screen.queryByText('Network request failed')).toBeNull();
});

it('keeps the user listed and shows the error when unblock fails', async () => {
  mockUnblock.mockRejectedValue(new Error('Could not reach the server'));
  await render(<BlockedUsersSection />);
  await fireEvent.press(await screen.findByLabelText('Unblock Ben'));
  expect(await screen.findByText('Could not reach the server')).toBeTruthy();
  expect(screen.getByText('Ben')).toBeTruthy();
});
