import { describe, expect, test } from "bun:test";
import {
  deriveBootstrapDecision,
  type BootstrapWindowState,
} from "./logic";

describe("bootstrap logic", () => {
  test("pending should still render app while delaying startup work", () => {
    const decision = deriveBootstrapDecision({ status: "pending" });
    expect(decision.shouldRenderApp).toBe(true);
    expect(decision.shouldStartApp).toBe(false);
    expect(decision.isConfirmedPrewarm).toBe(false);
  });

  test("error should fallback to normal app rendering", () => {
    const decision = deriveBootstrapDecision({
      status: "error",
      reason: "invoke failed",
    });
    expect(decision.shouldRenderApp).toBe(true);
    expect(decision.shouldStartApp).toBe(true);
    expect(decision.isConfirmedPrewarm).toBe(false);
  });

  test("resolved unknown window should still behave like the main app", () => {
    const state: BootstrapWindowState = {
      status: "resolved",
      info: {
        window: null,
        is_prewarm: false,
        label: "unknown-window",
        is_primary_main: false,
      },
    };
    const decision = deriveBootstrapDecision(state);
    expect(decision.shouldRenderApp).toBe(true);
    expect(decision.shouldStartApp).toBe(true);
    expect(decision.isConfirmedPrewarm).toBe(false);
  });

  test("resolved prewarm window should not render or start the app", () => {
    const state: BootstrapWindowState = {
      status: "resolved",
      info: {
        window: "Main",
        is_prewarm: true,
        label: "main-prewarm-1",
        is_primary_main: false,
      },
    };
    const decision = deriveBootstrapDecision(state);
    expect(decision.shouldRenderApp).toBe(false);
    expect(decision.shouldStartApp).toBe(false);
    expect(decision.isConfirmedPrewarm).toBe(true);
  });
});

