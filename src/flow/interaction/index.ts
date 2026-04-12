import { useEffect } from "react";
import type { AppBootstrap } from "../bootstrap";
import { action } from "./api";

let didRunInitialCheck = false;

function shouldRunInitialCheck(snapshot: AppBootstrap) {
  return (
    snapshot.status === "ready" &&
    snapshot.window.match({
      main: () => true,
      support: () => false,
    })
  );
}

export function useInteractionBootstrap(snapshot: AppBootstrap) {
  const readyToRun = shouldRunInitialCheck(snapshot);

  useEffect(() => {
    if (!readyToRun || didRunInitialCheck) {
      return;
    }

    didRunInitialCheck = true;
    console.log("[interaction] bootstrap ready -> run");
    action.run();
  }, [readyToRun]);
}

export * from "./api";
export * from "./events";
