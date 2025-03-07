import { useSelector } from "@xstate/react";
import {
  type AnyActorLogic,
  createActor,
  createMachine,
  fromCallback,
} from "xstate";

export const windowFocusMachine: AnyActorLogic = createMachine({
  /**
   * 这里不需要复杂的上下文，就简单用两个状态表示
   * "focused" 与 "blurred"。
   */
  id: "windowFocus",
  initial: "focused",
  states: {
    focused: {
      on: {
        BLUR: {
          target: "blurred",
        },
      },
    },
    blurred: {
      on: {
        FOCUS: {
          target: "focused",
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
        sendBack({ type: "FOCUS" });
      }
      function handleBlur() {
        sendBack({ type: "BLUR" });
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
 * 自定义Hook，用于获取窗口焦点状态
 * @returns 当前窗口是否处于焦点状态
 */
export function useWindowFocus(): boolean {
  // 使用useSelector从状态机中获取当前状态
  const isFocused = useSelector(windowFocusActor, (state) =>
    state.matches("focused")
  );

  return isFocused;
}
