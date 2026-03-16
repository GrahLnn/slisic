import type { WindowKindInfo } from "@/src/cmd/commands";

export type BootstrapWindowState =
  | { status: "pending" }
  | { status: "error"; reason: string }
  | { status: "resolved"; info: WindowKindInfo | null };

export interface BootstrapDecision {
  shouldRenderApp: boolean;
  shouldStartApp: boolean;
  isConfirmedPrewarm: boolean;
}

export function deriveBootstrapDecision(
  state: BootstrapWindowState,
): BootstrapDecision {
  if (state.status === "pending") {
    return {
      shouldRenderApp: true,
      shouldStartApp: false,
      isConfirmedPrewarm: false,
    };
  }

  if (state.status === "error") {
    return {
      shouldRenderApp: true,
      shouldStartApp: true,
      isConfirmedPrewarm: false,
    };
  }

  const isConfirmedPrewarm = state.info?.is_prewarm === true;
  return {
    shouldRenderApp: !isConfirmedPrewarm,
    shouldStartApp: !isConfirmedPrewarm,
    isConfirmedPrewarm,
  };
}

