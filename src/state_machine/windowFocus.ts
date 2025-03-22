import { useSelector } from "@xstate/react";
import { createActor, createMachine, fromCallback } from "xstate";
import { createStateAndSignals } from "./core";

const { State, Signal } = createStateAndSignals({
  states: ["focused", "blurred"],
  signals: ["FOCUS", "BLUR"],
});

export const windowFocusMachine = createMachine({
  /**
   * 这里不需要复杂的上下文，就简单用两个状态表示
   * "focused" 与 "blurred"。
   */
  id: "windowFocus",
  initial: State.focused,
  states: {
    [State.focused]: {
      on: {
        [Signal.blur.into()]: {
          target: State.blurred,
        },
      },
    },
    [State.blurred]: {
      on: {
        [Signal.focus.into()]: {
          target: State.focused,
        },
      },
    },
  },

  /**
   * invoke 内使用 fromCallback 来监听 window focus/blur 事件
   */
  invoke: {
    src: fromCallback(({ sendBack }) => {
      // 事件回调
      function handleFocus() {
        sendBack(Signal.focus);
      }
      function handleBlur() {
        sendBack(Signal.blur);
      }

      // 组件或应用加载后，添加事件监听
      window.addEventListener("focus", handleFocus);
      window.addEventListener("blur", handleBlur);

      // 卸载清理函数
      return () => {
        window.removeEventListener("focus", handleFocus);
        window.removeEventListener("blur", handleBlur);
      };
    }),
  },
});

// 创建一个单例actor，以便在整个应用中共享状态
const windowFocusActor = createActor(windowFocusMachine);
// 启动actor
windowFocusActor.start();

/**
 * 获取窗口焦点状态
 * @returns 当前窗口是否处于焦点状态
 */
export function isWindowFocus(): boolean {
  return useSelector(windowFocusActor, (machineState) =>
    machineState.matches(State.focused)
  );
}


