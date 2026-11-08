import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { ToastHost } from '@/components/toast';
import { useBootstrap } from '@/services/bootstrap';
import { useRemote } from '@/services/remote';
import { glassAvailable, navigationTheme, useTheme } from '@/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  useBootstrap();
  const { dark, colors } = useTheme();
  const ready = useRemote((s) => s.ready);
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  // iOS 26 sheets are glass with system corners; set a radius only on older systems.
  const sheet = {
    presentation: 'formSheet' as const,
    sheetGrabberVisible: true,
    headerShown: false,
    contentStyle: { backgroundColor: colors.bg },
    ...(glassAvailable() ? {} : { sheetCornerRadius: 22 }),
  };

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardProvider>
        <ThemeProvider value={navigationTheme(dark)}>
          <Stack
            screenOptions={{
              headerTintColor: colors.icon,
              headerBackButtonDisplayMode: 'minimal',
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="sessions" />
            <Stack.Screen name="session/[hubId]/[sessionId]/index" />
            <Stack.Screen name="session/[hubId]/[sessionId]/model" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
            <Stack.Screen name="session/[hubId]/[sessionId]/subagents" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
            <Stack.Screen name="session/[hubId]/[sessionId]/threads" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
            <Stack.Screen name="session/[hubId]/[sessionId]/add-thread" options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="new" options={{ ...sheet, sheetAllowedDetents: [1] }} />
            <Stack.Screen name="hosts" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
            <Stack.Screen name="settings" options={{ ...sheet, sheetAllowedDetents: [1] }} />
          </Stack>
          <ToastHost />
          <StatusBar style="auto" />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
