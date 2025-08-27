import {
  assertEvent,
  InputFrom,
  ActorRefFrom,
  type AnyEventObject,
  type MachineContext,
  type AssignArgs,
  type ProvidedActor,
  type AnyActorLogic,
  ActionArgs,
} from "xstate";
import { WithPrefix, StripPrefix, type Prefix } from "../core/types";
import { DoneKeys, OutputOf, EvtForKey } from "./actors";

/* -----------------------------------------------------------------------------
 * 0) 前置常量 & 工具类型
 * ---------------------------------------------------------------------------*/

/** XState done-actor 事件的标准前缀 */
const DONE_PREFIX: Prefix = "xstate.done.actor.";

/** 归一化键：把可能带前缀的 key 还原成裸键（仅用于类型层面） */
type NormalizeKey<S> = S extends `${Prefix}${infer K}` ? K : S;

/** 如果形参语义上允许 undefined，则放宽为 T | undefined；否则保持 T */
type MaybeOptional<T> = undefined extends T ? T | undefined : T;

/** child 启动器（把 spawn 收敛后暴露一个固定签名） */
type MachineEntry<L extends AnyActorLogic = AnyActorLogic> = {
  id: string;
  machine: L;
};

// 改写 BoundChild：吃一个 MachineEntry，而不是 (logic, id)
export type BoundChild = <L extends AnyActorLogic>(
  mc: MachineEntry<L>
) => (input: MaybeOptional<InputFrom<L>>) => ActorRefFrom<L>;

/* -----------------------------------------------------------------------------
 * 1) 事件建模类型（payload/machine 两类）
 * ---------------------------------------------------------------------------*/

export type PayloadEvent = {
  readonly __kind: "payload";
  type: string;
  output: unknown;
};

export type MachineEvent<L = unknown> = {
  readonly __kind: "machine";
  type: WithPrefix<string>; // e.g. "xstate.done.actor.foo"
  machine: L;
  output: unknown;
};

type MachineOf<T> = T extends MachineEvent<infer L> ? L : never;

/** 把 payload-事件联合变为「按 type 分类」的工厂与工具 */
type PayloadMapFromUnion<U extends PayloadEvent> = {
  [K in U["type"] & string]: {
    /** 生成该事件的值（确保 output 的类型精确） */
    load: (
      payload: Extract<U, { type: K }>["output"]
    ) => Extract<U, { type: K }>;
    /** 仅获取事件名（便于在 switch / on: {...} 中复用） */
    evt: () => K;
  };
};
type PayloadMap<E extends readonly PayloadEvent[]> = PayloadMapFromUnion<
  E[number]
>;

/** 把 machine-事件联合变为「以去前缀键为名」的字典：含 evt/id/machine */
type MachineMapFromUnion<U extends MachineEvent<any>> = {
  [K in U["type"] & WithPrefix<string> as StripPrefix<K>]: {
    /** 完整事件名（含前缀） */
    evt: () => K;
    /** 去前缀后的 id，便于在 XState 内部作为 actorId 使用 */
    id: StripPrefix<K>;
    /** 该分支对应的机器逻辑 L（精确拿回） */
    machine: MachineOf<Extract<U, { type: K }>>;
  };
};
type MachineMap<E extends readonly MachineEvent<any>[]> = MachineMapFromUnion<
  E[number]
>;

/* -----------------------------------------------------------------------------
 * 2) 工厂函数（payload / machine）
 * ---------------------------------------------------------------------------*/

/** 构造一个 payload 事件“原型”（随后交给 collect 形成工厂） */
export function event<T>() {
  return <const N extends string>(name: N) =>
    ({ __kind: "payload", type: name, output: undefined as T } as const);
}

/** 构造一个 machine-done 事件“原型”（随后交给 collect 形成工厂） */
export function machine<O, L extends AnyActorLogic = AnyActorLogic>(
  machine: L
) {
  return <const N extends string>(name: N) =>
    ({
      __kind: "machine",
      type: `${DONE_PREFIX}${name}`,
      machine,
      output: undefined as O,
    } as const);
}

/* -----------------------------------------------------------------------------
 * 3) 事件收集器（把 readonly 元组转成“键到工厂/工具”的对象）
 * ---------------------------------------------------------------------------*/

export function collect<const E extends readonly PayloadEvent[]>(
  ...events: E
): PayloadMap<E> & { infer: E };
export function collect<
  const E extends readonly ME[],
  ME extends MachineEvent<any>
>(...events: E): MachineMap<E> & { infer: E };

/** 实现：根据 __kind 分支构造不同的字典 */
export function collect(
  ...events: readonly (PayloadEvent | MachineEvent<any>)[]
) {
  const methods = Object.assign(
    {},
    ...events.map((e) => {
      if (e.__kind === "machine") {
        // machine 事件：把 "xstate.done.actor.xxx" → "xxx" 作为键暴露
        const key = (e.type as string).slice(DONE_PREFIX.length);
        return { [key]: { evt: () => e.type, id: key, machine: e.machine } };
      }
      // payload 事件：暴露 load 工厂与事件名
      return {
        [e.type]: {
          load: (p: any) => ({ type: e.type, output: p }),
          evt: () => e.type,
        },
      };
    })
  );
  return { ...(methods as any), infer: events as any };
}

/* -----------------------------------------------------------------------------
 * 4) whenDone 助手（支持裸键/带前缀键；带强类型推断）
 * ---------------------------------------------------------------------------*/

/**
 * 用法：
 * const { whenDone } = eventHandler<Ctx, Events>();
 * onDone: {
 *   actions: assign({
 *     result: whenDone("childId")((out, ctx, evt, child) => { ... })
 *     // 也可以 whenDone("xstate.done.actor.childId")
 *   })
 * }
 */
export function eventHandler<
  TContext extends MachineContext,
  TEvents extends AnyEventObject,
  TActor extends ProvidedActor = ProvidedActor
>() {
  // 类型友好的重载：S 可为裸键或带前缀键
  function whenDone<
    S extends DoneKeys<TEvents> | `${Prefix}${DoneKeys<TEvents>}`
  >(
    key: S
  ): <R>(
    fn: (
      out: OutputOf<TEvents, NormalizeKey<S>>,
      ctx: TContext,
      evt: EvtForKey<TEvents, NormalizeKey<S>>,
      sp: BoundChild
      //   spawn: Spawner<TActor>
    ) => R
  ) => (args: AssignArgs<TContext, TEvents, TEvents, TActor>) => R;

  function whenDone(key: string) {
    return (fn: any) =>
      (args: AssignArgs<TContext, TEvents, TEvents, TActor>) => {
        const { context, event, spawn } = args;

        // 收敛 XState 的 spawn（避免处处重复泛型与可选项声明）
        type SpawnFn = <L extends AnyActorLogic>(
          src: L,
          options?: {
            id?: string;
            systemId?: string;
            input?: InputFrom<L>;
            syncSnapshot?: boolean;
          }
        ) => ActorRefFrom<L>;
        const doSpawn = spawn as unknown as SpawnFn;

        const sp = (<L extends AnyActorLogic>(mc: MachineEntry<L>) =>
          (input: MaybeOptional<InputFrom<L>>): ActorRefFrom<L> =>
            doSpawn(mc.machine, {
              id: mc.id,
              /** 当前传入的input并不会到machine里去做验证，所以这里不再报错，手工保证合法性，除非machine调用给出了泛型typeof mc.machine */
              input: input as InputFrom<L>,
            })) as BoundChild;

        assertEvent(event, key);
        return fn((event as any).output, context, event as any, sp);
      };
  }

  function take<S extends DoneKeys<TEvents> | `${Prefix}${DoneKeys<TEvents>}`>(
    key: S
  ): <R>(
    fn: (ctx: TContext, evt: EvtForKey<TEvents, NormalizeKey<S>>) => R
  ) => (args: ActionArgs<TContext, TEvents, TEvents>) => R;

  function take(key: string) {
    return (fn: any) => (args: any) => {
      const { context, event } = args;
      assertEvent(event, key);
      return fn(context as TContext, event as any);
    };
  }

  return { whenDone, take };
}

/* -----------------------------------------------------------------------------
 * 5) 杂项工具
 * ---------------------------------------------------------------------------*/

/** 兜底转字符串（Error 优先 → string → JSON.stringify → String） */
export function to_string(e: unknown): string {
  return e instanceof Error
    ? e.message
    : typeof e === "string"
    ? e
    : (() => {
        try {
          return JSON.stringify(e);
        } catch {
          return String(e);
        }
      })();
}
