import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { Window } from "@tauri-apps/api/window";
import type React from "react";
import { type PropsWithChildren, useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { useIsWindowFocus } from "../state_machine/windowFocus";
import { events } from "../cmd/commands";

const appWindow = Window.getCurrent();

const windowsControlsPortal = document.createElement("div");
windowsControlsPortal.id = "windows-controls-portal";

document.documentElement.appendChild(windowsControlsPortal);

interface WindowButtonProps extends PropsWithChildren {
  className?: string;
  onClick?: () => void;
  icon: React.ReactNode;
}

function WindowButton({ className, onClick, icon }: WindowButtonProps) {
  return (
    <div
      className={cn([
        "flex items-center justify-center",
        "text-center",
        "h-3 w-3 rounded-full bg-[#e5e5e5] dark:bg-[#171717]",
        "duration-300 transition",
        className,
      ])}
      onClick={onClick}
    >
      {icon}
    </div>
  );
}

function Core() {
  const is_fullscreen = useState<boolean>(false);
  const windowFocused = useIsWindowFocus();
  useEffect(() => {
    const unlisten = events.fullScreenEvent.listen((event) => {
      is_fullscreen[1](event.payload.is_fullscreen);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  const iconcn =
    "opacity-0 group-hover:opacity-60 transition-opacity duration-300 mx-auto my-auto";
  const iconsize = 8;
  return (
    <div
      className={cn([
        "group flex items-center h-8 mx-4 gap-2",
        is_fullscreen[0] && "opacity-0",
        !windowFocused && "opacity-30 hover:opacity-100",
        "transition-all duration-300",
      ])}
    >
      <WindowButton
        className="group-hover:bg-[#ff5f57]"
        icon={<icons.xmarksm size={iconsize} className={iconcn} />}
        onClick={() => appWindow.close()}
      />
      <WindowButton
        className="group-hover:bg-[#ffbc2e]"
        icon={<icons.minussm size={iconsize} className={iconcn} />}
        onClick={() => appWindow.minimize()}
      />
      <WindowButton
        className="group-hover:bg-[#27c63f]"
        icon={
          <icons.caretMaximizeDiagonal2 size={iconsize} className={iconcn} />
        }
        onClick={() => {
          appWindow.setFullscreen(true);
          is_fullscreen[1](true);
        }}
      />
    </div>
  );
}

function MacOSControlsPortal() {
  return ReactDOM.createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: 99999,
      }}
    >
      <Core />
    </div>,
    windowsControlsPortal
  );
}

export default MacOSControlsPortal;
