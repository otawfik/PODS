import { useCallback, useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { subscribeToNotificationTaps } from '../services/notifications';
import { actionForPath, navigationRef, pathFromNotificationData, pathFromUrl } from './linking';

/**
 * Opens the screen for a tapped notification or a `pods://` link.
 *
 * A link can arrive before the app can show it: on a cold start the session
 * is still loading, and a signed-out user has no signed-in screens at all.
 * So the link is kept and opened once the user is signed in and the main
 * navigator is mounted. Until then nothing navigates.
 *
 * Call once, inside AuthProvider. Pass the returned function to
 * NavigationContainer's `onReady`.
 */
export function useDeepLinks(): () => void {
  const { authUser, loading } = useAuth();
  const signedIn = !!authUser && !loading;
  const signedInRef = useRef(false);
  const pendingPath = useRef<string | null>(null);

  const flush = useCallback(() => {
    const path = pendingPath.current;
    if (!path || !signedInRef.current || !navigationRef.isReady()) return;
    // The signed-in screens replace the auth screens a moment after sign-in.
    if (!navigationRef.getRootState().routeNames.includes('Main')) return;
    pendingPath.current = null;
    const action = actionForPath(path);
    if (action) navigationRef.dispatch(action);
  }, []);

  useEffect(() => {
    const open = (path: string | null) => {
      if (!path) return;
      pendingPath.current = path;
      flush();
    };
    const stopTaps = subscribeToNotificationTaps((data) => open(pathFromNotificationData(data)));
    Linking.getInitialURL()
      .then((url) => open(pathFromUrl(url)))
      .catch(() => {});
    const urlSubscription = Linking.addEventListener('url', ({ url }) => open(pathFromUrl(url)));
    // Retry whenever navigation changes (e.g. the main tabs just mounted).
    const stopState = navigationRef.addListener('state', flush);
    return () => {
      stopTaps();
      urlSubscription.remove();
      stopState();
    };
  }, [flush]);

  useEffect(() => {
    signedInRef.current = signedIn;
    if (!signedIn) return;
    const timer = setTimeout(flush, 0);
    return () => clearTimeout(timer);
  }, [signedIn, flush]);

  return flush;
}
