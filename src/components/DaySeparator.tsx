import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';

/** The "Today" / "Yesterday" / date pill between days in a chat. */
export default function DaySeparator({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <View
        style={[styles.pill, { backgroundColor: colors.elevatedCard, borderColor: colors.border }]}
      >
        <Text style={[styles.text, { color: colors.subtext }]}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', marginVertical: 10 },
  pill: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 12, fontWeight: '600' },
});
