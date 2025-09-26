import {
  assertEvent,
  InputFrom,
  ActorRefFrom,
  type AnyEventObject,
  type MachineContext,
  type AssignArgs,
  type ProvidedActor,
  type AnyActorLogic,
  Spawner,
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
    evt: K;
  };
};
type PayloadMap<E extends readonly PayloadEvent[]> = PayloadMapFromUnion<
  E[number]
>;

/** 把 machine-事件联合变为「以去前缀键为名」的字典：含 evt/id/machine */
type MachineMapFromUnion<U extends MachineEvent<any>> = {
  [K in U["type"] & WithPrefix<string> as StripPrefix<K>]: {
    /** 完整事件名（含前缀） */
    evt: K;
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
// export function event<T>() {
//   return <const N extends string>(name: N) =>
//     ({ __kind: "payload", type: name, output: undefined as T } as const);
// }

export function event<T>() {
  return <const N extends readonly string[]>(...names: N) =>
    names.map((name) => ({
      __kind: "payload" as const,
      type: name,
      output: undefined as T,
    })) as {
      readonly [K in keyof N]: {
        readonly __kind: "payload";
        readonly type: N[K];
        readonly output: T;
      };
    };
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
type SendAllDict<E extends readonly MachineEvent<any>[]> = {
  [K in keyof MachineMap<E> & string]: MachineMap<E>[K] extends {
    machine: infer L;
  }
    ? L
    : never;
};
/* -------------------------------------------------------
 * 类型工具：拍扁一层嵌套的 tuple，并在 tuple 上做过滤
 * -----------------------------------------------------*/
type Flatten1<A extends readonly unknown[]> = A extends readonly [
  infer H,
  ...infer R
]
  ? H extends readonly unknown[]
    ? [...H, ...Flatten1<R>]
    : [H, ...Flatten1<R>]
  : [];

type FilterTuple<T extends readonly unknown[], Pred> = T extends readonly [
  infer H,
  ...infer R
]
  ? H extends Pred
    ? [H, ...FilterTuple<R, Pred>]
    : [...FilterTuple<R, Pred>]
  : [];

/* -------------------------------------------------------
 * 统一重载：接受“混合 + 可嵌套数组”的任何组合
 *   - A 为原始参数 tuple
 *   - F = Flatten1<A> 为拍扁后的 tuple（仍保留字面量顺序）
 *   - FP / FM 分别为仅 payload / machine 的子 tuple
 * -----------------------------------------------------*/
export function collect<
  const A extends readonly (
    | PayloadEvent
    | MachineEvent<any>
    | readonly (PayloadEvent | MachineEvent<any>)[]
  )[],
  const F extends readonly (PayloadEvent | MachineEvent<any>)[] = Flatten1<A>,
  const FP extends readonly PayloadEvent[] = FilterTuple<F, PayloadEvent>,
  const FM extends readonly MachineEvent<any>[] = FilterTuple<
    F,
    MachineEvent<any>
  >
>(
  ...args: A
): PayloadMap<FP> &
  MachineMap<FM> & {
    infer: F;
  } & (FM extends readonly [] ? {} : { as_act: () => SendAllDict<FM> });

/* -------------------------------------------------------
 * 实现签名（保持与之前一致，但把参数也写成“可夹杂数组”）
 * -----------------------------------------------------*/
export function collect(
  ...args: readonly (
    | PayloadEvent
    | MachineEvent<any>
    | readonly (PayloadEvent | MachineEvent<any>)[]
  )[]
) {
  // 运行时拍扁一层（与类型层面的 Flatten1 对齐）
  const events: readonly (PayloadEvent | MachineEvent<any>)[] = args.flatMap(
    (a) => (Array.isArray(a) ? (a as any) : [a as any])
  );

  const methods = Object.assign(
    {},
    ...events.map((e) => {
      if ((e as any).__kind === "machine") {
        const t = (e as any).type as string;
        const key = t.startsWith(DONE_PREFIX) ? t.slice(DONE_PREFIX.length) : t;
        return {
          [key]: { evt: t, id: key, machine: (e as any).machine },
        };
      }
      return {
        [(e as any).type]: {
          load: (p: any) => ({ type: (e as any).type, output: p }),
          evt: (e as any).type,
        },
      };
    })
  );

  const machineEntries = events.flatMap((e) => {
    if ((e as any).__kind !== "machine") return [];
    const t = (e as any).type as string;
    const id = t.startsWith(DONE_PREFIX) ? t.slice(DONE_PREFIX.length) : t;
    const logic = (e as any).machine;
    return [[id, logic] as const];
  });

  const as_act = () => Object.fromEntries(machineEntries);

  return { ...(methods as any), infer: events as any, as_act };
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
  type KeyLike = DoneKeys<TEvents> | `${Prefix}${DoneKeys<TEvents>}`;
  function take(): <R>(
    fn: (ctx: TContext) => R
  ) => (args: ActionArgs<TContext, any, any>) => R;
  function take<S extends KeyLike>(
    key?: S
  ): <R>(
    fn: (
      out: OutputOf<TEvents, NormalizeKey<S>>,
      ctx: TContext,
      evt: EvtForKey<TEvents, NormalizeKey<S>>
    ) => R
  ) => (args: ActionArgs<TContext, TEvents, TEvents>) => R;

  function take(key?: string) {
    return key
      ? (fn: any) => (args: any) => {
          const { context, event } = args;
          assertEvent(event, key);
          return fn((event as any).output, context as TContext, event as any);
        }
      : (fn: any) => (args: any) => {
          const { context } = args;
          return fn(context as TContext);
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
