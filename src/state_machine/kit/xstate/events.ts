import { assertEvent } from "xstate";
import { AnyEvt, WithPrefix } from "../core/types";
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

export type PayloadEvt<T extends readonly unknown[]> = T[number];

/* 事件值工厂 + 收集器（构造 readonly 元组，便于得到 union） */

type PayloadEvent = { type: string; output: unknown };
type PayloadMapFromUnion<U extends PayloadEvent> = {
  [K in U["type"] & string]: (
    payload: Extract<U, { type: K }>["output"]
  ) => Extract<U, { type: K }>;
};
type PayloadMap<E extends readonly PayloadEvent[]> = PayloadMapFromUnion<
  E[number]
>;

type EventOfType<U extends PayloadEvent, T extends U["type"]> = Extract<
  U,
  { type: T }
>;

export function event<T>() {
  return <const N extends string>(name: N) =>
    ({ type: name, output: undefined as T } as { type: N; output: T });
}

export function collect<const E extends readonly PayloadEvent[]>(...events: E) {
  // 把每个事件变成同名工厂方法，并合并为一个对象
  const methods = Object.assign(
    {},
    ...events.map((e) => ({
      [e.type]: (p: EventOfType<E[number], typeof e.type>["output"]) =>
        ({ type: e.type, output: p } as EventOfType<E[number], typeof e.type>),
    }))
  ) as PayloadMap<E>;

  return {
    ...methods,
    infer: events,
  } as typeof methods & { infer: E };
}
