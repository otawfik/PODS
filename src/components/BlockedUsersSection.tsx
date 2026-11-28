import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../context/ThemeContext';
import { BlockedUser, getBlockedUsers, unblockUser } from '../services/moderation';
import AvatarInitials from './AvatarInitials';

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/** "Blocked users" on the Profile screen: the list, with unblock. */
export default function BlockedUsersSection() {
  const { colors } = useTheme();
  const [users, setUsers] = useState<BlockedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await getBlockedUsers());
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not load blocked users.'));
    }
  }, []);

  // Reload when the Profile tab comes back into view (after a block elsewhere).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const unblock = async (uid: string) => {
    setUnblockingId(uid);
    setError(null);
    try {
      await unblockUser(uid);
      setUsers((cur) => cur?.filter((u) => u.uid !== uid) ?? null);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not unblock. Try again.'));
    } finally {
      setUnblockingId(null);
    }
  };

  const s = makeStyles(colors);

  return (
    <View style={s.section}>
      <Text style={s.title}>Blocked users</Text>
      {error ? (
        <View style={s.errorRow}>
          <Text style={s.error}>{error}</Text>
          {users === null ? (
            <TouchableOpacity onPress={load}>
              <Text style={s.link}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      {users === null && !error ? <ActivityIndicator color={colors.primary} /> : null}
      {users?.length === 0 ? (
        <Text style={s.empty}>
          You haven&apos;t blocked anyone. You can block someone from their profile in a pod.
        </Text>
      ) : null}
      {users?.map((u) => (
        <View key={u.uid} style={s.row}>
          <AvatarInitials name={u.displayName} size={36} />
          <Text style={s.name} numberOfLines={1}>
            {u.displayName}
          </Text>
          {unblockingId === u.uid ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <TouchableOpacity
              style={s.unblockBtn}
              onPress={() => unblock(u.uid)}
              accessibilityLabel={`Unblock ${u.displayName}`}
            >
              <Text style={s.link}>Unblock</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    section: { marginBottom: 20 },
    title: { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 },
    empty: { fontSize: 14, color: c.subtext, lineHeight: 20 },
    errorRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
    error: { color: c.danger, fontSize: 13, flex: 1 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    name: { flex: 1, marginLeft: 12, fontSize: 15, color: c.text },
    unblockBtn: { paddingVertical: 6, paddingHorizontal: 4 },
    link: { color: c.primary, fontWeight: '600', fontSize: 14 },
  });
