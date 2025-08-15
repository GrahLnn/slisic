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

export type ElemNoSpaceTuple<T extends readonly string[]> = {
  [K in keyof T]: T[K] extends string ? NoSpace<T[K]> : T[K];
};
type NoSpace<S extends string> = S extends `${string} ${string}`
  ? "States containing spaces are not accepted."
  : S;

export type SignalEvt<T, Key extends PropertyKey = "Signal"> = ValueOf<{
  [P in keyof T]: T[P] extends Record<Key, infer S>
    ? S extends Record<PropertyKey, any>
      ? ValueOf<S>
      : S
    : never;
}>;

// ===== 基础：Union -> Intersection / Last / Union -> Tuple =====
type UnionToIntersection<U> = (
  U extends unknown ? (arg: U) => 0 : never
) extends (arg: infer I) => 0
  ? I
  : never;

type LastInUnion<U> = UnionToIntersection<
  U extends unknown ? (x: U) => 0 : never
> extends (x: infer L) => 0
  ? L
  : never;

type UnionToTuple<U, Last = LastInUnion<U>> = [U] extends [never]
  ? []
  : [...UnionToTuple<Exclude<U, Last>>, Last];

// ===== 小工具：相等 / 包含 / 求元组中重复 =====
type IsEqual<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y
  ? 1
  : 2
  ? true
  : false;

type Includes<T extends readonly any[], U> = T extends readonly [
  infer H,
  ...infer R
]
  ? IsEqual<H, U> extends true
    ? true
    : Includes<R, U>
  : false;

type Duplicates<
  T extends readonly any[],
  Seen extends readonly any[] = [],
  Out extends readonly any[] = []
> = T extends readonly [infer H, ...infer R]
  ? Includes<Seen, H> extends true
    ? Duplicates<R, Seen, Includes<Out, H> extends true ? Out : [...Out, H]>
    : Duplicates<R, [...Seen, H], Out>
  : Out;

// ===== 关键修复：按 `type` 展开联合（Normalize）=====
type NormalizeByType<U extends { type: PropertyKey }> = U extends any
  ? U["type"] extends infer T
    ? T extends PropertyKey
      ? Omit<U, "type"> & { type: T } // 把 {type: A|B} 展成 {type:A}|{type:B}
      : never
    : never
  : never;

// 把“事件元组”映射为其 type 元组（保留重复）
type TypesOfTuple<T extends readonly any[]> = T extends readonly [
  infer H,
  ...infer R
]
  ? [H extends { type: infer K } ? K : never, ...TypesOfTuple<R>]
  : [];

// 检出重复的 type（返回一个不含重复元素的列表；无重复则 []）
type DuplicateTypeList<U extends { type: PropertyKey }> = Duplicates<
  TypesOfTuple<UnionToTuple<NormalizeByType<U>>>
>;

// ===== 宽类型判定（不仅仅是 string 本身，也覆盖“广义 string”）=====
type IsBroadString<K> = K extends string
  ? string extends K
    ? true
    : false
  : false;
type IsBroadNumber<K> = K extends number
  ? number extends K
    ? true
    : false
  : false;
type IsBroadSymbol<K> = K extends symbol
  ? symbol extends K
    ? true
    : false
  : false;

type BroadKinds<U extends { type: PropertyKey }> = U extends { type: infer K }
  ? IsBroadString<K> extends true
    ? "string"
    : IsBroadNumber<K> extends true
    ? "number"
    : IsBroadSymbol<K> extends true
    ? "symbol"
    : never
  : never;

// ===== 对外接口：若重复或含宽类型，给出清晰错误；否则原样返回 =====
export type UniqueEvts<U extends { type: PropertyKey }> = [
  DuplicateTypeList<U>
] extends [[]]
  ? [BroadKinds<NormalizeByType<U>>] extends [never]
    ? U
    : { __ERROR_NON_LITERAL_EVENT_TYPES: BroadKinds<NormalizeByType<U>> }
  : {
      __ERROR_DUPLICATE_EVENT_TYPES: DuplicateTypeList<U>;
      __ERROR_NON_LITERAL_EVENT_TYPES: BroadKinds<NormalizeByType<U>>; // 可能为 never
    };

// ====== 手动测试用例 ======

// 1) ✅ 无重复，全部字面量
type E_OK =
  | { type: "a"; output: number }
  | { type: "b"; output: string }
  | { type: "c"; output: boolean };

type Check_OK = UniqueEvts<E_OK>; // 应该就是 E_OK 本身
const T_OK: DuplicateTypeList<E_OK> extends [] ? true : never = true; // ✅ 通过

// 2) ❌ 有重复：'a' 出现两次
type E_DUP =
  | { type: "a"; output: number }
  | { type: "a"; output: string }
  | { type: "b"; output: boolean };

// @ts-expect-error 重复的 type 应报错
type Check_DUP = UniqueEvts<E_DUP>;
/* 也可用断言触发报错： */
// @ts-expect-error DuplicateTypeList 应非空
const T_DUP: DuplicateTypeList<E_DUP> extends [] ? true : never = true;

// 3) ❌ 非字面量：包含 type: string
type E_BROAD =
  | { type: string; output: number }
  | { type: "b"; output: boolean };

// @ts-expect-error 非字面量 type 应报错（__ERROR_NON_LITERAL_EVENT_TYPES: 'string'）
type Check_BROAD = UniqueEvts<E_BROAD>;
// @ts-expect-error BroadTypes 应为 'string' 而非 never
const T_BROAD: [BroadTypes<E_BROAD>] extends [never] ? true : never = true;

// 4) ❌ 既有重复又有非字面量
type E_MIXED =
  | { type: "x"; output: 1 }
  | { type: "x"; output: 2 } // 重复
  | { type: number; output: 3 } // 非字面量
  | { type: "y"; output: 4 };

// @ts-expect-error 同时应提示重复和非字面量
type Check_MIXED = UniqueEvts<E_MIXED>;
// @ts-expect-error DuplicateTypeList 应非空（包含 'x'）
const T_MIXED_DUP: DuplicateTypeList<E_MIXED> extends [] ? true : never = true;
// @ts-expect-error BroadTypes 应为 'number'
const T_MIXED_BROAD: [BroadTypes<E_MIXED>] extends [never] ? true : never =
  true;

// 5) ✅ 从“注册表对象”推导（设计层面也避免重名）
const registry = {
  prepare_save_path: (s: string) =>
    ({ type: "prepare_save_path", output: s } as const),
  ping: (n: number) => ({ type: "ping", output: n } as const),
};
type EventsFromRegistry = ReturnType<(typeof registry)[keyof typeof registry]>;
type Check_REGISTRY = UniqueEvts<EventsFromRegistry>; // ✅ 通过

// 6) ❌ 注册表若把 key 写重名（演示）
// const badRegistry = {
//   a: (n: number) => ({ type: 'a', output: n } as const),
//   // a: (s: string) => ({ type: 'a', output: s } as const), // <-- 语法级别就重复了，TS 会直接拒绝
// };
