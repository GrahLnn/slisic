import { assertEvent } from "xstate";
import { AnyEvt, WithPrefix, EvtOf, PathValue } from "../core/types"; // EvtOf/PathValue 若外部也需要可从 index.ts 再导出
import { DoneKeys, OutputOf, EvtForKey } from "./actors";

/* 事件工具：在 whenDone 中做精确断言并解包 output */
export function eventHandler<AllEvents extends AnyEvt>() {
  function whenDone<K extends DoneKeys<AllEvents>>(key: K | WithPrefix<K>) {
    return function <R, A extends { context: any; event: AllEvents }>(
      fn: (
        output: OutputOf<AllEvents, K>,
        ctx: A["context"],
        evt: EvtForKey<AllEvents, K>
      ) => R
    ) {
      return ({ context, event }: A) => {
        assertEvent(event, key);
        return fn((event as any).output, context, event as any);
      };
    };
  }

  function take() {
    /* 预留 */
  }

  return { whenDone, take };
}

/* 事件值工厂 + 收集器（构造 readonly 元组，便于得到 union） */
export function event<T, const N extends string = string>(
  name: N
): { type: N; output: T } {
  return { type: name, output: undefined as T };
}

export type PayloadEvent = { type: string; output: unknown };

export function collect<const E extends readonly PayloadEvent[]>(...events: E) {
  return events;
}

export type EventsFrom<T extends readonly unknown[]> = T[number];

// 透出少量实用类型（可选）
export type { EvtOf, PathValue };
