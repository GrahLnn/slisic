import { cn, os } from "@/lib/utils";
import { AnimatePresence } from "motion/react";
import { memo } from "react";
import { useIsWindowFocus } from "./flow/windowFocus";
import { useIsDark } from "./flow/normal";
import logoUrl from "@/src/assets/logo.png";
import lightLogoUrl from "@/src/assets/logo-light.png";

export function Brand() {
  return (
    <img
      src={logoUrl}
      className="h-6 w-6"
      alt="App logo"
      draggable={false}
      style={{ imageRendering: "auto" }}
    />
  );
}

export function LightBrand() {
  return (
    <img
      src={lightLogoUrl}
      className="h-6 w-6"
      alt="App logo"
      draggable={false}
      style={{ imageRendering: "auto" }}
    />
  );
}

export const LeftControls = memo(function LeftControlsComponent() {
  return (
    <div className="flex items-center px-2 text-[var(--content)]">
      {os.match({
        macos: () => <div className="w-[84px]" />,
        _: () => null,
      })}
    </div>
  );
});

const MiddleControls = memo(function MiddleControlsComponent() {
  return <AnimatePresence mode="wait" />;
});

const TopBar = memo(function TopBarComponent() {
  const windowFocused = useIsWindowFocus();
  const isDark = useIsDark();
  const allowBarInteraction = true;

  return (
    <div
      className={cn([
        "liquidGlass-wrapper relative z-[100] flex h-8 w-full flex-none select-none",
      ])}
    >
      <div className="liquidGlass-effect" />
      <div className="liquidGlass-tint" />
      <div
        className={cn([
          "z-10 grid h-full w-full grid-cols-[1fr_auto_1fr]",
          !windowFocused && "opacity-30",
          "transition duration-300 ease-in-out",
        ])}
        data-tauri-drag-region={!allowBarInteraction}
      >
        {allowBarInteraction ? (
          <>
            <div
              data-tauri-drag-region
              className={cn(["flex items-center justify-start pl-1"])}
            >
              {os.is("windows") ? isDark ? <Brand /> : <LightBrand /> : null}
              <LeftControls />
            </div>
            <div data-tauri-drag-region className={cn(["flex justify-center"])}>
              <MiddleControls />
            </div>
            <div data-tauri-drag-region className={cn(["flex justify-end"])} />
          </>
        ) : null}
      </div>
    </div>
  );
});

export default TopBar;
