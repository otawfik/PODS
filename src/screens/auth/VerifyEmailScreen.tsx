import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SafeAreaView,
  Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { sendVerificationEmail, logoutUser } from '../../services/auth';

/**
 * Gate shown to signed-in users who haven't verified their email yet.
 * PODS is students-only, so a verified .edu address is required.
 */
export default function VerifyEmailScreen() {
  const { colors } = useTheme();
  const { firebaseUser, refreshVerification } = useAuth();
  const [resending, setResending] = useState(false);
  const [checking, setChecking] = useState(false);

  const email = firebaseUser?.email ?? 'your email';

  const handleResend = async () => {
    setResending(true);
    try {
      await sendVerificationEmail();
      Alert.alert('Email sent', `A new verification link is on its way to ${email}.`);
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not resend the email');
    } finally {
      setResending(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    try {
      await refreshVerification();
      // If still unverified, the context flag stays false and we remain here.
    } finally {
      setChecking(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const s = makeStyles(colors);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.content}>
        <View style={[s.iconCircle, { backgroundColor: colors.primaryGlow }]}>
          <Ionicons name="mail-unread-outline" size={44} color={colors.primary} />
        </View>
        <Text style={s.title}>Verify your email</Text>
        <Text style={s.subtitle}>
          We sent a verification link to{'\n'}
          <Text style={s.email}>{email}</Text>
          {'\n\n'}PODS is for verified students only — click the link, then continue below.
        </Text>

        <TouchableOpacity style={s.primaryBtn} onPress={handleCheck} disabled={checking}>
          {checking
            ? <ActivityIndicator color="#FFFFFF" />
            : <Text style={s.primaryBtnText}>I've verified — continue</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={s.secondaryBtn} onPress={handleResend} disabled={resending}>
          {resending
            ? <ActivityIndicator color={colors.primary} />
            : <Text style={s.secondaryBtnText}>Resend verification email</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
          <Text style={s.logoutBtnText}>Log out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  iconCircle: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  title: { fontSize: 26, fontWeight: '800', color: c.text, marginBottom: 12, textAlign: 'center' },
  subtitle: { fontSize: 15, color: c.subtext, textAlign: 'center', lineHeight: 22, marginBottom: 32 },
  email: { fontWeight: '700', color: c.text },
  primaryBtn: { width: '100%', backgroundColor: c.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 12 },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  secondaryBtn: { width: '100%', borderWidth: 1.5, borderColor: c.primary, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginBottom: 12 },
  secondaryBtnText: { color: c.primary, fontWeight: '600', fontSize: 15 },
  logoutBtn: { paddingVertical: 12 },
  logoutBtnText: { color: c.subtext, fontSize: 14, fontWeight: '600' },
});
