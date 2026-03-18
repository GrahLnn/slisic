import { describe, expect, test } from "bun:test";
import {
  getWindowPrewarmTarget,
  shouldRequestWindowPrewarm,
  type AppWindowMeta,
} from "../src/flow/bootstrap/logic";
import { commands } from "../src/cmd/commands";

function createMeta(overrides: Partial<AppWindowMeta> = {}): AppWindowMeta {
  return {
    window: null,
    label: "",
    isPrimaryWindow: false,
    isUserWindow: true,
    isPreparedWindow: false,
    status: "pending",
    ...overrides,
  };
}

describe("TemplateBoard prewarm effect", () => {
  test("renderer diagnostics command stays available for bootstrap timing evidence", () => {
    expect(typeof commands.recordRendererBootstrapReady).toBe("function");
  });

  test("uses descriptor prewarm targets for any resolved eligible user window", () => {
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBe(true);

    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: false,
          isUserWindow: true,
        }),
      ),
    ).toBe(true);

    expect(
      getWindowPrewarmTarget(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBeNull();
  });

  test("rerender-equivalent metadata stays eligible only once per mount through caller-side effect guards", () => {
    const firstRender = createMeta({
      status: "ready",
      window: "Main",
      isPrimaryWindow: true,
      isUserWindow: true,
    });

    const rerender = createMeta({
      status: "ready",
      window: "Main",
      isPrimaryWindow: true,
      isUserWindow: true,
      label: "main",
    });

    expect(shouldRequestWindowPrewarm(firstRender)).toBe(true);
    expect(shouldRequestWindowPrewarm(rerender)).toBe(true);
  });

  test("pending, error, and non-user windows never become eligible", () => {
    expect(shouldRequestWindowPrewarm(createMeta())).toBe(false);
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "error",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryWindow: true,
          isUserWindow: true,
          isPreparedWindow: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Support",
          isPrimaryWindow: true,
          isUserWindow: false,
        }),
      ),
    ).toBe(false);
  });
});
