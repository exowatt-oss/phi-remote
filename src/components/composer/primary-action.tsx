/**
 * Send / steer / stop (T3 composerSendPresentation):
 *   idle + empty → send disabled · idle + draft → send
 *   working + empty → stop · working + draft → steer (long-press: steer now / send when done)
 */

import * as Haptics from 'expo-haptics';
import { ActionSheetIOS, Platform } from 'react-native';

import type { PromptMode } from '@/lib/protocol';
import { IconButton } from '@/ui';

export type PrimaryState = 'send-disabled' | 'send' | 'steer' | 'stop';

export function primaryState(opts: { working: boolean; hasDraft: boolean; blocked: boolean }): PrimaryState {
  if (opts.blocked) return 'send-disabled';
  if (opts.working) return opts.hasDraft ? 'steer' : 'stop';
  return opts.hasDraft ? 'send' : 'send-disabled';
}

export function PrimaryAction({
  state,
  busy,
  steerOnly,
  onSend,
  onStop,
}: {
  state: PrimaryState;
  busy: boolean;
  /** No "send when done" (a subagent takes steering only). */
  steerOnly?: boolean;
  onSend: (mode: PromptMode) => void;
  onStop: () => void;
}) {
  if (state === 'stop') {
    return (
      <IconButton
        icon="stop.fill"
        label="Stop agent"
        variant="danger"
        loading={busy}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onStop();
        }}
      />
    );
  }
  if (state === 'steer') {
    return (
      <IconButton
        icon="arrow.turn.left.up"
        label="Steer now"
        hint={steerOnly ? 'Sends into the running turn.' : 'Sends into the running turn. Long-press to send when it is done instead.'}
        variant="filled"
        loading={busy}
        onPress={() => onSend('steer')}
        onLongPress={() => {
          if (Platform.OS !== 'ios' || steerOnly) return;
          void Haptics.selectionAsync();
          ActionSheetIOS.showActionSheetWithOptions(
            {
              options: ['Steer now — interrupt after the current tool', 'Send when done — queue as follow-up', 'Cancel'],
              cancelButtonIndex: 2,
            },
            (i) => {
              if (i === 0) onSend('steer');
              else if (i === 1) onSend('followUp');
            },
          );
        }}
      />
    );
  }
  return (
    <IconButton
      icon="arrow.up"
      label="Send"
      variant="filled"
      disabled={state === 'send-disabled'}
      loading={busy}
      onPress={() => onSend('auto')}
    />
  );
}
