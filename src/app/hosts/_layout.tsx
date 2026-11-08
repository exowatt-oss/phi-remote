import { router, Stack } from 'expo-router';

import { fonts, useTheme } from '@/theme';
import { Button } from '@/ui';

export const unstable_settings = { initialRouteName: 'index' };

export default function HostsLayout() {
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
          title: 'Computers',
          headerRight: () => <Button compact variant="plain" title="Done" onPress={() => router.back()} />,
        }}
      />
      <Stack.Screen name="pair" options={{ title: 'Add a computer' }} />
      <Stack.Screen name="[hubId]" options={{ title: '' }} />
      <Stack.Screen name="log" options={{ title: 'Connection log' }} />
    </Stack>
  );
}
