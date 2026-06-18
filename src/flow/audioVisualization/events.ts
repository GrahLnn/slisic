import { crab } from "@/src/cmd";
import { commitAudioVisualizationFrame } from "./store";
import type { PlaybackAudioVisualizationFrame } from "./model";

let unsubscribeAudioVisualizationFrame: (() => void) | null = null;
let listenerPromise: Promise<void> | null = null;
let listenerLeaseCount = 0;

function attachAudioVisualizationEventListener() {
  if (listenerPromise) {
    return listenerPromise;
  }

  listenerPromise = crab
    .evt("playbackAudioVisualizationFrameEvent")((payload: PlaybackAudioVisualizationFrame) => {
      commitAudioVisualizationFrame(payload);
    })
    .then((unsubscribe) => {
      unsubscribeAudioVisualizationFrame = unsubscribe;
    })
    .catch((error) => {
      listenerPromise = null;
      console.error("Failed to attach playback audio visualization listener", error);
    });

  return listenerPromise;
}

export function acquireAudioVisualizationEventListener() {
  listenerLeaseCount += 1;
  void attachAudioVisualizationEventListener();

  return () => {
    listenerLeaseCount = Math.max(0, listenerLeaseCount - 1);
    if (listenerLeaseCount > 0) {
      return;
    }

    disposeAudioVisualizationEventListener();
  };
}

function disposeAudioVisualizationEventListener() {
  unsubscribeAudioVisualizationFrame?.();
  unsubscribeAudioVisualizationFrame = null;
  listenerPromise = null;
}
