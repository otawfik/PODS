import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import DeleteAccountModal from '../src/components/DeleteAccountModal';

const mockDeleteAccount = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/services/auth', () => ({
  DELETE_ACCOUNT_CONFIRMATION: 'DELETE',
  deleteAccount: () => mockDeleteAccount(),
}));

describe('DeleteAccountModal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('says what is deleted and does nothing until DELETE is typed', async () => {
    await render(<DeleteAccountModal visible onClose={jest.fn()} />);
    expect(screen.getByText(/permanent and cannot be undone/)).toBeTruthy();
    expect(screen.getByText(/Every message you have sent/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await fireEvent.changeText(screen.getByTestId('delete-account-input'), 'delet');
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('deletes once confirmed and shows a server error inline', async () => {
    mockDeleteAccount.mockRejectedValueOnce(new Error('Could not delete your account.'));
    await render(<DeleteAccountModal visible onClose={jest.fn()} />);

    await fireEvent.changeText(screen.getByTestId('delete-account-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('delete-account-error').props.children).toBe(
        'Could not delete your account.',
      ),
    );
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);

    // Still on the confirmation step, so the user can retry.
    mockDeleteAccount.mockResolvedValueOnce(undefined);
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(2));
  });
});
