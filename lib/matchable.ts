export interface Matchable<T extends string | number> {
  value: T;
  match: <R>(handlers: Record<T, () => R>) => R;
}

/**
 * 为枚举类型创建一个可匹配的对象
 * @param value 当前枚举值
 * @returns 包含 value 和 match 方法的对象
 */
export function matchable<T extends string | number>(
  value: T
): Matchable<T> {
  return {
    value,
    match: <R>(handlers: Record<T, () => R>): R => {
      if (handlers[value]) return handlers[value]();
      throw new Error(`unknown enum value: ${value}`);
    },
  };
}
