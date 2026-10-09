import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, SafeAreaView,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { verifyEmailCode, resendVerificationCode } from '../../services/auth';

/**
 * Gate shown after sign-up (or a login attempt on an unverified account).
 * PODS is students-only, so the user must enter the code emailed to their
 * .edu address. A correct code signs them in.
 */
export default function VerifyEmailScreen() {
  const { colors } = useTheme();
  const { pendingVerificationEmail, cancelVerification } = useAuth();
  const [code, setCode] = useState('');
  const [resending, setResending] = useState(false);
  const [checking, setChecking] = useState(false);

  const email = pendingVerificationEmail ?? '';

  const handleResend = async () => {
    setResending(true);
    try {
      await resendVerificationCode(email);
      Alert.alert('Code sent', `A new verification code is on its way to ${email}.`);
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not resend the code');
    } finally {
      setResending(false);
    }
  };

  const handleVerify = async () => {
    if (code.trim().length < 6) {
      Alert.alert('Enter the code', 'Type the code from the verification email.');
      return;
    }
    setChecking(true);
    try {
      // On success the auth listener signs the user in and leaves this screen.
      await verifyEmailCode(email, code);
    } catch (err: any) {
      Alert.alert('Invalid code', err.message ?? 'That code is wrong or has expired.');
      setChecking(false);
    }
  };

  const s = makeStyles(colors);

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={s.content}>
          <View style={[s.iconCircle, { backgroundColor: colors.primaryGlow }]}>
            <Ionicons name="mail-unread-outline" size={44} color={colors.primary} />
          </View>
          <Text style={s.title}>Verify your email</Text>
          <Text style={s.subtitle}>
            We sent a verification code to{'\n'}
            <Text style={s.email}>{email}</Text>
            {'\n\n'}PODS is for verified students only — enter the code below.
          </Text>

          <TextInput
            style={s.codeInput}
            value={code}
            onChangeText={(v) => setCode(v.replace(/[^0-9]/g, ''))}
            placeholder="123456"
            placeholderTextColor={colors.subtext}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={10}
            autoFocus
          />

          <TouchableOpacity style={s.primaryBtn} onPress={handleVerify} disabled={checking}>
            {checking
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={s.primaryBtnText}>Verify and continue</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={s.secondaryBtn} onPress={handleResend} disabled={resending}>
            {resending
              ? <ActivityIndicator color={colors.primary} />
              : <Text style={s.secondaryBtnText}>Resend code</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={s.logoutBtn} onPress={cancelVerification}>
            <Text style={s.logoutBtnText}>Use a different account</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  iconCircle: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  title: { fontSize: 26, fontWeight: '800', color: c.text, marginBottom: 12, textAlign: 'center' },
  subtitle: { fontSize: 15, color: c.subtext, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  email: { fontWeight: '700', color: c.text },
  codeInput: { width: '100%', backgroundColor: c.inputBackground, borderRadius: 12, paddingVertical: 14, fontSize: 24, letterSpacing: 8, textAlign: 'center', color: c.text, borderWidth: 1.5, borderColor: c.border, marginBottom: 16 },
  primaryBtn: { width: '100%', backgroundColor: c.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 12 },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  secondaryBtn: { width: '100%', borderWidth: 1.5, borderColor: c.primary, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginBottom: 12 },
  secondaryBtnText: { color: c.primary, fontWeight: '600', fontSize: 15 },
  logoutBtn: { paddingVertical: 12 },
  logoutBtnText: { color: c.subtext, fontSize: 14, fontWeight: '600' },
});
