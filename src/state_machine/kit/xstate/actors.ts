import { fromPromise } from "xstate";
import { AsyncFn, Awaited, WithPrefix, AnyEvt } from "../core/types";

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
