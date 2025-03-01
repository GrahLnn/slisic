type RawResult<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export const Ok = <T, E = never>(value: T): Result<T, E> =>
  new Result({ ok: true, value });

export const Err = <E, T = never>(error: E): Result<T, E> =>
  new Result({ ok: false, error });

/**
 * Represents a value that can be either Ok (successful) or Err (failed).
 * This class provides methods for handling the value in a functional
 * programming style, such as `match`, `isOk`, `isErr`, `unwrap`, `unwrapErr`,
 * `unwrapOr`, `orElse`, `map`, `mapErr`, `bind`, `tap`, and `tapErr`.
 *
 * Note that the `Result` class is not meant to be used as a constructor, but
 * rather as a way to create a value that can be used with the above methods.
 * To create a `Result` value, use the `Ok` and `Err` functions.
 *
 * @example
 * const result = Ok(42);
 * const value = result.unwrap(); // 42
 *
 * const errResult = Err(new Error("oops"));
 * const error = errResult.unwrapErr(); // Error: oops
 *
 * const maybeValue = result.unwrapOr(43); // 42
 *
 * function divide(a: number, b: number): Result<number, Error> {
 *   if (b === 0) return Err(new Error("cannot divide by zero"));
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 0);
 * result.match({
 *   ok: (value) => console.log(value), // prints: 0
 *   err: (error) => console.error(error), // prints: Error: cannot divide by zero
 * });
 * result.unwrap(); // throws Error: cannot divide by zero
 * result.unwrapOr(43); // 43
 * result.orElse(() => 43); // 43
 * result.map(x => x * 2); // Result(Ok(86))
 * result.mapErr(e => e.message); // Result(Err(cannot divide by zero))
 * result.bind(x => divide(x, 0)); // Result(Err(Error: cannot divide by zero))
 * result.tap(x => console.log(x)); // Result(Ok(42))
 * result.tapErr(e => console.log(e)); // Result(Err(Error: cannot divide by zero))
 */
export class Result<T, E = Error> {
  constructor(private readonly result: RawResult<T, E>) {}

  // 模式匹配，接收一个对象分别处理 ok 和 err 的情况，返回一个统一结果
  match<U>(handlers: { ok: (value: T) => U; err: (error: E) => U }): U {
    if (this.result.ok) return handlers.ok(this.result.value);
    return handlers.err(this.result.error);
  }

  isOk(): this is Result<T, E> {
    return this.result.ok;
  }

  isErr(): this is Result<never, E> {
    return !this.result.ok;
  }

  // 如果成功，返回内部值；失败则抛出错误
  unwrap(): T {
    return this.match({
      ok: (value) => value,
      err: (error) => {
        throw new Error(`Called unwrap on an Err: ${error}`);
      },
    });
  }

  // 如果失败，返回内部错误；成功则抛出错误
  unwrapErr(): E {
    return this.match({
      ok: (value) => {
        throw new Error(`Called unwrapErr on an Ok: ${value}`);
      },
      err: (error) => error,
    });
  }

  // 如果成功则返回内部值，否则返回默认值
  unwrapOr(defaultValue: T): T {
    return this.match({
      ok: (value) => value,
      err: () => defaultValue,
    });
  }

  // 如果成功，则返回内部值，否则调用传入函数
  orElse(fn: (error: E) => T): T {
    return this.match({
      ok: (value) => value,
      err: (error) => fn(error),
    });
  }

  // 成功时对内部值做转换，失败时保持原错误
  map<U>(fn: (value: T) => U): Result<U, E> {
    return this.match({
      ok: (value) => Ok(fn(value)),
      err: (error) => Err(error),
    });
  }

  // 如果失败，则对错误做转换；成功时保持内部值
  mapErr<F>(fn: (error: E) => F): Result<T, F> {
    return this.match({
      ok: (value) => Ok(value),
      err: (error) => Err(fn(error)),
    });
  }

  // 链式调用：如果成功，则调用传入函数并返回新 Result；失败时直接传递错误
  bind<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return this.match({
      ok: (value) => fn(value),
      err: (error) => Err(error),
    });
  }

  // 如果成功，则调用传入函数
  tap(fn: (value: T) => void): this {
    if (this.isOk()) fn(this.unwrap());
    return this;
  }

  // 如果失败，则调用传入函数
  tapErr(fn: (error: E) => void): this {
    if (this.isErr()) fn(this.unwrapErr());
    return this;
  }

  // 提供原始数据访问（如果有需要的话）
  get raw(): RawResult<T, E> {
    return this.result;
  }
}

export async function rtry<T, E = Error>(
  promise: Promise<T>,
  errorFactory?: (err: unknown) => E
): Promise<Result<T, E>> {
  try {
    const value = await promise;
    return Ok(value);
  } catch (err) {
    return Err(errorFactory ? errorFactory(err) : (err as E));
  }
}
