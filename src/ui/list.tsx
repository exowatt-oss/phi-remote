import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View, type DimensionValue } from 'react-native';

import { layout, radii, space, useTheme } from '@/theme';

import { Icon, type IconName } from './icon';
import { Text } from './text';

/**
 * T3 ListSection: a titled group of rows on a `surface` card (radius 24, continuous),
 * hairline separators between rows (inset past the icon column when rows have icons).
 */
export function ListSection({
  title,
  footer,
  inset = false,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  /** Rows carry icons: separators start after the icon column. */
  inset?: boolean;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.section}>
      {title ? (
        <Text variant="footnote" weight="medium" tone="secondary" style={styles.title} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <View style={[styles.card, { backgroundColor: colors.surface }]}>
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {i > 0 ? (
              <View style={[styles.separator, { backgroundColor: colors.separator, marginLeft: inset ? 52 : space.lg }]} />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? (
        typeof footer === 'string' ? (
          <Text variant="footnote" tone="secondary" style={styles.footer}>
            {footer}
          </Text>
        ) : (
          <View style={styles.footer}>{footer}</View>
        )
      ) : null}
    </View>
  );
}

/** T3 ListRowLayout. Details stack under the label at accessibility text sizes. */
export function ListRow({
  label,
  description,
  detail,
  icon,
  iconColor,
  accessory,
  onPress,
  onLongPress,
  destructive,
  chevron,
  selected,
  disabled,
  detailMaxWidth,
  accessibilityLabel,
}: {
  label: string;
  description?: string;
  detail?: string;
  icon?: IconName;
  iconColor?: string;
  accessory?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  chevron?: boolean;
  /** Shows an accent checkmark. */
  selected?: boolean;
  disabled?: boolean;
  /** How much of the row the detail may take before it truncates (default 40%). */
  detailMaxWidth?: DimensionValue;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.5;
  const body = (
    <View
      style={[
        styles.row,
        { minHeight: description ? layout.listCellMinWithDescription : layout.listCellMin },
        disabled && { opacity: 0.45 },
      ]}
    >
      {icon ? (
        <View style={styles.iconSlot}>
          <Icon name={icon} size={20} color={iconColor ?? (destructive ? colors.danger : colors.icon)} />
        </View>
      ) : null}
      <View style={[styles.main, stacked && styles.mainStacked]}>
        <View style={styles.labels}>
          <Text variant="body" tone={destructive ? 'danger' : 'primary'} numberOfLines={stacked ? undefined : 1}>
            {label}
          </Text>
          {description ? (
            <Text variant="footnote" tone="secondary" numberOfLines={stacked ? undefined : 2}>
              {description}
            </Text>
          ) : null}
        </View>
        {detail ? (
          <Text
            variant="footnote"
            tone="secondary"
            numberOfLines={1}
            ellipsizeMode="middle"
            style={stacked ? undefined : detailMaxWidth ? { maxWidth: detailMaxWidth } : styles.detail}
          >
            {detail}
          </Text>
        ) : null}
      </View>
      {accessory}
      {selected ? <Icon name="checkmark" size={15} color={colors.accent} weight="semibold" /> : null}
      {chevron ? <Icon name="chevron.right" size={11} color={colors.chevron} weight="semibold" /> : null}
    </View>
  );
  if (!onPress && !onLongPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [label, description, detail].filter(Boolean).join(', ')}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => pressed && { backgroundColor: colors.surfacePressed }}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  title: { paddingHorizontal: space.sm },
  card: { borderRadius: radii.group, borderCurve: 'continuous', overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth },
  footer: { paddingHorizontal: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  iconSlot: { width: 24, alignItems: 'center' },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mainStacked: { flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
  labels: { flex: 1, gap: 1 },
  detail: { maxWidth: '40%' },
});
