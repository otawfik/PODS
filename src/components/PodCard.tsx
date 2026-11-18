import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { CategoryColors } from '../constants/colors';
import { useTheme } from '../context/ThemeContext';
import { Pod } from '../types';

interface Props {
  pod: Pod;
  isMember?: boolean;
  onPress: () => void;
  onJoin?: () => void;
  /** Why this pod was recommended (shown as a highlighted line). */
  reason?: string;
}

export default function PodCard({ pod, isMember = false, onPress, onJoin, reason }: Props) {
  const { colors } = useTheme();
  const accentColor = CategoryColors[pod.category] ?? colors.primary;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, shadowColor: colors.shadow }]}
      onPress={onPress}
      activeOpacity={0.9}
    >
      <View style={[styles.banner, { backgroundColor: pod.bannerColor }]}>
        <Text style={styles.bannerText}>{pod.name[0]}</Text>
      </View>
      <View style={styles.content}>
        <View style={styles.row}>
          <View style={[styles.categoryDot, { backgroundColor: accentColor }]} />
          <Text style={[styles.category, { color: colors.subtext }]}>{pod.category}</Text>
        </View>
        <Text style={[styles.name, { color: colors.text }]}>{pod.name}</Text>
        <Text style={[styles.description, { color: colors.subtext }]} numberOfLines={2}>
          {pod.description}
        </Text>
        {reason ? (
          <View style={[styles.reasonBox, { backgroundColor: colors.primaryGlow }]}>
            <Text style={[styles.reasonText, { color: colors.primary }]} numberOfLines={2}>
              ✨ {reason}
            </Text>
          </View>
        ) : null}
        <View style={styles.footer}>
          <Text style={[styles.members, { color: colors.subtext }]}>{pod.memberCount} members</Text>
          {!isMember && onJoin && (
            <TouchableOpacity style={[styles.joinBtn, { backgroundColor: colors.primary }]} onPress={onJoin}>
              <Text style={styles.joinBtnText}>Join</Text>
            </TouchableOpacity>
          )}
          {isMember && (
            <View style={[styles.memberBadge, { backgroundColor: colors.primaryGlow }]}>
              <Text style={[styles.memberBadgeText, { color: colors.success }]}>Joined ✓</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    marginHorizontal: 16,
    marginVertical: 8,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 3,
    overflow: 'hidden',
  },
  banner: { height: 80, alignItems: 'center', justifyContent: 'center' },
  bannerText: { fontSize: 36, fontWeight: '800', color: 'rgba(255,255,255,0.7)' },
  content: { padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  categoryDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  category: { fontSize: 12, fontWeight: '500' },
  name: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  description: { fontSize: 13, lineHeight: 18, marginBottom: 12 },
  reasonBox: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 12 },
  reasonText: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  members: { fontSize: 13 },
  joinBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  joinBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
  memberBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  memberBadgeText: { fontWeight: '600', fontSize: 12 },
});
