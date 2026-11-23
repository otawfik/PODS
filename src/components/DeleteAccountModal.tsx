import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { deleteAccount, DELETE_ACCOUNT_CONFIRMATION } from '../services/auth';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const WHAT_GOES = [
  'Your profile, email and sign-in',
  'Activities you host, including their chats',
  'Every message you have sent',
  'Your spots and join requests in other activities',
  'Your pod memberships. A pod where you are the only member is deleted; if you are its only admin, the longest-standing member becomes admin.',
];

/**
 * Confirmation step for deleting the account: says what is removed and
 * requires typing DELETE. On success the session ends, so the app leaves
 * this screen on its own; on failure the error is shown inline.
 */
export default function DeleteAccountModal({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = typed.trim().toUpperCase() === DELETE_ACCOUNT_CONFIRMATION;
  const s = makeStyles(colors);

  const close = () => {
    if (deleting) return;
    setTyped('');
    setError(null);
    onClose();
  };

  const handleDelete = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      // Signed out: AuthContext swaps to the sign-in screens.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setDeleting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        style={s.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.sheet}>
          <Text style={s.title}>Delete your account?</Text>
          <Text style={s.body}>This is permanent and cannot be undone. It deletes:</Text>
          {WHAT_GOES.map((line) => (
            <Text key={line} style={s.bullet}>
              {'•'} {line}
            </Text>
          ))}

          <Text style={s.label}>Type {DELETE_ACCOUNT_CONFIRMATION} to confirm</Text>
          <TextInput
            testID="delete-account-input"
            style={[s.input, error ? s.inputError : null]}
            value={typed}
            onChangeText={setTyped}
            editable={!deleting}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder={DELETE_ACCOUNT_CONFIRMATION}
            placeholderTextColor={colors.subtext}
          />
          {error ? (
            <Text testID="delete-account-error" style={s.error}>
              {error}
            </Text>
          ) : null}

          <View style={s.actions}>
            <TouchableOpacity style={s.cancelBtn} onPress={close} disabled={deleting}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="delete-account-confirm"
              style={[s.deleteBtn, (!confirmed || deleting) && s.deleteBtnDisabled]}
              onPress={handleDelete}
              disabled={!confirmed || deleting}
              accessibilityRole="button"
              accessibilityLabel="Permanently delete my account"
            >
              {deleting ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={s.deleteText}>Delete account</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    backdrop: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: c.shadow },
    sheet: {
      backgroundColor: c.elevatedCard,
      borderRadius: 16,
      padding: 20,
      borderWidth: 1,
      borderColor: c.border,
    },
    title: { fontSize: 20, fontWeight: '800', color: c.text, marginBottom: 8 },
    body: { fontSize: 14, color: c.text, lineHeight: 20, marginBottom: 8 },
    bullet: { fontSize: 14, color: c.subtext, lineHeight: 20, marginBottom: 4 },
    label: { fontSize: 13, fontWeight: '600', color: c.text, marginTop: 14, marginBottom: 8 },
    input: {
      backgroundColor: c.inputBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      fontSize: 15,
      color: c.text,
      borderWidth: 1.5,
      borderColor: c.border,
    },
    inputError: { borderColor: c.danger },
    error: { fontSize: 13, color: c.danger, marginTop: 8 },
    actions: { flexDirection: 'row', gap: 12, marginTop: 18 },
    cancelBtn: {
      flex: 1,
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },
    cancelText: { fontSize: 15, fontWeight: '600', color: c.subtext },
    deleteBtn: {
      flex: 1,
      backgroundColor: c.danger,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },
    deleteBtnDisabled: { opacity: 0.4 },
    deleteText: { fontSize: 15, fontWeight: '700', color: c.white },
  });
