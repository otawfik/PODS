import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, SafeAreaView,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AuthStackParamList } from '../../types';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import {
  loginUser,
  EmailNotConfirmedError,
  sendPasswordResetCode,
  resetPasswordWithCode,
} from '../../services/auth';

type Props = { navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'> };

export default function LoginScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { startVerification } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // Password reset: after "Forgot password?" the user enters the emailed code
  // and a new password on this same screen.
  const [resetEmail, setResetEmail] = useState<string | null>(null);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) return Alert.alert('Error', 'Please fill in all fields');
    setLoading(true);
    try {
      await loginUser(email.trim().toLowerCase(), password);
    } catch (err: any) {
      if (err instanceof EmailNotConfirmedError) {
        // Unverified account: a fresh code was sent; show the code screen.
        startVerification(err.email);
      } else {
        Alert.alert('Login Failed', err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    const target = email.trim().toLowerCase();
    if (!target) {
      Alert.alert('Enter your email', 'Type your account email above, then tap "Forgot password?"');
      return;
    }
    try {
      await sendPasswordResetCode(target);
      setResetEmail(target);
      setResetCode('');
      setNewPassword('');
      Alert.alert('Check your inbox', `A password reset code was sent to ${target}.`);
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not send reset code');
    }
  };

  const handleResetPassword = async () => {
    if (!resetEmail) return;
    if (resetCode.trim().length < 6) return Alert.alert('Error', 'Enter the code from the email');
    if (newPassword.length < 6) return Alert.alert('Error', 'Password must be at least 6 characters');
    setResetting(true);
    try {
      // Signs the user in on success; the navigator then opens the app.
      await resetPasswordWithCode(resetEmail, resetCode, newPassword);
      Alert.alert('Password updated', 'You are now signed in with your new password.');
    } catch (err: any) {
      Alert.alert('Reset failed', err.message ?? 'That code is wrong or has expired.');
      setResetting(false);
    }
  };

  const s = makeStyles(colors);

  if (resetEmail) {
    return (
      <SafeAreaView style={s.container}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            <TouchableOpacity onPress={() => setResetEmail(null)} style={s.backBtn}>
              <Text style={s.backBtnText}>← Back to login</Text>
            </TouchableOpacity>
            <Text style={s.title}>Reset Password</Text>
            <Text style={s.subtitle}>Enter the code we sent to {resetEmail} and choose a new password.</Text>

            <View style={s.field}>
              <Text style={s.label}>Reset code</Text>
              <TextInput style={s.input} placeholder="123456" placeholderTextColor={colors.subtext}
                value={resetCode} onChangeText={(v) => setResetCode(v.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={10} />
            </View>

            <View style={s.field}>
              <Text style={s.label}>New password</Text>
              <TextInput style={s.input} placeholder="Min. 6 characters" placeholderTextColor={colors.subtext}
                value={newPassword} onChangeText={setNewPassword} secureTextEntry />
            </View>

            <TouchableOpacity style={[s.submitBtn, resetting && s.submitBtnDisabled]} onPress={handleResetPassword} disabled={resetting}>
              {resetting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.submitBtnText}>Set New Password</Text>}
            </TouchableOpacity>

            <TouchableOpacity onPress={handleForgotPassword} style={s.forgotLink}>
              <Text style={s.forgotLinkText}>Resend code</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={s.content}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
            <Text style={s.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={s.title}>Welcome Back</Text>
          <Text style={s.subtitle}>Sign in to your account</Text>

          <View style={s.field}>
            <Text style={s.label}>Email</Text>
            <TextInput style={s.input} placeholder="you@university.edu" placeholderTextColor={colors.subtext}
              value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          </View>

          <View style={s.field}>
            <Text style={s.label}>Password</Text>
            <TextInput style={s.input} placeholder="Your password" placeholderTextColor={colors.subtext}
              value={password} onChangeText={setPassword} secureTextEntry />
          </View>

          <TouchableOpacity style={[s.submitBtn, loading && s.submitBtnDisabled]} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.submitBtnText}>Log In</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={handleForgotPassword} style={s.forgotLink}>
            <Text style={s.forgotLinkText}>Forgot password?</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => navigation.navigate('Register')} style={s.registerLink}>
            <Text style={s.registerLinkText}>Don&apos;t have an account? <Text style={s.registerLinkBold}>Sign Up</Text></Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { flexGrow: 1, padding: 24 },
  backBtn: { marginBottom: 32 },
  backBtnText: { fontSize: 16, color: c.primary, fontWeight: '500' },
  title: { fontSize: 30, fontWeight: '800', color: c.text, marginBottom: 6 },
  subtitle: { fontSize: 16, color: c.subtext, marginBottom: 40 },
  field: { marginBottom: 20 },
  label: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 8 },
  input: { backgroundColor: c.inputBackground, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: c.text, borderWidth: 1.5, borderColor: c.border },
  submitBtn: { backgroundColor: c.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8, marginBottom: 20 },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 17 },
  forgotLink: { alignItems: 'center', marginBottom: 20 },
  forgotLinkText: { color: c.primary, fontSize: 14, fontWeight: '600' },
  registerLink: { alignItems: 'center' },
  registerLinkText: { color: c.subtext, fontSize: 15 },
  registerLinkBold: { color: c.primary, fontWeight: '700' },
});
