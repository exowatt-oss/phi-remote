import { router, Stack } from 'expo-router';

import { fonts, useTheme } from '@/theme';
import { Button } from '@/ui';

export const unstable_settings = { initialRouteName: 'index' };

export default function SettingsLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.icon,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 18, color: colors.text },
        headerBackButtonDisplayMode: 'minimal',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.bg },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
          headerRight: () => <Button compact variant="plain" title="Done" onPress={() => router.back()} />,
        }}
      />
      <Stack.Screen name="new-thread" options={{ title: 'New threads' }} />
      <Stack.Screen name="voice" options={{ title: 'Voice' }} />
      <Stack.Screen name="voice-diagnostics" options={{ title: 'Natural voice diagnostics' }} />
      <Stack.Screen name="live-dictation" options={{ title: 'Live dictation details' }} />
      <Stack.Screen name="dictionary" options={{ title: 'Dictionary' }} />
      <Stack.Screen name="dictionary-word" options={{ title: 'Add a word' }} />
      <Stack.Screen name="dictionary-list" options={{ title: '' }} />
      <Stack.Screen name="licenses" options={{ title: 'Open-source licenses' }} />
    </Stack>
  );
}
