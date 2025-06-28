/* ---------- enum 专用 ---------- */
type RequireAll<T extends string | number, R> = Record<T, () => R>;
type RequireDefault<T extends string | number, R> =
  | (Partial<Record<T, () => R>> & { _: () => R })
  | RequireAll<T, R>;

type MatchableEnum<T extends string | number> = {
  value: T;
  match<R>(handlers: RequireDefault<T, R>): R;
  is(v: T): v is T;
};

function matchableEnum<T extends string | number>(value: T): MatchableEnum<T> {
  return {
    value,
    match<R>(h: RequireDefault<T, R>) {
      if (value in h) return (h as Record<T, () => R>)[value]();
      if ("_" in h) return (h as { _: () => R })._();
      throw new Error(`unhandled enum value ${value as string}`);
    },
    is: (v: T): v is T => v === value,
  };
}

/* ---------- union 专用 ---------- */
type VariantTag<T> = T extends any ? keyof T : never;

type FullHandlers<T, R> = {
  [K in VariantTag<T>]: (payload: Extract<T, Record<K, any>>[K]) => R;
};
type DefaultHandlers<T, R> =
  | (Partial<FullHandlers<T, R>> & { _: (p: T[keyof T]) => R })
  | FullHandlers<T, R>;

type MatchableUnion<T extends Record<string, any>> = {
  [K in VariantTag<T>]: {
    tag: K;
    value: Extract<T, Record<K, any>>[K];
    match<R>(h: DefaultHandlers<T, R>): R;
    is(l: VariantTag<T>): this is MatchableUnion<T> & { tag: typeof l };
  };
}[VariantTag<T>];

function matchableUnion<T extends Record<string, any>>(
  value: T
): MatchableUnion<T> {
  const tag = Object.keys(value)[0] as VariantTag<T>;
  const payload = (value as any)[tag];
  return {
    tag,
    value: payload,
    match<R>(h: DefaultHandlers<T, R>) {
      const fn =
        (h as Partial<Record<typeof tag, (p: any) => R>>)[tag] ??
        (h as { _: (p: any) => R })._;
      return fn(payload);
    },
    is(l: VariantTag<T>): l is VariantTag<T> {
      return l === tag;
    },
  } as any;
}

// ### 为何参数被推成 **`never`**？

// ```ts
// export type Matchable<T> =
//   T extends string | number        // ← 裸露的 T
//     ? MatchableEnum<T>             // ①
//     : T extends Record<string, any>
//     ? MatchableUnion<T>            // ②
//     : never;
// ```

// `T` 如果是联合（例如 `"detail" | "list"`），**条件类型默认会“分发”**：

// ```
// Matchable<"detail" | "list">
//   ⇓ 分别套进去
// MatchableEnum<"detail"> | MatchableEnum<"list">
// ```

// 接着，`MatchableEnum<X>` 里的 `is` 各自长这样：

// ```ts
// is(v: "detail"): v is "detail"   // 分支 1
// is(v: "list"):   v is "list"     // 分支 2
// ```

// 把这两个函数做并集时，TypeScript 会取 **参数类型的交集** →
// `"detail" & "list"` ⇒ **`never`**。于是调用时报

// ```
// Argument of type '"detail"' is not assignable to parameter of type 'never'.
// ```

// ---

// ## 解决办法：让条件类型 **不分发**

// 给 `T` 套一层元组即可阻断分发：

// ```ts
// export type Matchable<T> =
//   [T] extends [string | number]            // ← 用 [T] 包裹
//     ? MatchableEnum<T>
//     : [T] extends [Record<string, any>]
//     ? MatchableUnion<T>
//     : never;
// ```

// * `[T]` → 非“裸类型”，条件类型只评估 **一次**，不会把联合拆开。
// * 此时 `is` 的参数就是完整的联合 `"detail" | "list"`，调用自然通过。

// ## 另一种做法：在 `is` 里写统一参数类型

// 若你想保留可分发的 `Matchable<T>`，也可以把
// `MatchableEnum` / `MatchableUnion` 中的 `is` 改写为 **同一个宽参数类型**，
// 例如：

// ```ts
// is(v: T | (string & {})): v is Extract<T, typeof v>
// ```

// 这样每个分支的 `is` 参数就一致，不会在联合时交集成 `never`。
// 但通常 **阻断分发 `[T] extends …` 最简单**，推荐首选。

export type Matchable<T> = [T] extends [string | number]
  ? MatchableEnum<T>
  : [T] extends [Record<string, any>]
  ? MatchableUnion<T>
  : never;

export function matchable<T extends string | number>(value: T): Matchable<T>;
export function matchable<T extends Record<string, any>>(
  value: T
): Matchable<T>;
export function matchable(value: any): any {
  return typeof value === "string" || typeof value === "number"
    ? matchableEnum(value)
    : matchableUnion(value);
}
