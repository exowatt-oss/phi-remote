/** Add thread sheet (asks an overseer for one more thread), with its thread defaults screen. */

import { router, Stack } from 'expo-router';

import { fonts, useTheme } from '@/theme';
import { Button } from '@/ui';

export const unstable_settings = { initialRouteName: 'index' };

export default function AddThreadLayout() {
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
          title: 'Add thread',
          headerLeft: () => <Button compact variant="plain" title="Cancel" onPress={() => router.back()} />,
        }}
      />
      <Stack.Screen name="defaults" options={{ title: 'Thread defaults' }} />
    </Stack>
  );
}
