/** Folder picker for a new thread: recent folders on the computer, or a typed path. */

import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { expandHome, inferHome, shortCwd } from '@/lib/format';
import { basename } from '@/lib/protocol';
import { useRemote } from '@/services/remote';
import { setNewThread, useNewThread } from '@/services/new-thread';
import { fonts, radii, space, useTheme } from '@/theme';
import { Button, ListRow, ListSection, Text } from '@/ui';

export default function FolderScreen() {
  const { colors } = useTheme();
  const hostOrder = useRemote((s) => s.hostOrder);
  const hosts = useRemote((s) => s.hosts);
  const chosen = useNewThread((s) => s.hubId);
  const hubId = chosen && hosts[chosen] ? chosen : (hostOrder.find((id) => hosts[id]?.conn.status === 'live') ?? hostOrder[0] ?? '');
  const cwds = useNewThread((s) => s.cwds[hubId] ?? []);
  const typed = useNewThread((s) => s.folder[hubId]);
  const home = inferHome(cwds);
  const current = expandHome(typed ?? (cwds[0] ? shortCwd(cwds[0]) : ''), home);
  const [path, setPath] = useState(typed ?? '');

  const choose = (value: string) => {
    setNewThread((s) => ({ folder: { ...s.folder, [hubId]: value } }));
    router.back();
  };

  const typedOk = expandHome(path, home).startsWith('/');

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
      {cwds.length > 0 ? (
        <ListSection title="Recent" inset>
          {cwds.slice(0, 12).map((c) => (
            <ListRow
              key={c}
              icon="folder"
              label={basename(c) || c}
              description={shortCwd(c)}
              selected={c === current}
              onPress={() => choose(shortCwd(c))}
            />
          ))}
        </ListSection>
      ) : null}
      <ListSection title="Type a path" footer={home ? `~ is ${home}` : 'Use a full path, like /home/me/project.'}>
        <View style={styles.pathRow}>
          <TextInput
            value={path}
            onChangeText={setPath}
            placeholder="~/projects/app"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
            onSubmitEditing={() => typedOk && choose(path.trim())}
            selectionColor={colors.accent}
            accessibilityLabel="Folder path"
            style={[styles.input, { color: colors.text, backgroundColor: colors.bg }]}
          />
          <Button compact variant="plain" title="Use" disabled={!typedOk} onPress={() => choose(path.trim())} />
        </View>
      </ListSection>
      {cwds.length === 0 ? (
        <Text variant="footnote" tone="secondary" style={styles.note}>
          No recent folders on this computer yet.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  input: { flex: 1, fontFamily: fonts.mono, fontSize: 15, paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radii.md },
  note: { paddingHorizontal: space.sm },
});
