import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { remoteShareCodeFeedback } from "./remoteShareCodeFeedback";

describe("remoteShareCodeFeedback", () => {
  test("maps stable ownership errors without exposing relay details", () => {
    assert.deepEqual(remoteShareCodeFeedback("remote_code_occupied"), {
      tone: "error",
      title: "Connection code is already in use",
      description: "The previous connection code is unchanged.",
    });
    assert.deepEqual(remoteShareCodeFeedback(new Error("remote_code_network_required")), {
      tone: "warning",
      title: "Connect to the internet to verify this code",
      description: "The previous connection code is unchanged.",
    });
  });
});
