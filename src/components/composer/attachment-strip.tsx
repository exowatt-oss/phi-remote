import { Image, Pressable, StyleSheet, View } from 'react-native';

import type { Attachment } from '@/services/attachments';
import { radii, space, useTheme } from '@/theme';
import { Icon } from '@/ui';

/** 56 pt thumbnails (expanded) or up to three 28 pt thumbs (collapsed). */
export function AttachmentStrip({
  items,
  compact,
  onRemove,
}: {
  items: Attachment[];
  compact?: boolean;
  onRemove: (id: string) => void;
}) {
  const { colors } = useTheme();
  if (items.length === 0) return null;
  if (compact) {
    return (
      <View style={styles.compact} accessibilityLabel={`${items.length} photo${items.length === 1 ? '' : 's'} attached`}>
        {items.slice(0, 3).map((a) => (
          <Image key={a.id} source={{ uri: a.uri }} style={[styles.tiny, { backgroundColor: colors.surface }]} />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.strip}>
      {items.map((a, i) => (
        <View key={a.id} style={styles.wrap}>
          <Image source={{ uri: a.uri }} style={[styles.thumb, { backgroundColor: colors.surface }]} accessibilityLabel={`Photo ${i + 1}`} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove photo ${i + 1}`}
            hitSlop={12}
            onPress={() => onRemove(a.id)}
            style={[styles.remove, { backgroundColor: colors.scrim }]}
          >
            <Icon name="xmark" size={10} weight="bold" color={colors.onAccent} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  compact: { flexDirection: 'row', gap: 4 },
  tiny: { width: 28, height: 28, borderRadius: radii.sm },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: 14, paddingBottom: space.xs },
  wrap: { width: 56, height: 56 },
  thumb: { width: 56, height: 56, borderRadius: radii.md, borderCurve: 'continuous' },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
