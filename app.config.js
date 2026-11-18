// Expo app config. Supabase settings come from EXPO_PUBLIC_SUPABASE_* in
// .env (read directly in src/services/supabase.ts). Copy .env.example to .env.
export default {
  expo: {
    name: "PODS",
    slug: "PODS",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    plugins: ["expo-status-bar", "expo-notifications"],
    userInterfaceStyle: "automatic",
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#6C63FF"
    },
    ios: {
      supportsTablet: true
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png"
      }
    },
    web: {
      favicon: "./assets/favicon.png"
    },
  },
};
