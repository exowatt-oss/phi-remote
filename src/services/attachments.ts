/**
 * Image attachments: pick from the library, downscale to ≤ 1600 px on the long side,
 * re-encode as JPEG ~0.8, base64 for `session.prompt`.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { base64Bytes, fitWithin } from '@/lib/format';
import type { PromptImage } from '@/lib/protocol';

export type Attachment = PromptImage & { id: string; uri: string; width: number; height: number; bytes: number };

export const MAX_ATTACHMENTS = 4;
/** Stay well under the hub's 12 MiB inbound frame cap. */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

let seq = 0;

async function prepare(asset: ImagePicker.ImagePickerAsset): Promise<Attachment> {
  const ctx = ImageManipulator.manipulate(asset.uri);
  const target = fitWithin(asset.width, asset.height, 1600);
  if (target) ctx.resize(target);
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  const data = saved.base64 ?? '';
  return {
    id: `att-${Date.now()}-${seq++}`,
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    mimeType: 'image/jpeg',
    data,
    bytes: base64Bytes(data),
  };
}

export type PickResult = { attachments: Attachment[]; error?: string };

/** Opens the photo library; `room` is how many more images may be attached. */
export async function pickImages(room: number): Promise<PickResult> {
  if (room <= 0) return { attachments: [], error: `Up to ${MAX_ATTACHMENTS} images per message.` };
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: room > 1,
    selectionLimit: room,
    quality: 1,
    exif: false,
  });
  if (result.canceled || !result.assets?.length) return { attachments: [] };
  const attachments: Attachment[] = [];
  for (const asset of result.assets.slice(0, room)) {
    try {
      attachments.push(await prepare(asset));
    } catch {
      return { attachments, error: 'One of the images could not be read.' };
    }
  }
  return { attachments };
}

export function totalBytes(list: Attachment[]): number {
  return list.reduce((n, a) => n + a.bytes, 0);
}
