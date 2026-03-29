import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WindowName as CmdWindowName } from "../../cmd";
import {
  createElement,
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { crab } from "../../cmd";
import {
  action as updaterAction,
  ensureStarted as ensureUpdaterStarted,
} from "../updater";
import {
  createInitialAppWindowMeta,
  normalizeWindowName,
  shouldRunUpdater,
  toAppBootstrap,
  type AppBootstrap as AppBootstrapSnapshot,
  type AppWindowMeta,
} from "./logic";

const windowKindChangedEvent = "factory://window-kind-changed";

export type AppBootstrap = AppBootstrapSnapshot;

class AppBootstrapStore {
  private meta = createInitialAppWindowMeta();
  private snapshot = toAppBootstrap(this.meta);
  private listeners = new Set<() => void>();
  private started = false;
  private didRecordBootstrapReady = false;
  private didRunUpdater = false;
  private warmOwners = new Map<CmdWindowName, Set<string>>();
  private activeWarmTargets = new Set<CmdWindowName>();

  subscribe = (listener: () => void) => {
    this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AppBootstrapSnapshot => this.snapshot;

  start = () => {
    if (this.started) {
      return;
    }

    this.started = true;
    void crab.appReady().catch((error) => {
      console.error("Failed to signal app ready", error);
    });

    void this.resolveWindowKind();
    void this.subscribeToWindowKindChanges();
  };

  private setMeta(nextMeta: AppWindowMeta) {
    this.meta = nextMeta;
    this.snapshot = toAppBootstrap(nextMeta);

    for (const listener of this.listeners) {
      listener();
    }

    this.maybeRunUpdater();
    this.syncWarmTargets();
  }

  private async resolveWindowKind() {
    try {
      const windowKind = await crab.getWindowKind();
      const nextMeta: AppWindowMeta = {
        window: normalizeWindowName(windowKind.window),
        label: windowKind.label,
        isPrimaryWindow: windowKind.is_primary_window,
        isUserWindow: windowKind.is_user_window,
        isPreparedWindow: windowKind.is_prepared_window,
        status: "ready",
      };

      this.setMeta(nextMeta);

      if (!this.didRecordBootstrapReady) {
        this.didRecordBootstrapReady = true;
        void crab.recordRendererBootstrapReady().catch((error) => {
          console.error("Failed to record renderer bootstrap ready", error);
        });
      }
    } catch (error) {
      console.error("Failed to resolve window kind", error);
      this.setMeta({
        ...this.meta,
        status: "error",
      });
    }
  }

  private maybeRunUpdater() {
    if (this.didRunUpdater || !shouldRunUpdater(this.meta)) {
      return;
    }

    this.didRunUpdater = true;
    ensureUpdaterStarted();
    updaterAction.run();
  }

  private async subscribeToWindowKindChanges() {
    try {
      const currentWindow = getCurrentWindow();
      await currentWindow.listen(windowKindChangedEvent, () => {
        void this.resolveWindowKind();
      });
    } catch (error) {
      console.error("Failed to subscribe to window kind changes", error);
    }
  }

  warm(name: CmdWindowName, owner?: string) {
    this.start();
    const resolvedOwner = this.resolveWarmOwner(name, owner);

    const owners = this.warmOwners.get(name) ?? new Set<string>();
    if (owners.has(resolvedOwner)) {
      return;
    }

    owners.add(resolvedOwner);
    this.warmOwners.set(name, owners);
    this.syncWarmTarget(name);
  }

  cold(name: CmdWindowName, owner?: string) {
    this.start();
    const resolvedOwner = this.resolveWarmOwner(name, owner);

    const owners = this.warmOwners.get(name);
    if (!owners?.delete(resolvedOwner)) {
      return;
    }

    if (owners.size === 0) {
      this.warmOwners.delete(name);
    }

    this.syncWarmTarget(name);
  }

  private canSyncWarmTargets() {
    return (
      this.snapshot.status === "ready" &&
      this.snapshot.showWindowControls &&
      this.snapshot.label.length > 0
    );
  }

  private wantsWarmTarget(name: CmdWindowName) {
    return (this.warmOwners.get(name)?.size ?? 0) > 0;
  }

  private resolveWarmOwner(name: CmdWindowName, owner?: string) {
    return owner ?? `default:${name}`;
  }

  private syncWarmTargets() {
    const targets = new Set<CmdWindowName>([
      ...this.warmOwners.keys(),
      ...this.activeWarmTargets,
    ]);

    for (const name of targets) {
      this.syncWarmTarget(name);
    }
  }

  private syncWarmTarget(name: CmdWindowName) {
    if (!this.canSyncWarmTargets()) {
      return;
    }

    const shouldWarm = this.wantsWarmTarget(name);
    const isWarm = this.activeWarmTargets.has(name);

    if (shouldWarm === isWarm) {
      return;
    }

    if (shouldWarm) {
      this.activeWarmTargets.add(name);
      void crab.warmWindow(name).catch((error) => {
        this.activeWarmTargets.delete(name);
        console.error(`Failed to warm ${name} window`, error);
      });
      return;
    }

    this.activeWarmTargets.delete(name);
    void crab.coldWindow(name).catch((error) => {
      this.activeWarmTargets.add(name);
      console.error(`Failed to cool ${name} window`, error);
    });
  }
}

export const app = new AppBootstrapStore();

const AppBootstrapContext = createContext<AppBootstrapSnapshot | null>(null);

function useAppBootstrapSnapshot(): AppBootstrapSnapshot {
  return useSyncExternalStore(app.subscribe, app.getSnapshot, app.getSnapshot);
}

export function AppBootstrapProvider({ children }: { children: ReactNode }) {
  const snapshot = useAppBootstrapSnapshot();

  return createElement(
    AppBootstrapContext.Provider,
    { value: snapshot },
    children,
  );
}

export function useAppBootstrap(): AppBootstrap {
  const snapshot = useContext(AppBootstrapContext);
  if (!snapshot) {
    throw new Error("useAppBootstrap must be used within AppBootstrapProvider");
  }
  return snapshot;
}
