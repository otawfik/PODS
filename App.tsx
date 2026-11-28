import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from './src/context/AuthContext';
import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import RootNavigator from './src/navigation/RootNavigator';
import { navigationRef } from './src/navigation/linking';
import { useDeepLinks } from './src/navigation/useDeepLinks';
import { configureForegroundNotifications } from './src/services/notifications';

configureForegroundNotifications();

function AppContent() {
  const { isDark } = useTheme();
  // Opens the right screen for notification taps and pods:// links.
  const onNavigationReady = useDeepLinks();
  return (
    <NavigationContainer ref={navigationRef} onReady={onNavigationReady}>
      <RootNavigator />
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
