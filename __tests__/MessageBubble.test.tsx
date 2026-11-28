import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import MessageBubble from '../src/components/MessageBubble';
import { Message } from '../src/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const message: Message = {
  messageId: 'm1',
  senderId: 'ana',
  senderName: 'Ana Lopez',
  message: 'Library at 7?',
  timestamp: new Date('2026-11-27T19:05:00').getTime(),
};

describe('MessageBubble', () => {
  it("shows the sender's name and initials on a single message from someone else", async () => {
    await render(<MessageBubble message={message} isOwn={false} />);
    expect(screen.getByText('Ana Lopez')).toBeTruthy();
    expect(screen.getByText('AL')).toBeTruthy();
    expect(screen.getByText(/Library at 7\?/)).toBeTruthy();
  });

  it('hides the name in the middle of a run and the avatar until the last bubble', async () => {
    await render(
      <MessageBubble message={message} isOwn={false} groupStart={false} groupEnd={false} />,
    );
    expect(screen.queryByText('Ana Lopez')).toBeNull();
    expect(screen.queryByText('AL')).toBeNull();
  });

  it('never shows a name or avatar on your own messages', async () => {
    await render(<MessageBubble message={message} isOwn />);
    expect(screen.queryByText('Ana Lopez')).toBeNull();
    expect(screen.queryByText('AL')).toBeNull();
  });

  it('calls onLongPress, and reads out sender, text and time for screen readers', async () => {
    const onLongPress = jest.fn();
    await render(<MessageBubble message={message} isOwn={false} onLongPress={onLongPress} />);
    const bubble = screen.getByLabelText(/^Ana Lopez: Library at 7\?, /);
    fireEvent(bubble, 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
