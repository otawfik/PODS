import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import {
  REPORT_REASONS,
  REPORT_DETAILS_MAX,
  ReportReason,
  ReportTargetType,
  blockUser,
  reportContent,
} from '../services/moderation';

export interface ReportTarget {
  type: ReportTargetType;
  id: string;
  /** What is being reported, shown under the title (a name or message text). */
  summary: string;
  /** The person behind it, to offer a block after reporting (never yourself). */
  author?: { uid: string; name: string };
}

interface Props {
  /** The sheet is open while this is set. */
  target: ReportTarget | null;
  onClose: () => void;
  /** Called after the author was blocked, so the screen can reload. */
  onBlocked?: (uid: string) => void;
}

const TITLES: Record<ReportTargetType, string> = {
  user: 'Report user',
  pod: 'Report pod',
  activity: 'Report activity',
  message: 'Report message',
};

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/** Bottom sheet: pick a reason, add optional details, send; then offer a block. */
export default function ReportSheet({ target, onClose, onBlocked }: Props) {
  const { colors } = useTheme();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [blocked, setBlocked] = useState(false);

  // Start clean each time the sheet opens (state is reset during render, as
  // React recommends, rather than in an effect).
  const targetKey = target ? `${target.type}:${target.id}` : null;
  const [shownKey, setShownKey] = useState(targetKey);
  if (shownKey !== targetKey) {
    setShownKey(targetKey);
    setReason(null);
    setDetails('');
    setError(null);
    setBusy(false);
    setSent(false);
    setBlocked(false);
  }

  if (!target) return null;
  const s = makeStyles(colors);

  const submit = async () => {
    if (!reason) {
      setError('Choose a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reportContent(target.type, target.id, reason, details);
      setSent(true);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not send the report. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const block = (author: { uid: string; name: string }) =>
    Alert.alert(
      `Block ${author.name}?`,
      "You won't see each other's messages or campus activities, and they can't join yours. They are not told.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await blockUser(author.uid);
              setBlocked(true);
              onBlocked?.(author.uid);
            } catch (err: unknown) {
              setError(errorMessage(err, 'Could not block this user. Try again.'));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.title}>{TITLES[target.type]}</Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={colors.subtext} />
            </TouchableOpacity>
          </View>

          {sent ? (
            <View style={s.body}>
              <Ionicons name="checkmark-circle" size={40} color={colors.success} />
              <Text style={s.sentTitle}>Report sent</Text>
              <Text style={s.sentText}>
                Thanks. We review every report and act on anything that breaks the rules.
              </Text>
              {error ? <Text style={s.error}>{error}</Text> : null}
              {target.author && !blocked ? (
                <TouchableOpacity
                  style={s.blockBtn}
                  onPress={() => target.author && block(target.author)}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.danger} />
                  ) : (
                    <Text style={s.blockBtnText}>Block {target.author.name}</Text>
                  )}
                </TouchableOpacity>
              ) : null}
              {blocked && target.author ? (
                <Text style={s.sentText}>{target.author.name} is blocked.</Text>
              ) : null}
              <TouchableOpacity style={s.primaryBtn} onPress={onClose}>
                <Text style={s.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
              <Text style={s.summary} numberOfLines={3}>
                {target.summary}
              </Text>
              <Text style={s.label}>Why are you reporting this?</Text>
              {REPORT_REASONS.map((r) => {
                const on = reason === r.value;
                return (
                  <TouchableOpacity
                    key={r.value}
                    style={s.reasonRow}
                    onPress={() => {
                      setReason(r.value);
                      setError(null);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                  >
                    <Ionicons
                      name={on ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={on ? colors.primary : colors.subtext}
                    />
                    <Text style={s.reasonText}>{r.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <TextInput
                style={s.details}
                value={details}
                onChangeText={setDetails}
                placeholder="Anything else we should know? (optional)"
                placeholderTextColor={colors.subtext}
                multiline
                maxLength={REPORT_DETAILS_MAX}
              />
              {error ? <Text style={s.error}>{error}</Text> : null}
              <TouchableOpacity style={s.primaryBtn} onPress={submit} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <Text style={s.primaryBtnText}>Send report</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: c.card,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: '88%',
      paddingBottom: 24,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 20,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    body: { padding: 20, alignItems: 'stretch' },
    summary: { fontSize: 14, color: c.subtext, marginBottom: 16, fontStyle: 'italic' },
    label: { fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 6 },
    reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
    reasonText: { fontSize: 15, color: c.text, flex: 1 },
    details: {
      marginTop: 10,
      minHeight: 72,
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.inputBackground,
      color: c.text,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 15,
      textAlignVertical: 'top',
    },
    error: { color: c.danger, fontSize: 13, marginTop: 10 },
    primaryBtn: {
      marginTop: 16,
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },
    primaryBtnText: { color: c.white, fontWeight: '700', fontSize: 15 },
    sentTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginTop: 10 },
    sentText: { fontSize: 14, color: c.subtext, marginTop: 6, lineHeight: 20 },
    blockBtn: {
      marginTop: 16,
      borderWidth: 1.5,
      borderColor: c.danger,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },
    blockBtnText: { color: c.danger, fontWeight: '600', fontSize: 15 },
  });
