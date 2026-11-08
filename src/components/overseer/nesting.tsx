/**
 * Overseers on the session lists (Overseers, v1 addition): the quiet overseer mark, its one-line
 * thread summary with the fold toggle, and the indented frame (thin connector on the left) that
 * its threads sit in under it.
 */

import * as Haptics from 'expo-haptics';
import { Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { CountSegment } from '@/lib/overseer';
import { layout, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

/** Left edge of a nested thread's content (its glyph column starts here). */
export const NEST_INDENT = layout.rowPaddingH + 16;
const LINE_X = layout.rowPaddingH + 5;

/** The overseer mark: a small stack, in the meta colour. */
export function OverseerMark({ dim = false }: { dim?: boolean }) {
  const { colors } = useTheme();
  return <Icon name="rectangle.stack" size={12} weight="semibold" color={dim ? colors.textTertiary : colors.textSecondary} />;
}

/** "4 threads · 2 working · 1 error", errors and stalls in their colour. */
export function CountsText({ segments, dim = false }: { segments: CountSegment[]; dim?: boolean }) {
  return (
    <Text variant="label" weight="medium" tone={dim ? 'tertiary' : 'secondary'} numeric numberOfLines={1} style={styles.counts}>
      {segments.map((s, i) => (
        <Fragment key={i}>
          {i ? ' · ' : ''}
          {!dim && (s.tone === 'danger' || s.tone === 'warning') ? (
            <Text variant="label" weight="medium" tone={s.tone} numeric>
              {s.text}
            </Text>
          ) : (
            s.text
          )}
        </Fragment>
      ))}
    </Text>
  );
}

/** The overseer row's last line: its thread summary and, with threads listed, the fold toggle. */
export function OverseerSummaryLine({
  segments,
  folded,
  onToggle,
  dim = false,
}: {
  segments: CountSegment[];
  folded?: boolean;
  onToggle?: () => void;
  dim?: boolean;
}) {
  const { colors } = useTheme();
  const label = segments.map((s) => s.text).join(', ');
  return (
    <View style={styles.summary}>
      <CountsText segments={segments} dim={dim} />
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={folded ? `Show threads, ${label}` : 'Hide threads'}
          accessibilityState={{ expanded: !folded }}
          hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}
          onPress={() => {
            void Haptics.selectionAsync();
            onToggle();
          }}
          style={({ pressed }) => [styles.fold, { backgroundColor: pressed ? colors.surfacePressed : colors.surface }]}
        >
          <Icon name={folded ? 'chevron.down' : 'chevron.up'} size={10} weight="bold" color={colors.iconMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Indents a thread under its overseer, with the connector running down the left. */
export function NestedFrame({ last, children }: { last: boolean; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.frame}>
      {/* Keyed: a row that stops being the last must not keep the short line (its style is replaced, not merged). */}
      <View key={last ? 'last' : 'mid'} pointerEvents="none" style={[last ? styles.lineLast : styles.line, { backgroundColor: colors.borderStrong }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  counts: { flex: 1, minWidth: 0 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  fold: { width: 28, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  frame: { paddingLeft: NEST_INDENT },
  line: { position: 'absolute', left: LINE_X, top: 0, bottom: 0, width: 1.5, borderRadius: 1 },
  lineLast: { position: 'absolute', left: LINE_X, top: 0, height: 20, width: 1.5, borderRadius: 1 },
});
