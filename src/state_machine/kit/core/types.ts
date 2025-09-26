/* ---------- 公用类型（仅类型，不含实现） ---------- */

import { MachineEvent, PayloadEvent } from "../xstate/events";

/** 状态名映射：{ idle: "idle", ... } */
export type StateMap<T extends readonly string[]> = { [K in T[number]]: K };

export type Signal<T extends string> = { type: T; evt: T };

/** 信号名映射（小写键）：{ to_idle: {type:"to_idle", into(): "to_idle"} } */
export type SignalMap<T extends string> = {
  [K in T as Lowercase<K>]: Signal<K>;
};

/** 自动生成的跳转信号名： "to_idle" | "to_loading" ... */
export type ToSignal<T extends readonly string[]> = `to_${T[number]}`;

/** 仅基于状态自动生成的 transfer 键集合（运行时可扩，类型上保持保守） */
export type TransferBase<TState extends readonly string[]> = {
  [K in Lowercase<ToSignal<TState>>]: {
    // 由键 K 反推目标状态字面量
    target: K extends `to_${infer S}` ? S & TState[number] : never;
  };
};

export type TransferMap<TState extends readonly string[]> =
  TransferBase<TState> & {
    pick<K extends keyof TransferBase<TState>>(
      ...keys: K[]
    ): Pick<TransferBase<TState>, K>;
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
export type Prefix = "xstate.done.actor.";
export type WithPrefix<S extends string> = `${Prefix}${S}`;
export type StripPrefix<S extends string> = S extends `${Prefix}${infer R}`
  ? R
  : S;

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
  : S extends `${string}.${string}`
  ? "States containing dots are not accepted."
  : S;

export type SignalEvt<T, Key extends PropertyKey = "Signal"> = ValueOf<{
  [P in keyof T]: T[P] extends Record<Key, infer S>
    ? S extends Record<PropertyKey, any>
      ? ValueOf<S>
      : S
    : never;
}>;

export type PayloadEvt<T extends readonly PayloadEvent[]> = T[number];
export type MachineEvt<T extends readonly MachineEvent[]> = T[number];

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

type CanonicalTypeKey<K> = K extends string ? StripPrefix<K> : K;

/* —— 修改：NormalizeByType 里把 type 归一化（剥前缀） —— */
type NormalizeByType<U extends { type: PropertyKey }> = U extends any
  ? U["type"] extends infer T
    ? T extends PropertyKey
      ? Omit<U, "type"> & {
          type: T extends string ? CanonicalTypeKey<T> : T;
        }
      : never
    : never
  : never;

/* —— 宽类型检查也基于归一化后的 type（含剥前缀） —— */
type BroadKinds<U extends { type: PropertyKey }> = NormalizeByType<U> extends {
  type: infer K;
}
  ? K extends string
    ? string extends K
      ? "string"
      : never
    : K extends number
    ? number extends K
      ? "number"
      : never
    : K extends symbol
    ? symbol extends K
      ? "symbol"
      : never
    : never
  : never;

type IsUnion<T, U = T> = (T extends any ? (k: T) => void : never) extends (
  k: infer I
) => void
  ? [U] extends [I]
    ? false
    : true
  : never;

/* —— UniqueEvts：逻辑不变，但内部用的是“剥前缀后”的 NormalizeByType —— */
type KeysAfterNormalize<U extends { type: PropertyKey }> =
  NormalizeByType<U> extends { type: infer K } ? K : never;

/** 保留原名：DuplicateTypeList —— 但实现改为浅判重复 */
type DuplicateTypeList<U extends { type: PropertyKey }> =
  KeysAfterNormalize<U> extends infer K
    ? K extends PropertyKey
      ? IsUnion<Extract<NormalizeByType<U>, { type: K }>> extends true
        ? K
        : never
      : never
    : never;

/** 保留原名与分支结构：UniqueEvts —— 用新的 DuplicateTypeList 与 BroadKinds */
export type UniqueEvts<U extends { type: PropertyKey }> = [
  DuplicateTypeList<U>
] extends [never]
  ? [BroadKinds<U>] extends [never]
    ? U
    : { __ERROR_NON_LITERAL_EVENT_TYPES: BroadKinds<U> }
  : {
      __ERROR_DUPLICATE_EVENT_TYPES: DuplicateTypeList<U>;
      __ERROR_NON_LITERAL_EVENT_TYPES: BroadKinds<U>;
    };

/* —— （可选）兼容你示例里用到的 BroadTypes 名称 —— */
type BroadTypes<U extends { type: PropertyKey }> = BroadKinds<U>;

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
