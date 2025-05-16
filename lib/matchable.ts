// 辅助类型，用于检查是否所有键都存在
type RequireAll<T extends string | number, R> = Record<T, () => R>;

// 辅助类型，允许部分键加上默认处理
type RequireDefault<T extends string | number, R> = Partial<
  Record<T, () => R>
> & { _: () => R };

// 联合类型，要么所有键都有，要么有默认处理
type MatchHandlers<T extends string | number, R> =
  | RequireAll<T, R>
  | RequireDefault<T, R>;

export interface Matchable<T extends string | number> {
  value: T;
  match: <R>(handlers: MatchHandlers<T, R>) => R;
  is: (v: T) => boolean;
}

/**
 * 为枚举类型创建一个可匹配的对象
 * @param value 当前枚举值
 * @returns 包含 value 和 match 方法的对象
 */
export function matchable<T extends string | number>(value: T): Matchable<T> {
  return {
    value,
    match: <R>(handlers: MatchHandlers<T, R>): R => {
      if (value in handlers) return (handlers as Record<T, () => R>)[value]();
      if ("_" in handlers) return (handlers as { _: () => R })._();

      throw new Error(`unknown enum value: ${value}`);
    },
    is: (v: T): boolean => value === v,
  };
}
