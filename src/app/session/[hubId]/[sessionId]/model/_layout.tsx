/** Model sheet: its own stack so it gets the native sheet header (title + Done), like the others. */

import { router, Stack } from 'expo-router';

import { fonts, useTheme } from '@/theme';
import { Button } from '@/ui';

export default function ModelSheetLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.icon,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 18, color: colors.text },
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.bg },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Model',
          headerRight: () => <Button compact variant="plain" title="Done" onPress={() => router.back()} />,
        }}
      />
    </Stack>
  );
}
