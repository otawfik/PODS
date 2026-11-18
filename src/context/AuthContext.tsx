import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import type { Session, User as SupabaseUser } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { ensureUserProfile, getUserProfile } from '../services/auth';
import { registerForPushNotifications } from '../services/notifications';
import { User } from '../types';

interface AuthContextType {
  /** The signed-in Supabase user. Supabase only signs in verified emails. */
  authUser: SupabaseUser | null;
  userProfile: User | null;
  /**
   * Email waiting for its verification code (after sign-up, or after trying
   * to log in to an unverified account). Shows the VerifyEmail screen.
   */
  pendingVerificationEmail: string | null;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  startVerification: (email: string) => void;
  cancelVerification: () => void;
}

const AuthContext = createContext<AuthContextType>({
  authUser: null,
  userProfile: null,
  pendingVerificationEmail: null,
  loading: true,
  refreshProfile: async () => {},
  startVerification: () => {},
  cancelVerification: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authUser, setAuthUser] = useState<SupabaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<User | null>(null);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Which user's profile is loaded, so token refreshes don't refetch it.
  const loadedUserId = useRef<string | null>(null);

  const refreshProfile = useCallback(async () => {
    if (authUser) {
      const profile = await getUserProfile(authUser.id);
      setUserProfile(profile);
    }
  }, [authUser]);

  useEffect(() => {
    const applySession = async (session: Session | null) => {
      const user = session?.user ?? null;
      if (!user) {
        loadedUserId.current = null;
        setUserProfile(null);
        setAuthUser(null);
        setLoading(false);
        return;
      }
      if (loadedUserId.current === user.id) {
        setAuthUser(user);
        return;
      }
      try {
        // Self-heal: an authed user with no profile row gets a minimal one
        // instead of a permanent loading spinner.
        const profile = await ensureUserProfile(user);
        loadedUserId.current = user.id;
        setUserProfile(profile);
        // Refresh this device's push token if permission was granted before.
        // Never prompts here; see askForPushAfterAction.
        void registerForPushNotifications({ prompt: false });
      } catch (err) {
        console.warn('Could not load profile', err);
      } finally {
        setPendingVerificationEmail(null);
        setAuthUser(user);
        setLoading(false);
      }
    };

    // Fires once immediately with the stored session (INITIAL_SESSION), then
    // on every sign-in / sign-out. Supabase advises not to await other
    // Supabase calls inside this callback, so the work is deferred.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => {
        applySession(session);
      }, 0);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        authUser,
        userProfile,
        pendingVerificationEmail,
        loading,
        refreshProfile,
        startVerification: setPendingVerificationEmail,
        cancelVerification: () => setPendingVerificationEmail(null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
