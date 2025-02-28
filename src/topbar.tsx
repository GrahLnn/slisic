import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { Window } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
} from "react";

const appWindow = new Window("main");
const os = platform();

interface WindowsButtonProps extends PropsWithChildren {
  onClick?: () => void;
  className?: string;
  title?: string;
  color?: string;
  emphasizeColor?: string;
}

function WindowsButton({
  children,
  onClick,
  title,
  color,
  className,
  emphasizeColor,
}: WindowsButtonProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      onClick?.();
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "h-8 w-[46px] flex items-center justify-center",
        "opacity-60 hover:opacity-100",
        "transition-all",
        color
          ? "hover:bg-[var(--hover-bg-color)] hover:text-[var(--hover-text-color)]"
          : "hover:bg-black/5 dark:hover:bg-white/5",
        className
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
  );
}

function WindowsControls() {
  const [maximized, setMaximized] = useState(false);
  const getWindowState = useCallback(async () => {
    const isMaximized = await Window.getCurrent().isMaximized();
    setMaximized(isMaximized);
  }, []);

  useEffect(() => {
    getWindowState().catch(console.error);

    const unlisten = Window.getCurrent().onResized(() => {
      getWindowState().catch(console.error);
    });

    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [getWindowState]);

  return (
    <div className="flex items-center">
      <WindowsButton onClick={() => appWindow.minimize()}>
        <icons.minus size={14} />
      </WindowsButton>
      <WindowsButton onClick={() => appWindow.toggleMaximize()}>
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
      >
        <icons.xmark />
      </WindowsButton>
    </div>
  );
}

interface CtrlButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  o?: string;
  p?: string;
}

function CtrlButton({
  children,
  onClick = () => {},
  className,
  o,
  p,
}: CtrlButtonProps) {
  return (
    <div data-tauri-drag-region="false">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: <explanation> */}
      <div
        className={cn([
          "rounded-md cursor-default",
          p || "p-2",
          o || "opacity-60",
          "hover:bg-black/5 dark:hover:bg-white/5 hover:opacity-100 transition-all duration-300 ease-in-out",
          className,
        ])}
        onClick={onClick}
      >
        {children}
      </div>
    </div>
  );
}

function LeftControls() {
  return (
    <div className="flex items-center px-2">
      <img src="/tauri.svg" className="h-4 " alt="Tauri logo" />
    </div>
  );
}

function RightControls() {
  return (
    <div className="flex items-center">
      <CtrlButton>
        <icons.magnifler3 size={14} />
      </CtrlButton>
      <CtrlButton>
        <icons.globe3 size={14} />
      </CtrlButton>

      <CtrlButton>
        <icons.arrowDown size={14} />
      </CtrlButton>

      <WindowsControls />
    </div>
  );
}

function MiddleControls() {
  return (
    <div className={cn(["flex items-center h-full"])}>
      <CtrlButton>
        <icons.gridCircle size={14} />
      </CtrlButton>

      <CtrlButton className="text-xs font-light" o="opacity-80" p="py-2 px-5">
        <span>A useful app</span>
      </CtrlButton>
      <CtrlButton>
        <icons.sliders size={14} />
      </CtrlButton>
    </div>
  );
}

export default function TopBar() {
  const [windowFocused, setWindowFocused] = useState(true);

  useEffect(() => {
    const handleFocus = () => setWindowFocused(true);
    const handleBlur = () => setWindowFocused(false);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  return (
    <>
      {os === "windows" && (
        <header
          className={cn([
            "absolute top-0 left-0",
            "w-screen h-8 z-100 select-none",
            "before:absolute before:inset-0 before:-z-10",
            "before:bg-gradient-to-b before:from-[var(--app-bg)] before:to-[var(--app-bg)]/60",
            "after:absolute after:inset-0 after:-z-10",
            "after:backdrop-blur-[16px] after:opacity-100 after:origin-top",
            "after:bg-gradient-to-b after:from-transparent after:via-transparent after:to-white/0",
            "after:mask-image-[linear-gradient(to_bottom,rgba(0,0,0,1)_0%,rgba(0,0,0,0)_100%)]",
          ])}
          data-tauri-drag-region
        >
          <div
            className={cn([
              "grid grid-cols-[1fr_auto_1fr] w-full h-full",
              !windowFocused && "opacity-30",
              "transition-all duration-300",
            ])}
          >
            <div
              data-tauri-drag-region="false"
              className="flex justify-start pl-1"
            >
              <LeftControls />
            </div>
            <div data-tauri-drag-region="false">
              <MiddleControls />
            </div>
            <div data-tauri-drag-region="false" className="flex justify-end">
              <RightControls />
            </div>
          </div>
        </header>
      )}
    </>
  );
}
