import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { Window } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState,
} from "react";

const appWindow = new Window("main");
const os = platform();

interface TopBarButtonProps extends PropsWithChildren {
  onClick?: () => void;
  className?: string;
  title?: string;
  color?: string;
  emphasizeColor?: string;
}

function TopBarButton({
  children,
  onClick,
  title,
  color,
  className,
  emphasizeColor,
}: TopBarButtonProps) {
  const handleKeyDown = (event: React.KeyboardEvent) => {
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
        "opacity-30 hover:opacity-100",
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
      <TopBarButton onClick={() => appWindow.minimize()}>
        {icons.minus({ size: 14 })}
      </TopBarButton>
      <TopBarButton onClick={() => appWindow.toggleMaximize()}>
        {maximized
          ? icons.stacksquare({ size: 14 })
          : icons.square({ size: 14 })}
      </TopBarButton>
      <TopBarButton
        onClick={() => appWindow.close()}
        color="#e81123"
        className="pr-0.5"
        emphasizeColor="#f0f0f0"
      >
        {icons.xmark({})}
      </TopBarButton>
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
      <WindowsControls />
    </div>
  );
}

export default function TopBar() {
  return (
    <>
      {os === "windows" && (
        <div
          className="flex justify-between w-screen h-8"
          data-tauri-drag-region
        >
          <LeftControls />
          <RightControls />
        </div>
      )}
    </>
  );
}
