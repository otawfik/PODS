// firebase v12 removed getReactNativePersistence from the default (browser)
// type entry of 'firebase/auth'. At runtime on native, Metro resolves
// 'firebase/auth' to the React Native build (@firebase/auth/dist/rn), which
// still exports it. This declaration restores the type for that
// native-only usage. It must only be called when Platform.OS !== 'web'.
import type { Persistence } from 'firebase/auth';

declare module 'firebase/auth' {
  export function getReactNativePersistence(storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }): Persistence;
}
