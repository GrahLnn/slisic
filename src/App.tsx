import "@fontsource/maple-mono";
import "sileo/styles.css";
import "./App.css";
import { useEffect } from "react";
import { Toaster } from "sileo";
import TopBar from "./topbar";
import Pages from "./pages/pages";
import {
	canRenderApp,
	canStartApp,
	useBootstrapAppEntryState,
} from "./bootstrap";
import { action as musicAction } from "./flow/music";
import {
  action as updaterAction,
  ensureStarted as ensureUpdaterStarted,
} from "./flow/updater";
import AudioVisualizerCanvas from "./components/audio/canvas";
import DevSpectrogramOverlay from "./components/audio/dev_spectrogram_overlay";
import { ENABLE_DEV_SPECTROGRAM_OVERLAY } from "./components/audio/dev_spectrogram_overlay.logic";
import Filter from "./components/svg_filter";
import { setCursorInApp } from "./flow/cursorInApp";

export interface AppShellProps {
	FilterComponent?: React.ComponentType;
	AudioVisualizerComponent?: React.ComponentType;
	DevSpectrogramOverlayComponent?: React.ComponentType;
	TopBarComponent?: React.ComponentType;
	PagesComponent?: React.ComponentType;
	ToasterComponent?: React.ComponentType<{
		position?:
			| "top-left"
			| "top-center"
			| "top-right"
			| "bottom-left"
			| "bottom-center"
			| "bottom-right";
	}>;
	enableDevSpectrogramOverlay?: boolean;
}

export function AppShell({
	FilterComponent = Filter,
	AudioVisualizerComponent = AudioVisualizerCanvas,
	DevSpectrogramOverlayComponent = DevSpectrogramOverlay,
	TopBarComponent = TopBar,
	PagesComponent = Pages,
	ToasterComponent = Toaster,
	enableDevSpectrogramOverlay = ENABLE_DEV_SPECTROGRAM_OVERLAY,
}: AppShellProps) {
	return (
		<>
			<FilterComponent />
			<AudioVisualizerComponent />
			{enableDevSpectrogramOverlay ? <DevSpectrogramOverlayComponent /> : null}
			<div
				className="flex h-screen flex-col overflow-hidden hide-scrollbar"
				onMouseEnter={() => setCursorInApp(true)}
				onMouseLeave={() => setCursorInApp(false)}
				onContextMenu={
					!import.meta.env.DEV
						? (event) => event.preventDefault()
						: undefined
				}
			>
				<TopBarComponent />
				<main className="flex flex-1 overflow-hidden hide-scrollbar">
					<PagesComponent />
				</main>
				<ToasterComponent position="bottom-right" />
			</div>
		</>
	);
}

function App() {
  const bootstrap = useBootstrapAppEntryState();
  const shouldStartApp = canStartApp(bootstrap);
  const shouldRenderApp = canRenderApp(bootstrap);

  useEffect(() => {
    if (!shouldStartApp) {
      return;
    }

    ensureUpdaterStarted();
    updaterAction.run();
    void musicAction.run();
    return () => {
      void musicAction.dispose();
    };
  }, [shouldStartApp]);

  if (!shouldRenderApp) {
    return null;
  }

  return <AppShell />;
}

export default App;
