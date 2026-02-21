import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { Window } from "@tauri-apps/api/window";
import type React from "react";
import { type KeyboardEvent, type PropsWithChildren, memo } from "react";
import ReactDOM from "react-dom";
import { useIsWindowFocus } from "../state_machine/windowFocus";
import { useIsWindowMaximized } from "../state_machine/windowMaximized";

const appWindow = Window.getCurrent();

const windowsControlsPortal = document.createElement("div");
windowsControlsPortal.id = "windows-controls-portal";

document.documentElement.appendChild(windowsControlsPortal);

interface WindowsButtonProps extends PropsWithChildren {
  onClick?: () => void;
  className?: string;
  title?: string;
  color?: string;
  emphasizeColor?: string;
  isWindowFocused?: boolean;
}

const WindowsButton = memo(function WindowsButton({
  children,
  onClick,
  title,
  color,
  className,
  emphasizeColor,
  isWindowFocused,
}: WindowsButtonProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      onClick?.();
    }
  };

  return (
    <div
      className={cn([
        !isWindowFocused && "opacity-30 hover:opacity-100",
        "transition-all duration-300",
      ])}
    >
      <button
        type="button"
        onClick={onClick}
        onKeyDown={handleKeyDown}
        className={cn(
          "h-8 w-11.5 flex items-center justify-center",
          "opacity-60 hover:opacity-100",
          // isWindowFocused ? "opacity-60" : "opacity-30",
          "text-[#090909] dark:text-[#f6f6f6]",
          "transition-all",
          "pointer-events-auto",
          color
            ? "hover:bg-(--hover-bg-color) hover:text-(--hover-text-color)"
            : "hover:bg-black/5 dark:hover:bg-white/5",
          className,
        )}
        style={{
          ...(color
            ? ({ "--hover-bg-color": color } as React.CSSProperties)
            : {}),
          ...(emphasizeColor
            ? ({ "--hover-text-color": emphasizeColor } as React.CSSProperties)
            : {}),
        }}
        title={title}
        tabIndex={0}
      >
        {children}
      </button>
    </div>
  );
});

const WindowsControlsCore = memo(function WindowsControlsCore() {
  const maximized = useIsWindowMaximized();
  const windowFocused = useIsWindowFocus();

  return (
    <div
      className={cn([
        "flex items-center z-9999 relative transition duration-300",
      ])}
    >
      <WindowsButton
        onClick={() => appWindow.minimize()}
        isWindowFocused={windowFocused}
      >
        <icons.minus size={14} />
      </WindowsButton>
      <WindowsButton
        onClick={() => appWindow.toggleMaximize()}
        isWindowFocused={windowFocused}
      >
        {maximized ? (
          <icons.stacksquare size={14} />
        ) : (
          <icons.square size={14} />
        )}
      </WindowsButton>
      <WindowsButton
        onClick={() => appWindow.close()}
        color="#e81123"
        emphasizeColor="#f0f0f0"
        isWindowFocused={windowFocused}
      >
        <icons.xmark />
      </WindowsButton>
    </div>
  );
});

function WindowsControlsPortal() {
  return ReactDOM.createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        zIndex: 99999,
      }}
    >
      <WindowsControlsCore />
    </div>,
    windowsControlsPortal,
  );
}

export default WindowsControlsPortal;
