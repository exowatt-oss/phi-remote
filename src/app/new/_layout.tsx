import { router, Stack } from 'expo-router';

import { fonts, useTheme } from '@/theme';
import { Button } from '@/ui';

export const unstable_settings = { initialRouteName: 'index' };

export default function NewThreadLayout() {
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
          title: 'New thread',
          headerLeft: () => <Button compact variant="plain" title="Cancel" onPress={() => router.back()} />,
        }}
      />
      <Stack.Screen name="folder" options={{ title: 'Folder' }} />
      <Stack.Screen name="model" options={{ title: 'Model' }} />
      <Stack.Screen name="overseer" options={{ title: 'Thread defaults' }} />
    </Stack>
  );
}
