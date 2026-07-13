import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SileoOptions } from "sileo";
import { showUpdateReady } from "./events";

describe("update ready notification", () => {
  test("runs the installation once when Restart is clicked repeatedly", async () => {
    let notification: SileoOptions | undefined;
    let installationRuns = 0;
    let releaseInstallation: (() => void) | undefined;
    let installationPromise: Promise<unknown> | undefined;

    showUpdateReady(
      {
        version: "2.0.3",
        runInstallation: () => {
          installationRuns += 1;
          return new Promise<void>((resolve) => {
            releaseInstallation = resolve;
          });
        },
      },
      {
        success: (options) => {
          notification = options;
          return "update-ready";
        },
        promise: <T>(task: Promise<T> | (() => Promise<T>)) => {
          const result = typeof task === "function" ? task() : task;
          installationPromise = result;
          return result;
        },
      },
    );

    assert.equal(notification?.title, "Update ready");
    assert.equal(notification?.button?.title, "Restart");

    notification?.button?.onClick();
    notification?.button?.onClick();

    assert.equal(installationRuns, 1);
    assert.ok(releaseInstallation);
    releaseInstallation();
    await installationPromise;
  });

  test("allows retry after an installation failure", async () => {
    let notification: SileoOptions | undefined;
    let installationRuns = 0;

    showUpdateReady(
      {
        version: "2.0.3",
        runInstallation: async () => {
          installationRuns += 1;
          throw new Error("install failed");
        },
      },
      {
        success: (options) => {
          notification = options;
          return "update-ready";
        },
        promise: async (task) => {
          if (typeof task === "function") {
            return task();
          }
          return task;
        },
      },
    );

    notification?.button?.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    notification?.button?.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(installationRuns, 2);
  });
});
