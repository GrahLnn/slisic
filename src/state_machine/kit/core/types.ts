/* ---------- 公用类型（仅类型，不含实现） ---------- */

/** 状态名映射：{ idle: "idle", ... } */
export type StateMap<T extends readonly string[]> = { [K in T[number]]: K };

/** 信号名映射（小写键）：{ to_idle: {type:"to_idle", into(): "to_idle"} } */
export type SignalMap<T extends string> = Record<
  Lowercase<T>,
  { type: T; into(): T }
>;

/** 自动生成的跳转信号名： "to_idle" | "to_loading" ... */
export type ToSignal<T extends readonly string[]> = `to_${T[number]}`;

/** 仅基于状态自动生成的 transfer 键集合（运行时可扩，类型上保持保守） */
export type TransferBase<TState extends readonly string[]> = {
  [K in Lowercase<ToSignal<TState>>]: { target: TState[number] };
};

export type TransferMap<TState extends readonly string[]> =
  TransferBase<TState> & {
    pick: <K extends keyof TransferBase<TState>>(
      ...keys: K[]
    ) => Pick<TransferBase<TState>, K>;
  };

export type StateSignalResult<
  TState extends readonly string[],
  TSignal extends string
> = {
  State: StateMap<TState>;
  Signal: SignalMap<TSignal>;
  transfer: TransferMap<TState>;
};

/* ---------- 杂项工具类型 ---------- */
export type ValueOf<T> = T[keyof T];
export type AsyncFn = (...a: any[]) => Promise<any>;
export type Awaited<T> = T extends Promise<infer R> ? R : T;

export type AnyEvt = { type: string };
export type WithPrefix<S extends string> = `xstate.done.actor.${S}`;

export type PathValue<T, P extends readonly string[]> = P extends [
  infer H,
  ...infer Rest
]
  ? H extends keyof T
    ? Rest extends string[]
      ? PathValue<T[H], Rest>
      : never
    : never
  : T;

/* 事件工具：抽取匹配 type 的事件 */
export type EvtOf<E extends AnyEvt, T extends E["type"]> = Extract<
  E,
  { type: T }
>;
