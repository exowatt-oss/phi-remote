#!/usr/bin/env node
/**
 * Draws phi's official block φ (docs/fork/branding.md, "The logo", in the phi project):
 *   assets/icon.png              1024×1024 opaque RGB (App Store rejects alpha): #F5F5F5 φ on a
 *                                full-bleed #0F0F0F square; iOS applies its own corner mask
 *   assets/splash-icon.png       336×336 transparent, #0F0F0F φ (light splash)
 *   assets/splash-icon-dark.png  336×336 transparent, #F5F5F5 φ (dark splash)
 *
 * The φ is a 5 × 6 grid of square blocks with no brand colour. Every block is painted as
 * whole pixels straight into a raw buffer (one rect per row run, integer coordinates), so
 * edges stay sharp and abutting blocks never show anti-aliased seams.
 *
 * Icon: 108 px blocks → a 540 × 648 glyph (63% of the height) at (242, 188). The margins stay
 * well clear of the iOS squircle, and at the 180 px home-screen size a block is 18.98 px, so
 * it downsamples to almost exactly 19 px per block.
 *
 * Splash: expo-splash-screen resizes the image to an `imageWidth` square (112 pt in
 * app.config.ts) at 1x/2x/3x. The source is that square at 3x (336 px) with 36 px blocks (12 pt):
 * a 60 × 72 pt φ at (26, 20) pt, whole pixels at every scale, and the 3x asset is the source
 * itself. Run: npm run icons
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The glyph, exactly as branding.md draws it. */
const GRID = ['..X..', '.XXX.', 'X.X.X', 'X.X.X', '.XXX.', '..X..'];
const COLS = GRID[0].length;
const ROWS = GRID.length;
const LIGHT = [0xf5, 0xf5, 0xf5]; // on dark backgrounds
const DARK = [0x0f, 0x0f, 0x0f]; // on light backgrounds, and the tile

/** Horizontal runs of blocks per row: [row, firstCol, length]. */
function runs() {
  const out = [];
  GRID.forEach((line, row) => {
    for (let col = 0; col < COLS; col++) {
      if (line[col] !== 'X') continue;
      let len = 1;
      while (line[col + len] === 'X') len++;
      out.push([row, col, len]);
      col += len - 1;
    }
  });
  return out;
}

/** A square RGBA canvas with the φ centred at whole-pixel `block` size. */
function draw({ size, block, fg, bg }) {
  const w = COLS * block;
  const h = ROWS * block;
  const x0 = (size - w) / 2;
  const y0 = (size - h) / 2;
  if (!Number.isInteger(x0) || !Number.isInteger(y0)) throw new Error(`φ ${w}×${h} does not centre on whole pixels in ${size}`);
  const px = Buffer.alloc(size * size * 4);
  const fill = (x, y, rw, rh, [r, g, b], a) => {
    for (let yy = y; yy < y + rh; yy++) {
      for (let xx = x; xx < x + rw; xx++) {
        const i = (yy * size + xx) * 4;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = a;
      }
    }
  };
  if (bg) fill(0, 0, size, size, bg, 255);
  for (const [row, col, len] of runs()) fill(x0 + col * block, y0 + row * block, len * block, block, fg, 255);
  return sharp(px, { raw: { width: size, height: size, channels: 4 } });
}

mkdirSync(join(root, 'assets'), { recursive: true });

const ICON = 1024;
await draw({ size: ICON, block: 108, fg: LIGHT, bg: DARK })
  .removeAlpha()
  .toColourspace('srgb')
  .png({ compressionLevel: 9 })
  .toFile(join(root, 'assets/icon.png'));

const SPLASH = 336;
await draw({ size: SPLASH, block: 36, fg: DARK }).png({ compressionLevel: 9 }).toFile(join(root, 'assets/splash-icon.png'));
await draw({ size: SPLASH, block: 36, fg: LIGHT }).png({ compressionLevel: 9 }).toFile(join(root, 'assets/splash-icon-dark.png'));

const meta = await sharp(join(root, 'assets/icon.png')).metadata();
if (meta.hasAlpha || meta.channels !== 3 || meta.width !== ICON || meta.height !== ICON) {
  throw new Error(`icon.png is not an opaque ${ICON}px RGB image: ${JSON.stringify(meta)}`);
}
console.log(`assets/icon.png ${meta.width}x${meta.height} channels=${meta.channels} alpha=${meta.hasAlpha}`);
console.log(`assets/splash-icon.png, assets/splash-icon-dark.png ${SPLASH}x${SPLASH} written`);
