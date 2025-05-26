type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
type RawResult<T, E = Error> = Ok<T> | Err<E>;

export const Ok = <T, E = never>(value: T): Result<T, E> =>
  new Result({ ok: true, value });

export const Err = <E, T = never>(error: E): Result<T, E> =>
  new Result({ ok: false, error });

export class Result<T, E = Error> {
  constructor(private readonly result: RawResult<T, E>) {}

  match<U>(handlers: { Ok: (value: T) => U; Err: (error: E) => U }): U {
    return this.result.ok
      ? handlers.Ok(this.result.value)
      : handlers.Err(this.result.error);
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
      Ok: (value) => value,
      Err: (error) => {
        console.error("unwrap error:", error);
        throw new Error(`Called unwrap on an Err: ${error}`);
      },
    });
  }

  // 如果失败，返回内部错误；成功则抛出错误
  unwrapErr(): E {
    return this.match({
      Ok: (value) => {
        throw new Error(`Called unwrapErr on an Ok: ${value}`);
      },
      Err: (error) => error,
    });
  }

  // 如果成功则返回内部值，否则返回默认值
  unwrapOr(defaultValue: T): T {
    return this.match({
      Ok: (value) => value,
      Err: () => defaultValue,
    });
  }

  // 如果成功，则返回内部值，否则调用传入函数
  orElse(fn: (error: E) => T): T {
    return this.match({
      Ok: (value) => value,
      Err: (error) => fn(error),
    });
  }

  // 成功时对内部值做转换，失败时保持原错误
  map<U>(fn: (value: T) => U): Result<U, E> {
    return this.match({
      Ok: (value) => Ok(fn(value)),
      Err: (error) => Err(error),
    });
  }

  // 如果失败，则对错误做转换；成功时保持内部值
  mapErr<F>(fn: (error: E) => F): Result<T, F> {
    return this.match({
      Ok: (value) => Ok(value),
      Err: (error) => Err(fn(error)),
    });
  }

  // 链式调用：如果成功，则调用传入函数并返回新 Result；失败时直接传递错误
  to<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return this.match({
      Ok: (value) => fn(value),
      Err: (error) => Err(error),
    });
  }

  // 如果成功，则调用传入函数
  tap(fn: (value: T) => void): this {
    if (this.isOk()) fn(this.unwrap());
    else console.error("tap error:", (this as Result<any, E>).unwrapErr());
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
