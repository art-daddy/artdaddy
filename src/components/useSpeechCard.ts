// The speech card's data, read from the stores that hold it. The card owns nothing: this reads the wake registry's
// view, the speech jobs, the model's download, the box's draft and the credit balance, and hands them to the pure
// `cardInputOf`, then to `cardView` for the words. When nothing is being waited for the view is null and the card
// is not there.
import { useSyncExternalStore } from "react";

import { getUsage, subscribeUsage } from "../api/usage";
import { useComposer } from "../store/composer";
import { downloadEtaSeconds, percent, useModelDownload } from "../store/modelDownload";
import { useSpeechJobs } from "../store/speechJobs";
import type { ChatKey } from "../store/speechWake";
import { dismissWakeNote, useWakeView, wakeViewOf } from "../store/speechWakeHost";
import { cardInputOf } from "../tools/speechCardInput";
import { currentPaceModel, projectedS } from "../tools/speechPace";
import { cardView, type CardView } from "../tools/speechTimeLine";

export function useSpeechCard(chat: ChatKey | null): {
  view: CardView | null;
  dismiss: (id: string) => void;
} {
  // Each of these changes what the card says; none is read for its value here.
  useWakeView((s) => s.version);
  useComposer((s) => s.hasDraft);
  useSyncExternalStore(subscribeUsage, getUsage);
  const jobs = useSpeechJobs((s) => s.jobs);
  const dl = useModelDownload();
  if (!chat) return { view: null, dismiss: () => undefined };
  const download =
    dl.total > 0
      ? { pct: percent(dl.received, dl.total), etaS: downloadEtaSeconds(dl), again: dl.again }
      : null;
  const pace = currentPaceModel();
  const view = cardView(
    cardInputOf({
      wake: wakeViewOf(chat),
      jobs,
      download,
      projectedS: (audioS) => projectedS(pace, audioS),
    }),
  );
  return { view, dismiss: (id) => dismissWakeNote(chat, id) };
}
