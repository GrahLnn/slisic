import { commands, type Result as SpectaResult } from "./commands";
import { Ok, Err, type Result } from "@/lib/result";

// 类型定义
type CommandsType = typeof commands;
type CommandKey = keyof CommandsType;
type CommandReturnType<K extends CommandKey> = ReturnType<
  CommandsType[K]
> extends Promise<infer R>
  ? R
  : never;

/**
 * 创建一个代理对象，自动将所有命令的返回值转换为自定义Result类型
 */
export const cmdAdapter = new Proxy(
  {} as {
    [K in CommandKey]: (
      ...args: Parameters<CommandsType[K]>
    ) => CommandReturnType<K> extends {
      status: "ok" | "error";
      data?: infer D;
      error?: infer E;
    }
      ? Promise<Result<D, E>>
      : ReturnType<CommandsType[K]>;
  },
  {
    get: (target, prop: string) => {
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
