import { describe, expect, test } from "bun:test";
import { shouldRequestWindowPrewarm, type AppWindowMeta } from "../src/flow/bootstrap/logic";

function createMeta(overrides: Partial<AppWindowMeta> = {}): AppWindowMeta {
  return {
    window: null,
    label: "",
    isPrimaryMain: false,
    isUserWindow: true,
    status: "pending",
    ...overrides,
  };
}

describe("TemplateBoard prewarm effect", () => {
  test("gates prewarm eligibility to the true primary visible main window", () => {
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryMain: true,
          isUserWindow: true,
        }),
      ),
    ).toBe(true);

    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: "Main",
          isPrimaryMain: false,
          isUserWindow: true,
        }),
      ),
    ).toBe(false);

    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: null,
          isPrimaryMain: true,
          isUserWindow: false,
        }),
      ),
    ).toBe(false);
  });

  test("rerender-equivalent metadata stays eligible only once per mount through caller-side effect guards", () => {
    const firstRender = createMeta({
      status: "ready",
      window: "Main",
      isPrimaryMain: true,
      isUserWindow: true,
    });

    const rerender = createMeta({
      status: "ready",
      window: "Main",
      isPrimaryMain: true,
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
          isPrimaryMain: true,
          isUserWindow: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldRequestWindowPrewarm(
        createMeta({
          status: "ready",
          window: null,
          isPrimaryMain: true,
          isUserWindow: false,
        }),
      ),
    ).toBe(false);
  });
});
