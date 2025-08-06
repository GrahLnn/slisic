import { assertEvent, fromPromise } from "xstate";

/* ---------- 公用类型 ---------- */
type StateMap<T extends readonly string[]> = { [K in T[number]]: K };

type SignalMap<T extends string> = Record<Lowercase<T>, { type: T; into(): T }>;

type ToSignal<T extends readonly string[]> = `to_${T[number]}`;

/* ---------- TransferMap 定义，带 pick 方法 ---------- */
type TransferBase<TState extends readonly string[]> = {
  [K in Lowercase<ToSignal<TState>>]: { target: TState[number] };
};

type TransferMap<TState extends readonly string[]> = TransferBase<TState> & {
  pick: <K extends keyof TransferBase<TState>>(
    ...keys: K[]
  ) => Pick<TransferBase<TState>, K>;
};

/* ---------- 总返回类型 ---------- */
type StateSignalResult<
  TState extends readonly string[],
  TSignal extends string
> = {
  State: StateMap<TState>;
  Signal: SignalMap<TSignal>;
  transfer: TransferMap<TState>;
};

/* ---------- Signal 构造器 ---------- */
function createSignal<T extends string>(name: T) {
  return { type: name, into: () => name };
}

/* ---------- 手动 version（保持接口统一，transfer 为空壳） ---------- */
export function createStateAndSignals<
  const TState extends readonly string[],
  TSignal extends string
>(cfg: {
  states: TState;
  signals: readonly TSignal[];
}): StateSignalResult<TState, TSignal> {
  /* State */
  const State = {} as StateMap<TState>;
  for (const s of cfg.states) (State as any)[s] = s;

  /* Signal */
  const Signal = {} as SignalMap<TSignal>;
  for (const sig of cfg.signals)
    Signal[sig.toLowerCase() as Lowercase<TSignal>] = createSignal(sig);

  /* transfer 空实现，但带 pick 方法，保证类型兼容 */
  const transfer = {
    pick: () => ({}),
  } as unknown as TransferMap<TState>;

  return { State, Signal, transfer };
}

/**
 * 构建类型安全的状态与信号对象工厂。
 *
 * 传入状态字符串数组（`states`），可选扩展信号（`extra_signals`），自动生成：
 * - `State`: 所有状态名到自身的映射（如 { idle: 'idle', loading: 'loading' }）。
 * - `Signal`: 所有信号名（含自动生成的 to_xxx 与 extra_signals）到信号对象的映射。
 * - `transfer`: 状态与信号的目标关系映射，并内置类型安全的 pick 方法，可按需筛选子集。
 *
 * 适用于需要自动生成状态机结构（如 UI 状态、流程驱动、信号控制流）的场景。
 *
 * @template TState 状态名字符串字面量数组类型
 * @template TExtra 可选扩展信号字符串字面量数组类型
 * @param {TState} states 所有状态名的只读字符串数组
 * @param {TExtra} [extra_signals] 额外自定义信号名（非自动生成）的只读字符串数组
 * @returns {{
 *   State: StateMap<TState>,
 *   Signal: SignalMap<ToSignal<TState> | TExtra[number]>,
 *   transfer: TransferMap<TState>
 * }}
 *
 * @example
 * const { State, Signal, transfer } = sst(
 *   ['idle', 'loading', 'done'],
 *   ['reset', 'force']
 * );
 * // State: { idle: 'idle', loading: 'loading', done: 'done' }
 * // Signal: { to_idle, to_loading, to_done, reset, force }
 * // transfer.pick(['to_idle', 'reset'])
 */
export function sst<
  const TState extends readonly string[],
  const TExtra extends readonly string[] = []
>(
  states: TState,
  extra_signals?: TExtra
): StateSignalResult<TState, ToSignal<TState> | TExtra[number]> {
  /* State */
  const State = {} as StateMap<TState>;
  for (const s of states) (State as any)[s] = s;

  /* Signal */
  const Signal = {} as SignalMap<ToSignal<TState> | TExtra[number]>;

  /* TransferBase 先构建键值对 */
  const transferBase = {} as TransferBase<TState>;
  for (const s of states) {
    const type = `to_${s}` as ToSignal<TState>;
    const key = type.toLowerCase() as Lowercase<ToSignal<TState>>;
    Signal[key] = createSignal(type);
    // 这里断言为 any，避免索引类型限制
    (transferBase as any)[key] = { target: s };
  }

  if (extra_signals) {
    for (const s of extra_signals) {
      const type = s as TExtra[number];
      const key = type.toLowerCase() as Lowercase<typeof type>;
      Signal[key] = createSignal(type);
      (transferBase as any)[key] = { target: s };
    }
  }

  /* pick 柯里化 */
  function pick<K extends keyof typeof transferBase>(
    ...keys: K[]
  ): Pick<typeof transferBase, K> {
    const arr = (Array.isArray(keys) ? keys : [keys]) as readonly K[];
    return Object.fromEntries(arr.map((k) => [k, transferBase[k]])) as Pick<
      typeof transferBase,
      K
    >;
  }

  /* 合并 pick 方法到最终对象 */
  const transfer = Object.assign(transferBase, { pick }) as TransferMap<TState>;

  return { State, Signal, transfer };
}

export type ValueOf<T> = T[keyof T];

export type AsyncFn = (...a: any[]) => Promise<any>;

type Decorated<K extends string, F extends AsyncFn> = ReturnType<
  typeof fromPromise<F>
> & {
  /** 仅类型标记，运行时存 undefined 即可 */
  __src__: F;
  /** 供配置处 `...actors.xxx.send()` 使用 */
  send(): { [P in K]: Decorated<K, F> };
  evt(): WithPrefix<K>;
  name: K;
};

/* ---------- 把一组异步函数包装成 actors ---------- */
export function createActors<A extends Record<string, AsyncFn>>(defs: A) {
  type Keys = keyof A & string;
  type SendMap = {
    [K in Keys]: Decorated<K, A[K]>;
  };

  const out = {} as { [K in Keys]: Decorated<K, A[K]> } & {
    send_all(): SendMap;
  };

  for (const k in defs) {
    const builder = fromPromise(defs[k]);
    const decorated = builder as Decorated<typeof k, (typeof defs)[typeof k]>;

    // 运行时挂 send；类型上已具备 __src__
    decorated.send = () => ({ [k]: decorated } as any);
    (decorated as any).__src__ = defs[k]; // 运行时可写成 undefined
    decorated.evt = () => invokeEvt(k);
    decorated.name = k;

    out[k] = decorated as any;
  }
  out.send_all = () => {
    const merged = {} as SendMap;
    for (const k in out) {
      if (k === "send_all") continue; // 跳过自身
      Object.assign(merged, (out as any)[k].send());
    }
    return merged;
  };

  return out;
}

/* Awaited 工具 */
type Awaited<T> = T extends Promise<infer R> ? R : T;

/* 提取 “原始异步函数” —— 两种情况都兼容 */
type SrcOf<T> =
  /* a. 自带 __src__（createActors 生成的） */
  T extends { __src__: (...a: any) => Promise<any> }
    ? T["__src__"]
    : /* b. 直接就是函数 */
    T extends (...a: any) => Promise<any>
    ? T
    : never;

/* 生成   { type: `xstate.done.actor.${K}`, output: R } */
export type DoneEvt<K extends string, R> = {
  type: K;
  output: R;
};

export type DoneEventOf<Fn extends AsyncFn, Name extends string> = {
  type: Name;
  output: Awaited<ReturnType<Fn>>;
};

/* 核心：把一组异步函数映射成 done-event 联合  */
export type DoneEvents<A extends Record<string, any>> = {
  [K in keyof A]: SrcOf<A[K]> extends (...a: any) => Promise<infer R>
    ? DoneEvt<K & string, R>
    : never;
}[keyof A];

/** 任意事件联合 */
export type AnyEvt = { type: string };

/**
 * 生成 Extract<E, {type:T}> 这种精确事件类型
 */
export type EvtOf<E extends AnyEvt, T extends E["type"]> = Extract<
  E,
  { type: T }
>;

type DoneEvtFor<E extends AnyEvt, K extends string> = Extract<
  E,
  { type: K } & { output: unknown }
>;

type WithPrefix<S extends string> = `xstate.done.actor.${S}`;

type PathValue<T, P extends readonly string[]> = P extends [
  infer H,
  ...infer Rest
]
  ? H extends keyof T
    ? Rest extends string[]
      ? PathValue<T[H], Rest>
      : never
    : never
  : T;

type DoneKeys<E extends AnyEvt> = E extends { type: infer T; output: any }
  ? T & string
  : never;

/** 同时兼容 K 和 WithPrefix<K> 的 output 提取 */
type OutputOf<E extends AnyEvt, K extends string> =
  | Extract<E, { type: K } & { output: unknown }>["output"]
  | Extract<E, { type: WithPrefix<K> } & { output: unknown }>["output"];

/** 同时兼容 K 和 WithPrefix<K> 的事件本体提取 */
type EvtForKey<E extends AnyEvt, K extends string> = Extract<
  E,
  { type: K } | { type: WithPrefix<K> }
>;

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

  function take() {}

  return { whenDone, take };
}

export function invokeEvt<S extends string>(id: S): WithPrefix<S> {
  return `xstate.done.actor.${id}`;
}

export function godown(state: string) {
  return `.${state}`;
}

export function goto(state: string) {
  return `#${state}`;
}

type InvokeForm<
  K extends string,
  S extends string,
  A extends string | readonly string[] | undefined = undefined
> = {
  [P in K]: {
    readonly initial: "do";
    readonly states: {
      readonly do: {
        readonly invoke: {
          readonly id: S;
          readonly src: S;
          readonly onDone: {
            readonly target: "done";
            readonly actions: A;
          };
        };
      };
      readonly done: { readonly type: "final" };
    };
  };
};

export function invokeState<
  K extends string,
  S extends string,
  A extends string | readonly string[] | undefined = undefined
>(key: K, src: S, actions?: A): InvokeForm<K, S, A> {
  return {
    [key]: {
      initial: "do",
      states: {
        do: {
          invoke: {
            id: src,
            src,
            onDone: {
              target: "done",
              actions,
            },
          },
        },
        done: { type: "final" },
      },
    },
  } as InvokeForm<K, S, A>;
}
export interface ActorInput<T> {
  input: T;
}
