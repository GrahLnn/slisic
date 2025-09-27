import { fromPromise } from "xstate";
import { AsyncFn, Awaited, WithPrefix, AnyEvt, Signal } from "../core/types";

/* 装饰后的 actor 构造器类型 */
export type Decorated<K extends string, F extends AsyncFn> = ReturnType<
  typeof fromPromise<F>
> & {
  __src__: F; // 仅类型标记；运行时可写为 undefined
  send(): { [P in K]: Decorated<K, F> };
  evt: WithPrefix<K>;
  name: K;
};

/* a) 从装饰类型里取原函数；b) 直接就是函数 */
type SrcOf<T> = T extends { __src__: (...a: any) => Promise<any> }
  ? T["__src__"]
  : T extends (...a: any) => Promise<any>
  ? T
  : never;

/* 生成 done 事件类型 */
export type DoneEvt<K extends string, R> = { type: K; output: R };
export type DoneEventOf<Fn extends AsyncFn, Name extends string> = {
  type: Name;
  output: Awaited<ReturnType<Fn>>;
};

/* 将一堆 actor 映射成 done-event 联合 */
export type InvokeEvt<A extends Record<string, any>> = {
  [K in keyof A]: SrcOf<A[K]> extends (...a: any) => Promise<infer R>
    ? DoneEvt<K & string, R>
    : never;
}[keyof A];

export type DoneKeys<E extends AnyEvt> = E extends {
  type: infer T;
  output: any;
}
  ? T & string
  : never;

export type OutputOf<E extends AnyEvt, K extends string> =
  | Extract<E, { type: K } & { output: unknown }>["output"]
  | Extract<E, { type: WithPrefix<K> } & { output: unknown }>["output"];

export type EvtForKey<E extends AnyEvt, K extends string> = Extract<
  E,
  { type: K } | { type: WithPrefix<K> }
>;

/* 核心：把一组异步函数包装成 actors */
export function createActors<A extends Record<string, AsyncFn>>(defs: A) {
  type Keys = keyof A & string;
  type SendMap = { [K in Keys]: Decorated<K, A[K]> };

  const out = {} as { [K in Keys]: Decorated<K, A[K]> } & {
    as_act(): SendMap;
  };

  for (const k in defs) {
    const builder = fromPromise(defs[k]);
    const decorated = builder as Decorated<typeof k, (typeof defs)[typeof k]>;

    decorated.send = () => ({ [k]: decorated } as any);
    (decorated as any).__src__ = defs[k];
    decorated.evt = `xstate.done.actor.${k}` as const;
    decorated.name = k;

    out[k] = decorated as any;
  }

  out.as_act = () => {
    const merged = {} as SendMap;
    for (const k in defs) {
      merged[k as Keys] = out[k as Keys];
    }
    return merged;
  };

  return out;
}

export function createSender<A extends { send: (evt: any) => any }>(actor: A) {
  // 机器事件联合与其 type 联合
  type AppEvent = Parameters<A["send"]>[0];
  type AppEventType = AppEvent extends { type: infer T }
    ? Extract<T, string>
    : never;

  // 仅 {type} 事件的 type 联合（无 payload）
  type HasOnlyType<E> = E extends { type: any }
    ? Exclude<keyof E, "type"> extends never
      ? true
      : false
    : false;
  type SimpleEventType = AppEvent extends infer E
    ? E extends { type: infer T }
      ? HasOnlyType<E> extends true
        ? Extract<T, string>
        : never
      : never
    : never;

  // 规范化：Signal/SignalLike -> AppEvent
  function normalizeToEvent(x: AppEvent | Signal<AppEventType>): AppEvent {
    const o = x as any;
    if (
      o &&
      typeof o === "object" &&
      "type" in o &&
      typeof o.type === "string"
    ) {
      return "evt" in o && o.evt === o.type
        ? ({ type: o.type } as AppEvent)
        : (o as AppEvent);
    }
    return x as AppEvent;
  }

  // 发送器：既可发完整机器事件，也可发纯信号
  function send<E extends AppEvent>(evt: E): void;
  function send<T extends AppEventType>(sig: Signal<T>): void;
  function send(x: any): void {
    actor.send(normalizeToEvent(x));
  }

  // 仅允许“无 payload”的信号
  const sendSig = <T extends SimpleEventType>(s: Signal<T>) =>
    actor.send({ type: s.type } as AppEvent);

  // 仅发送完整机器事件（显式）
  const sendEvent = <E extends AppEvent>(e: E) => actor.send(e);

  return send;
}
