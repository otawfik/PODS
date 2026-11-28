import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ReportSheet, { ReportTarget } from '../src/components/ReportSheet';

const mockReport = jest.fn();
const mockBlock = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/services/moderation', () => ({
  ...jest.requireActual('../src/services/moderation'),
  reportContent: (...args: unknown[]) => mockReport(...args),
  blockUser: (...args: unknown[]) => mockBlock(...args),
}));
jest.mock('../src/services/supabase', () => ({ supabase: {}, check: jest.fn() }));

const message: ReportTarget = {
  type: 'message',
  id: 'msg-1',
  summary: 'Ben: you are all idiots',
  author: { uid: 'ben', name: 'Ben' },
};

/** Press the destructive button of the last confirmation dialog. */
async function confirmDialog() {
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? [];
  await act(async () => {
    await buttons.find((b) => b.style === 'destructive')?.onPress?.();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReport.mockResolvedValue('report-1');
  mockBlock.mockResolvedValue(undefined);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

it('renders nothing while closed', async () => {
  await render(<ReportSheet target={null} onClose={jest.fn()} />);
  expect(screen.queryByText('Send report')).toBeNull();
});

it('asks for a reason inline instead of sending', async () => {
  await render(<ReportSheet target={message} onClose={jest.fn()} />);
  expect(screen.getByText('Report message')).toBeTruthy();
  expect(screen.getByText('Ben: you are all idiots')).toBeTruthy();

  await fireEvent.press(screen.getByText('Send report'));
  expect(await screen.findByText('Choose a reason.')).toBeTruthy();
  expect(mockReport).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('sends the chosen reason and details, then confirms', async () => {
  await render(<ReportSheet target={message} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Hate speech'));
  await fireEvent.changeText(screen.getByPlaceholderText(/Anything else/), 'in the pod chat');
  await fireEvent.press(screen.getByText('Send report'));

  expect(await screen.findByText('Report sent')).toBeTruthy();
  expect(mockReport).toHaveBeenCalledWith('message', 'msg-1', 'hate', 'in the pod chat');
});

it('shows a server error inline and lets the user retry', async () => {
  mockReport.mockRejectedValueOnce(new Error('You have reached the daily report limit.'));
  await render(<ReportSheet target={message} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Spam or scam'));
  await fireEvent.press(screen.getByText('Send report'));
  expect(await screen.findByText('You have reached the daily report limit.')).toBeTruthy();
  expect(screen.queryByText('Report sent')).toBeNull();

  await fireEvent.press(screen.getByText('Send report'));
  expect(await screen.findByText('Report sent')).toBeTruthy();
});

it('offers to block the author after a report, behind a confirmation', async () => {
  const onBlocked = jest.fn();
  await render(<ReportSheet target={message} onClose={jest.fn()} onBlocked={onBlocked} />);
  await fireEvent.press(screen.getByText('Spam or scam'));
  await fireEvent.press(screen.getByText('Send report'));

  await fireEvent.press(await screen.findByText('Block Ben'));
  expect(mockBlock).not.toHaveBeenCalled(); // waits for the confirmation
  await confirmDialog();

  expect(await screen.findByText('Ben is blocked.')).toBeTruthy();
  expect(mockBlock).toHaveBeenCalledWith('ben');
  expect(onBlocked).toHaveBeenCalledWith('ben');
  expect(screen.queryByText('Block Ben')).toBeNull();
});

it('shows a failed block inline', async () => {
  mockBlock.mockRejectedValue(new Error('User not found'));
  await render(<ReportSheet target={message} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Spam or scam'));
  await fireEvent.press(screen.getByText('Send report'));
  await fireEvent.press(await screen.findByText('Block Ben'));
  await confirmDialog();
  expect(await screen.findByText('User not found')).toBeTruthy();
  expect(screen.getByText('Block Ben')).toBeTruthy();
});

it('has no block offer for a pod, and starts clean for the next target', async () => {
  const pod: ReportTarget = { type: 'pod', id: 'pod-1', summary: 'Night owls' };
  const view = await render(<ReportSheet target={pod} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Spam or scam'));
  await fireEvent.press(screen.getByText('Send report'));
  expect(await screen.findByText('Report sent')).toBeTruthy();
  expect(screen.queryByText(/^Block /)).toBeNull();

  await view.rerender(<ReportSheet target={message} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('Send report')).toBeTruthy());
  expect(screen.queryByText('Report sent')).toBeNull();
});

it('closes from Done', async () => {
  const onClose = jest.fn();
  await render(<ReportSheet target={message} onClose={onClose} />);
  await fireEvent.press(screen.getByText('Spam or scam'));
  await fireEvent.press(screen.getByText('Send report'));
  await fireEvent.press(await screen.findByText('Done'));
  expect(onClose).toHaveBeenCalledTimes(1);
});
