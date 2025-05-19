import { commands, type Result as SpectaResult } from "./commands";
import { Ok, Err, type Result } from "@/lib/result";

type CommandsType = typeof commands;
type CommandKey = keyof CommandsType;
// 从 SpectaResult 里提取成功值
type DataOf<R> = R extends { status: "ok"; data: infer D } ? D : never;
// 从 SpectaResult 里提取错误值
type ErrorOf<R> = R extends { status: "error"; error: infer E } ? E : never;

type CommandReturnType<K extends CommandKey> = ReturnType<CommandsType[K]>;

type SpectaToResult<K extends CommandKey> =
  CommandReturnType<K> extends Promise<infer R>
    ? // 如果是 SpectaResult 结构 → 转成自定义 Result
      R extends { status: "ok" | "error" }
      ? Promise<Result<DataOf<R>, ErrorOf<R>>>
      : CommandReturnType<K> // 普通 Promise 直接透传
    : CommandReturnType<K>; // 同步函数保持同步

/**
 * 创建一个代理对象，自动将所有命令的返回值转换为自定义Result类型
 */
export const crab = new Proxy(
  {} as {
    [K in CommandKey]: (
      ...args: Parameters<CommandsType[K]>
    ) => SpectaToResult<K>;
  },
  {
    get: (_, prop: string) => {
      // 如果属性不是commands的方法，返回undefined
      if (!(prop in commands)) {
        return undefined;
      }

      // 返回一个包装函数
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      return async (...args: any[]) => {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: <explanation>
          const originalResult = await (commands as any)[prop](...args);

          // 检查返回值是否是Result格式
          if (
            originalResult &&
            typeof originalResult === "object" &&
            originalResult !== null &&
            "status" in originalResult
          ) {
            const spectaResult = originalResult as SpectaResult<
              unknown,
              unknown
            >;

            switch (spectaResult.status) {
              case "ok":
                return Ok(spectaResult.data);
              case "error":
                return Err(spectaResult.error);
            }
          }

          // 如果不是Result格式，直接返回原始结果
          return originalResult;
        } catch (error) {
          return Err(error);
        }
      };
    },
  }
);

