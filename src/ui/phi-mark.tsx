/**
 * phi's block φ (docs/fork/branding.md, "The logo", in ExampleOrg/phi): a 5 × 6 grid of
 * square blocks. Drawn with plain Views, one per row run, at a pixel-snapped block size so
 * the edges are sharp and abutting runs never show a seam. No brand colour: #0F0F0F on light,
 * #F5F5F5 on dark. Decorative; the wordmark beside it carries the label.
 */

import { PixelRatio, useColorScheme, View } from 'react-native';

export const PHI_GRID = ['..X..', '.XXX.', 'X.X.X', 'X.X.X', '.XXX.', '..X..'] as const;
const COLS = 5;
const ROWS = PHI_GRID.length;

export const PHI_ON_LIGHT = '#0F0F0F';
export const PHI_ON_DARK = '#F5F5F5';

/** Horizontal runs of blocks, row by row: 10 rects for the φ. */
export const PHI_RUNS: readonly { row: number; col: number; len: number }[] = PHI_GRID.flatMap((line, row) => {
  const out: { row: number; col: number; len: number }[] = [];
  for (let col = 0; col < COLS; col++) {
    if (line[col] !== 'X') continue;
    let len = 1;
    while (line[col + len] === 'X') len++;
    out.push({ row, col, len });
    col += len - 1;
  }
  return out;
});

/** `size` is the glyph height in points; the block snaps to whole device pixels. */
export function PhiMark({ size, color }: { size: number; color?: string }) {
  const scheme = useColorScheme();
  const fill = color ?? (scheme === 'dark' ? PHI_ON_DARK : PHI_ON_LIGHT);
  const block = Math.max(PixelRatio.roundToNearestPixel(size / ROWS), 1 / PixelRatio.get());
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: block * COLS, height: block * ROWS }}
    >
      {PHI_RUNS.map(({ row, col, len }) => (
        <View
          key={`${row}-${col}`}
          style={{ position: 'absolute', left: col * block, top: row * block, width: len * block, height: block, backgroundColor: fill }}
        />
      ))}
    </View>
  );
}
