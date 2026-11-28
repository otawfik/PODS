import React, { useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { MessagesStackParamList, Activity } from '../../types';
import { CategoryColors } from '../../constants/colors';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { getActivitiesForPods } from '../../services/activities';
import { ChatPreview, getChatPreviews } from '../../services/chat';
import { listTime } from '../../utils/chatLayout';

type Props = { navigation: NativeStackNavigationProp<MessagesStackParamList, 'MessagesList'> };

function getCountdown(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function MessagesScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { userProfile } = useAuth();
  const [chats, setChats] = useState<Activity[]>([]);
  const [previews, setPreviews] = useState<Record<string, ChatPreview>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      if (!userProfile) return;
      const all = await getActivitiesForPods(userProfile.podsJoined);
      const mine = all.filter((a) => a.participants.includes(userProfile.uid));
      setChats(mine);
      // Previews are a nicety: the list still works without them.
      getChatPreviews(mine.map((a) => a.activityId))
        .then(setPreviews)
        .catch((err: unknown) => console.warn('Could not load chat previews', err));
    }
    finally { setLoading(false); setRefreshing(false); }
  }, [userProfile]);

  // Reload whenever the screen comes back into view (e.g. after creating something).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const s = makeStyles(colors);
  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={colors.primary} /></View>;

  const activeChats = chats.filter((c) => c.status === 'active' && new Date(c.expiresAt) > new Date());
  const expiredChats = chats.filter((c) => c.status === 'expired' || new Date(c.expiresAt) <= new Date());
  // Most recent conversation first; chats with no messages keep start-time order.
  const byRecent = (a: Activity, b: Activity) =>
    (previews[b.activityId]?.timestamp ?? 0) - (previews[a.activityId]?.timestamp ?? 0);
  const allChats = [
    ...[...activeChats].sort(byRecent).map((c) => ({ item: c, isExpired: false })),
    ...[...expiredChats].sort(byRecent).map((c) => ({ item: c, isExpired: true })),
  ];

  const renderChat = ({ item: c, isExpired }: { item: Activity; isExpired: boolean }) => {
    const accentColor = CategoryColors[c.category] ?? colors.primary;
    const countdown = getCountdown(c.expiresAt);
    const preview = previews[c.activityId];
    const previewText = preview
      ? `${preview.senderId === userProfile?.uid ? 'You' : preview.senderName.split(' ')[0]}: ${preview.message}`
      : isExpired
        ? 'Chat locked'
        : 'No messages yet. Say hi!';
    return (
      <TouchableOpacity style={s.chatRow}
        onPress={() => navigation.navigate('Chat', { activityId: c.activityId, activityTitle: c.title, expiresAt: c.expiresAt })}
        activeOpacity={0.7}
        accessibilityLabel={`${c.title}. ${previewText}`}
      >
        <View style={[s.chatIcon, { backgroundColor: isExpired ? colors.border : accentColor }]}>
          <Text style={s.chatInitial}>{c.title.trim().charAt(0).toUpperCase() || '#'}</Text>
        </View>
        <View style={s.chatInfo}>
          <View style={s.chatTopLine}>
            <Text style={[s.chatTitle, { color: isExpired ? colors.subtext : colors.text }]} numberOfLines={1}>{c.title}</Text>
            {preview ? <Text style={[s.chatTime, { color: colors.subtext }]}>{listTime(preview.timestamp)}</Text> : null}
          </View>
          <View style={s.chatBottomLine}>
            <Text style={[s.chatPreview, { color: colors.subtext }]} numberOfLines={1}>{previewText}</Text>
            {isExpired ? (
              <Ionicons name="lock-closed" size={13} color={colors.subtext} />
            ) : (
              <Text style={[s.countdown, { color: colors.subtext }]}>{countdown} left</Text>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Messages</Text>
      </View>
      <FlatList
        data={allChats}
        keyExtractor={(i) => i.item.activityId}
        renderItem={({ item }) => renderChat(item)}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyIcon}>💬</Text>
            <Text style={s.emptyTitle}>No chats yet</Text>
            <Text style={s.emptyText}>Join an activity to get access to its group chat</Text>
          </View>
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
        contentContainerStyle={{ paddingBottom: 30 }}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={s.separator} />}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  title: { fontSize: 28, fontWeight: '800', color: c.text },
  chatRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  chatIcon: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  chatInitial: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  chatInfo: { flex: 1 },
  chatTopLine: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  chatBottomLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 3 },
  chatTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  chatTime: { fontSize: 12 },
  chatPreview: { flex: 1, fontSize: 14 },
  countdown: { fontSize: 12 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 78 },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: c.text, marginBottom: 8 },
  emptyText: { fontSize: 14, color: c.subtext, textAlign: 'center', lineHeight: 20 },
});
