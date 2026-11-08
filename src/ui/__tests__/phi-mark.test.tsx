import type { ReactElement } from 'react';

import { PHI_GRID, PHI_ON_DARK, PHI_ON_LIGHT, PHI_RUNS, PhiMark } from '../phi-mark';

const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');

// jest.mock is hoisted above the imports. The component is a pure function of its props and the colour scheme; calling it directly
// (no renderer) with a stub react-native keeps the test independent of native modules.
jest.mock('react-native', () => ({
  View: 'View',
  PixelRatio: { get: () => 3, roundToNearestPixel: (n: number) => Math.round(n * 3) / 3 },
  useColorScheme: () => mockScheme(),
}));

type Style = { left: number; top: number; width: number; height: number; backgroundColor: string };
type Root = ReactElement<{ style: { width: number; height: number }; accessible: boolean; children: ReactElement<{ style: Style }>[] }>;

const render = (props: Parameters<typeof PhiMark>[0]) => PhiMark(props) as Root;

describe('PhiMark', () => {
  it('draws the branding.md grid as 10 row runs covering 14 blocks', () => {
    expect(PHI_RUNS).toHaveLength(10);
    expect(PHI_RUNS.reduce((n, r) => n + r.len, 0)).toBe(14);
    const blocks = PHI_GRID.join('').split('').filter((c) => c === 'X').length;
    expect(blocks).toBe(14);
  });

  it('renders one rect per run, sized from a pixel-snapped block', () => {
    const el = render({ size: 18 });
    expect(el.props.accessible).toBe(false);
    expect(el.props.children).toHaveLength(10);
    expect(el.props.style).toEqual({ width: 15, height: 18 });
    const rects = el.props.children.map((c) => c.props.style);
    expect(rects[0]).toMatchObject({ left: 6, top: 0, width: 3, height: 3 });
    expect(rects[1]).toMatchObject({ left: 3, top: 3, width: 9, height: 3 });
    // Every edge lands on a whole device pixel (3x).
    for (const r of rects) for (const v of [r.left, r.top, r.width, r.height]) expect(Number.isInteger(v * 3)).toBe(true);
  });

  it('snaps an awkward size to device pixels', () => {
    const el = render({ size: 20 });
    expect(el.props.style.height).toBeCloseTo(20, 5); // 3.333 pt blocks = 10 px
    for (const c of el.props.children) expect(Number.isInteger(Math.round(c.props.style.width * 3 * 1e6) / 1e6)).toBe(true);
  });

  it('defaults to the scheme colour and honours an explicit one', () => {
    mockScheme.mockReturnValueOnce('light');
    expect(render({ size: 12 }).props.children[0].props.style.backgroundColor).toBe(PHI_ON_LIGHT);
    mockScheme.mockReturnValueOnce('dark');
    expect(render({ size: 12 }).props.children[0].props.style.backgroundColor).toBe(PHI_ON_DARK);
    mockScheme.mockReturnValueOnce('dark');
    const custom = render({ size: 12, color: '#123456' });
    expect(custom.props.children.every((c) => c.props.style.backgroundColor === '#123456')).toBe(true);
  });
});
