import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { MessagesStackParamList, Message } from '../../types';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { sendMessage, subscribeToMessages } from '../../services/chat';
import { getActivity } from '../../services/activities';
import { activityChatKey, setActiveChat } from '../../services/notifications';
import MessageBubble from '../../components/MessageBubble';
import DaySeparator from '../../components/DaySeparator';
import { buildChatItems } from '../../utils/chatLayout';
import ReportSheet, { ReportTarget } from '../../components/ReportSheet';
import KeyboardAwareView from '../../components/KeyboardAwareView';

type Props = {
  navigation: NativeStackNavigationProp<MessagesStackParamList, 'Chat'>;
  route: RouteProp<MessagesStackParamList, 'Chat'>;
};

function getCountdown(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`;
}

export default function ChatScreen({ navigation, route }: Props) {
  const { activityId, activityTitle: titleParam, expiresAt: expiresAtParam } = route.params;
  const { colors } = useTheme();
  const { userProfile } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // Opened from the Messages list, the title and expiry come with the route.
  // Opened from a notification or link, only the id does, so load the rest.
  const [loaded, setLoaded] = useState<{ id: string; title: string; expiresAt: string } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ id: string; message: string } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const needsLoad = !titleParam || !expiresAtParam;
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  // Bumped after a block so the chat reloads without the blocked user's messages.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!needsLoad) return;
    let cancelled = false;
    getActivity(activityId)
      .then((activity) => {
        if (cancelled) return;
        if (!activity) {
          setLoadFailure({ id: activityId, message: 'This chat is no longer available.' });
        } else {
          setLoaded({ id: activityId, title: activity.title, expiresAt: activity.expiresAt });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not load this chat';
        setLoadFailure({ id: activityId, message });
      });
    return () => {
      cancelled = true;
    };
  }, [needsLoad, activityId, loadAttempt]);

  const retryLoad = () => {
    setLoadFailure(null);
    setLoadAttempt((n) => n + 1);
  };
  const loadError = loadFailure?.id === activityId ? loadFailure.message : null;

  const details = !needsLoad
    ? { title: titleParam, expiresAt: expiresAtParam }
    : loaded?.id === activityId
      ? loaded
      : null;
  const activityTitle = details?.title ?? '';
  const expiresAt = details?.expiresAt ?? null;
  const isExpired = expiresAt ? new Date(expiresAt) <= new Date() : false;

  // Re-render every 30 s so the countdown (and the expired lock) stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  const countdown = expiresAt ? getCountdown(expiresAt) : '';

  // While this chat is on screen, its own pushes stay quiet.
  useFocusEffect(useCallback(() => setActiveChat(activityChatKey(activityId)), [activityId]));

  useEffect(() => {
    const unsub = subscribeToMessages(activityId, (msgs) => {
      setMessages(msgs);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    });
    return unsub;
  }, [activityId, reloadKey]);

  const reportMessage = (m: Message) =>
    setReportTarget({
      type: 'message',
      id: m.messageId,
      summary: `${m.senderName}: ${m.message}`,
      author: { uid: m.senderId, name: m.senderName },
    });

  const handleSend = async () => {
    if (!text.trim() || !userProfile || isExpired) return;
    setSending(true);
    try { await sendMessage(activityId, userProfile.uid, userProfile.displayName, text.trim()); setText(''); }
    finally { setSending(false); }
  };

  const s = makeStyles(colors);

  if (!details) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
        <View style={s.loadState}>
          {loadError ? (
            <>
              <Text style={s.loadErrorText}>{loadError}</Text>
              <TouchableOpacity onPress={retryLoad} style={s.retryBtn}>
                <Text style={s.retryBtnText}>Retry</Text>
              </TouchableOpacity>
            </>
          ) : (
            <ActivityIndicator size="large" color={colors.primary} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={s.headerInfo}>
          <Text style={s.headerTitle} numberOfLines={1}>{activityTitle}</Text>
          <Text style={[s.headerCountdown, { color: isExpired ? colors.danger : colors.warning }]}>{countdown}</Text>
        </View>
      </View>

      <View style={s.warningBanner}>
        <Ionicons name="time-outline" size={14} color={colors.warning} />
        <Text style={s.warningText}>Temporary chat · Messages delete when activity expires</Text>
      </View>

      <KeyboardAwareView onKeyboardShown={() => flatListRef.current?.scrollToEnd({ animated: true })}>
        <FlatList ref={flatListRef} data={buildChatItems(messages, userProfile?.uid)} keyExtractor={(item) => item.key}
          renderItem={({ item }) =>
            item.kind === 'day' ? (
              <DaySeparator label={item.label} />
            ) : (
              <MessageBubble message={item.message} isOwn={item.isOwn} groupStart={item.groupStart} groupEnd={item.groupEnd}
                onLongPress={item.isOwn ? undefined : () => reportMessage(item.message)} />
            )
          }
          contentContainerStyle={s.messageList}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={s.emptyChat}>
              <Text style={s.emptyChatIcon}>👋</Text>
              <Text style={[s.emptyChatText, { color: colors.subtext }]}>Be the first to say something!</Text>
            </View>
          }
        />

        {isExpired ? (
          <View style={[s.expiredBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            <Ionicons name="lock-closed" size={16} color={colors.subtext} />
            <Text style={[s.expiredBarText, { color: colors.subtext }]}>This chat has expired and is now locked</Text>
          </View>
        ) : (
          <View style={[s.inputBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            <TextInput style={[s.textInput, { backgroundColor: colors.inputBackground, borderColor: colors.border, color: colors.text }]}
              placeholder="Message..." placeholderTextColor={colors.subtext}
              value={text} onChangeText={setText} multiline maxLength={500} />
            <TouchableOpacity style={[s.sendBtn, { backgroundColor: colors.primary }, (!text.trim() || sending) && s.sendBtnDisabled]}
              onPress={handleSend} disabled={!text.trim() || sending}>
              {sending ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="send" size={18} color="#FFFFFF" />}
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAwareView>

      <ReportSheet
        target={reportTarget}
        onClose={() => setReportTarget(null)}
        onBlocked={() => setReloadKey((k) => k + 1)}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.card },
  backBtn: { marginRight: 12 },
  loadState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadErrorText: { fontSize: 15, color: c.subtext, textAlign: 'center', marginBottom: 16 },
  retryBtn: { borderWidth: 1.5, borderColor: c.primary, borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },
  retryBtnText: { color: c.primary, fontWeight: '700', fontSize: 15 },
  headerInfo: { flex: 1 },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  headerCountdown: { fontSize: 12, marginTop: 2 },
  warningBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(245,166,35,0.1)', paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  warningText: { fontSize: 12, color: c.warning, flex: 1 },
  messageList: { paddingVertical: 12, paddingBottom: 20 },
  emptyChat: { alignItems: 'center', paddingTop: 60 },
  emptyChatIcon: { fontSize: 36, marginBottom: 12 },
  emptyChatText: { fontSize: 14 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, gap: 10 },
  textInput: { flex: 1, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 100, borderWidth: 1.5 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
  expiredBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 16, borderTopWidth: 1, gap: 8 },
  expiredBarText: { fontSize: 14 },
});
