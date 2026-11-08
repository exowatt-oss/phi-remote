/**
 * App start: load paired computers and connect (then follow network path changes), restore push
 * registration (or offer notifications once if the user never chose), and route notification
 * taps (cold start and while running) to their thread.
 */

import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { sessionHref } from '@/lib/format';
import { notificationTarget } from '@/lib/notification-target';

import { runDictationSelfTestIfRequested } from './dictation-self-test';
import { initDictionary } from './dictionary';
import { initLiveDictation } from './live-dictation';
import { initNaturalVoice } from './natural-voice';
import { runNaturalVoiceSelfTestIfRequested } from './natural-voice-self-test';
import { watchNetwork } from './network';
import { runPhononSelfTestIfRequested } from './phonon-self-test';
import { configureForegroundNotifications, offerNotifications, restorePushRegistration } from './push';
import { runStallProbeIfRequested } from './qa-probe';
import { remote } from './remote';

runStallProbeIfRequested();
configureForegroundNotifications();

function openFromNotification(notification: Notifications.Notification): void {
  const target = notificationTarget(notification);
  if (target) router.push(sessionHref(target.hubId, target.sessionId));
}

export function useBootstrap(): void {
  useEffect(() => {
    // Network path changes (Wi-Fi, cellular, Tailscale coming up) retry every computer at once.
    void remote.init().then(watchNetwork);
    void restorePushRegistration()
      .then(offerNotifications)
      .catch(() => undefined);
    void runDictationSelfTestIfRequested();
    initDictionary();
    initLiveDictation();
    initNaturalVoice();
    void runPhononSelfTestIfRequested();
    void runNaturalVoiceSelfTestIfRequested();

    const launch = Notifications.getLastNotificationResponse();
    if (launch?.notification) {
      openFromNotification(launch.notification);
      Notifications.clearLastNotificationResponse();
    }
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      openFromNotification(response.notification);
    });
    return () => sub.remove();
  }, []);
}
