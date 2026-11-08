import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { showToast } from './toast';

/**
 * Copies text with T3's light haptic. `message` shows a toast; pass null when the control
 * shows its own "Copied" state.
 */
export function copyWithFeedback(text: string, message: string | null = 'Copied'): void {
  if (!text) return;
  void Clipboard.setStringAsync(text);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  if (message) showToast(message);
}
