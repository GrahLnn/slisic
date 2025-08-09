/* 将多个 { name: { State, Signal, transfer } } 合并并做键冲突检查 */

type SstShape = {
  State: object;
  Signal: object;
  transfer: unknown;
};

/* 保留命名空间名为 key */
export function ns<const N extends string, S extends SstShape>(name: N, ss: S) {
  return { [name]: ss } as { readonly [K in N]: S };
}

/* 从“值”里提键（不依赖索引签名） */
type ItemVal<I> = I[keyof I];
type StateKeysOfItem<I> = ItemVal<I> extends { State: infer ST }
  ? keyof ST & string
  : never;
type SignalKeysOfItem<I> = ItemVal<I> extends { Signal: infer SG }
  ? keyof SG & string
  : never;

/* 冲突检查 */
type CheckItem<I, PS extends string, PG extends string> =
  | ([Extract<StateKeysOfItem<I>, PS>] extends [never]
      ? unknown
      : { __state_collision__: Extract<StateKeysOfItem<I>, PS> } & I)
  | ([Extract<SignalKeysOfItem<I>, PG>] extends [never]
      ? unknown
      : { __signal_collision__: Extract<SignalKeysOfItem<I>, PG> } & I)
  | ([Extract<StateKeysOfItem<I>, PG>] extends [never]
      ? unknown
      : { __state_vs_signal_collision__: Extract<StateKeysOfItem<I>, PG> } & I)
  | ([Extract<SignalKeysOfItem<I>, PS>] extends [never]
      ? unknown
      : {
          __signal_vs_state_collision__: Extract<SignalKeysOfItem<I>, PS>;
        } & I);

/* 递归装饰：先精确推断，再叠加约束 */
type DecorateUnique<
  T extends readonly any[],
  PS extends string = never,
  PG extends string = never
> = T extends readonly [infer I, ...infer R]
  ? I extends Record<string, SstShape>
    ? [
        I & CheckItem<I, PS, PG>,
        ...DecorateUnique<R, PS | StateKeysOfItem<I>, PG | SignalKeysOfItem<I>>
      ]
    : never
  : [];

/* 交叉合并 */
type IntersectTuple<T extends readonly any[]> = T extends readonly [
  infer A,
  ...infer R
]
  ? A & IntersectTuple<R>
  : {};

/* defineSS：T 只承接实参元组，唯一性检查通过 & DecorateUnique<T> 完成 */
export function defineSS<const T extends readonly any[]>(
  ...sss: T & DecorateUnique<T>
) {
  return Object.assign({}, ...sss) as IntersectTuple<T>;
}

/* 少量类型导出（可按需） */
export type { SstShape, DecorateUnique, IntersectTuple };
