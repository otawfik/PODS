import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { auth } from '../services/firebase';
import { ensureUserProfile, getUserProfile } from '../services/auth';
import { User } from '../types';

interface AuthContextType {
  firebaseUser: FirebaseUser | null;
  userProfile: User | null;
  /** Whether the signed-in user has verified their email. */
  emailVerified: boolean;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  /** Re-check email verification status (after the user clicks the link). */
  refreshVerification: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  firebaseUser: null,
  userProfile: null,
  emailVerified: false,
  loading: true,
  refreshProfile: async () => {},
  refreshVerification: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<User | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  const refreshProfile = async () => {
    if (firebaseUser) {
      const profile = await getUserProfile(firebaseUser.uid);
      setUserProfile(profile);
    }
  };

  const refreshVerification = async () => {
    const user = auth.currentUser;
    if (user) {
      await user.reload();
      setEmailVerified(auth.currentUser?.emailVerified ?? false);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      try {
        setFirebaseUser(user);
        if (user) {
          // Refresh so emailVerified reflects the current server state.
          await user.reload();
          setEmailVerified(auth.currentUser?.emailVerified ?? false);
          // Self-heal: an authed user with no profile doc (e.g. a failed
          // setDoc mid-register) gets a minimal one instead of a
          // permanent loading spinner.
          const profile = await ensureUserProfile(user);
          setUserProfile(profile);
        } else {
          setUserProfile(null);
          setEmailVerified(false);
        }
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider
      value={{ firebaseUser, userProfile, emailVerified, loading, refreshProfile, refreshVerification }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
