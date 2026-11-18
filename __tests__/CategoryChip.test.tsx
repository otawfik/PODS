import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import CategoryChip from '../src/components/CategoryChip';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('CategoryChip', () => {
  it('renders its label', async () => {
    await render(<CategoryChip label="Study" />);
    expect(screen.getByText('Study')).toBeTruthy();
  });

  it('calls onPress when tapped', async () => {
    const onPress = jest.fn();
    await render(<CategoryChip label="Gym" onPress={onPress} />);
    fireEvent.press(screen.getByText('Gym'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
