import { type } from "arktype";
import { call0, I, K } from "./comb";
import { isEqual } from "lodash";

type Nil = null | undefined;
type ToRecordKey<T> = T extends boolean
  ? `${T}` // 把 true/false 变成 "true"/"false"
  : T extends string | number
  ? T
  : never;

type Handler<R, V = any> = {
  /** 当 V = any ⇒ (v: any) => R，可接受 () => R / (v: Sub) => R */
  (v: V): R;
  /** 小技巧：加个无用属性触发 bivariant 行为 */
  bivarianceHack?: never;
};

type RequireAll<T extends string | number | boolean, R> = Record<
  ToRecordKey<T>,
  Handler<R>
>;

type RequireDefault<T extends string | number | boolean, R> =
  | (Partial<Record<ToRecordKey<T>, Handler<R>>> & { _: Handler<R> })
  | RequireAll<T, R>;

type MatchableEnum<T extends string | number | boolean> = {
  __recognizer__: "enum";
  value: T | Nil;
  value_or(fallback: T): T;
  value_or<F>(fallback: F): T | F;
  value_or_else(fallback: () => T): T;
  value_or_else<F>(fallback: () => F): T | F;
  match<R>(handlers: RequireDefault<T, R>): R;
  is(v: T): v is T;
  not(v: T): v is T;
  in(v: Array<T>): boolean;
  not_in(v: Array<T>): boolean;
  into(): <R>(fn: Handler<R>) => R | null;
  catch<L extends Array<T>>(...arr_branch: L): <R>(fn: Handler<R>) => R | null;
};

function matchableEnum<T extends string | number | boolean>(
  value: T | Nil
): MatchableEnum<T> {
  return {
    __recognizer__: "enum",
    value,
    value_or(fallback: T): T {
      return value ?? fallback;
    },
    value_or_else(fallback: () => T): T {
      return value ?? fallback();
    },
    match<R>(h: RequireDefault<T, R>): R {
      // 运行时：boolean 转成 "true"/"false"
      const k = (
        typeof value === "boolean" ? String(value) : value
      ) as keyof typeof h;

      const handler = (
        k in h ? h[k] : (h as { _: Handler<R> })._
      ) as Handler<R>;
      return handler(value);
    },
    is: (v: T): v is T => value === v,
    not: (v: T): v is T => value !== v,
    in(arr: Array<T>): boolean {
      return value ? arr.includes(value) : false;
    },
    not_in(arr: Array<T>): boolean {
      return !this.in(arr);
    },
    into() {
      const self = this;
      return function <R>(fn: Handler<R>): R | null {
        return fn(self.value);
      };
    },
    catch<L extends Array<T>>(...arr_branch: L) {
      const self = this;
      return function <R>(fn: Handler<R>): R | null {
        return self.in(arr_branch) ? fn(self.value) : null;
      };
    },
  };
}

type VariantTag<T> = T extends any ? keyof T : never;

type FullHandlers<T, R> = {
  [K in VariantTag<T>]: (payload: Extract<T, Record<K, any>>[K]) => R;
};
type DefaultHandlers<T, R> =
  | (Partial<FullHandlers<T, R>> & { _: (p: T[keyof T]) => R })
  | FullHandlers<T, R>;

type MatchableUnion<T extends Record<string, any>> = {
  [K in VariantTag<T>]: {
    __recognizer__: "union";
    tag: K;
    value: Extract<T, Record<K, any>>[K] | Nil;

    match<R>(h: DefaultHandlers<T, R>): R;
    is<L extends VariantTag<T>>(
      l: L
    ): this is Extract<MatchableUnion<T>, { tag: L }>;
    not<L extends VariantTag<T>>(
      l: L
    ): this is Extract<MatchableUnion<T>, { tag: L }>;
    in(arr: Array<VariantTag<T>>): boolean;
    not_in(arr: Array<VariantTag<T>>): boolean;
    into(): <R>(fn: (payload: Extract<T, Record<K, any>>[K]) => R) => R | null;
    catch<K extends Array<VariantTag<T>>>(
      ...arr_branch: K
    ): <R>(
      fn: (payload: Extract<T, Record<K[number], any>>[K[number]]) => R
    ) => R | null;
  };
}[VariantTag<T>];

function matchableUnion<T extends Record<string, any>>(
  value: T
): MatchableUnion<T> {
  const tag = Object.keys(value)[0] as VariantTag<T>;
  const payload = (value as any)[tag];
  return {
    __recognizer__: "union",
    tag,
    value: payload,
    match<R>(h: DefaultHandlers<T, R>) {
      const fn =
        (h as Partial<Record<typeof tag, (p: any) => R>>)[tag] ??
        (h as { _: (p: any) => R })._;
      return fn(payload);
    },
    is<L extends VariantTag<T>>(
      l: L
    ): this is Extract<MatchableUnion<T>, { tag: L }> {
      return l === tag;
    },
    not<L extends VariantTag<T>>(
      l: L
    ): this is Extract<MatchableUnion<T>, { tag: L }> {
      return l !== tag;
    },
    in(arr: Array<VariantTag<T>>): boolean {
      return arr.includes(tag);
    },
    not_in(arr: Array<VariantTag<T>>): boolean {
      return !this.in(arr);
    },
    into() {
      const self = this;
      return function <R>(fn: Handler<R>): R | null {
        return self.value && !isEqual(self.value, []) ? fn(self.value) : null;
      };
    },
    catch<K extends Array<VariantTag<T>>>(...arr_branch: K) {
      const self = this;
      return function <R>(
        fn: (payload: Extract<T, Record<K[number], any>>[K[number]]) => R
      ): R | null {
        return self.in(arr_branch) && self.value && !isEqual(self.value, [])
          ? fn(self.value as any)
          : null;
      };
    },
  };
}

const emptyMatchable = {
  __recognizer__: "empty",
  value: null,
  value_or: I,
  value_or_else: call0,
  match: K(null),
  is: K(false),
  not: K(false),
  catch: K(K(null)),
  not_in: K(false),
  into: K(K(null)),
  in: K(false),
};

type EmptyMatchable = typeof emptyMatchable;

type MatchableObj<T extends Record<string, any>> = {
  __recognizer__: "object";
  value: T;
  into(): <R>(fn: (props: T) => R) => R | null;
  catch<KS extends readonly (keyof T)[]>(
    ...keys: KS
  ): <R>(
    fn: (props: { [P in KS[number]]: NonNullable<T[P]> }) => R
  ) => R | null;
};

function matchableObj<T extends object>(value: T): MatchableObj<T> {
  return {
    __recognizer__: "object",
    value,
    into() {
      return (fn) => {
        return fn(value);
      };
    },
    catch(...keys) {
      return (fn) => {
        if (keys.some((k) => !value[k])) return null;
        const picked: any = {};
        for (const k of keys) picked[k] = value[k];
        return fn(picked);
      };
    },
  };
}

type IsUnion<T, U = T> = T extends any
  ? [U] extends [T]
    ? false
    : true
  : never;

type IsSingleKeyObj<O extends Record<string, any>> = IsUnion<
  keyof O
> extends true
  ? false
  : true;

/* 判断 “联合里的每个成员都恰好 1 键” */
type IsUnionOfSingleKey<U extends Record<string, any>> =
  // 把 U 分发，收集结果；若有任何 false ⇒ 最终 union 包含 false
  (U extends any ? IsSingleKeyObj<U> : never) extends false ? false : true;

type MatchableError<T> = {
  __matchable_error__: `❌ match() only supports string | number | boolean | Record<string, any>, but got: ${Extract<
    T,
    string | number | bigint | boolean | null | undefined
  >}`;
  value: T;
};

type _MatchableCore<T> = [T] extends [string | number | boolean]
  ? MatchableEnum<T>
  : [T] extends [Record<string, any>]
  ? IsUnionOfSingleKey<T> extends true
    ? MatchableUnion<T> // 单键：视作 Rust‑enum 封装
    : MatchableObj<T> // 多键：普通对象
  : MatchableError<T>;

export type Matchable<T> =
  | ([T] extends [null] ? EmptyMatchable : never)
  | ([T] extends [undefined] ? EmptyMatchable : never)
  | _MatchableCore<NonNullable<T>>;

export function me<
  T extends string | number | boolean | Record<string, any> | null | undefined
>(value: T): Matchable<T>;
export function me(value: any): any {
  if (value == null) return emptyMatchable;
  if (["string", "number", "boolean"].includes(typeof value))
    return matchableEnum(value);
  // ⚠️ 如果想用 Union 模式，必须“单键封装”，因为等同于rust的enum：
  if (Object.keys(value).length === 1) return matchableUnion(value);
  // 否则走对象模式
  return matchableObj(value);
}
