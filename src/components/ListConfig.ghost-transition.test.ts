import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { registerGhostNodeOwner, resolveRegisteredGhostNode } from "./ListConfig.ghost-transition";

describe("ListConfig ghost transition registry", () => {
  test("resolves the requested owner while both sides are live", () => {
    const registry = new Map<string, Map<string, HTMLDivElement>>();
    const previousNode = { dataset: { owner: "tool-label" } } as unknown as HTMLDivElement;
    const nextNode = { dataset: { owner: "arc-track" } } as unknown as HTMLDivElement;

    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/live",
      ownerId: "tool-label",
      node: previousNode,
    });
    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/live",
      ownerId: "arc-track",
      node: nextNode,
    });

    assert.equal(
      resolveRegisteredGhostNode({
        registry,
        layoutId: "playlist:collection:https://example.com/live",
        ownerId: "arc-track",
      }),
      nextNode,
    );
  });

  test("keeps the new owner registration when the previous owner unregisters later", () => {
    const registry = new Map<string, Map<string, HTMLDivElement>>();
    const previousNode = { dataset: { owner: "tool-label" } } as unknown as HTMLDivElement;
    const nextNode = { dataset: { owner: "arc-track" } } as unknown as HTMLDivElement;

    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/a",
      ownerId: "tool-label",
      node: previousNode,
    });
    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/a",
      ownerId: "arc-track",
      node: nextNode,
    });
    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/a",
      ownerId: "tool-label",
      node: null,
    });

    assert.equal(
      resolveRegisteredGhostNode({
        registry,
        layoutId: "playlist:collection:https://example.com/a",
        ownerId: "arc-track",
      }),
      nextNode,
    );
  });

  test("drops the layout entry only after the last owner unregisters", () => {
    const registry = new Map<string, Map<string, HTMLDivElement>>();
    const trackNode = { dataset: { owner: "arc-track" } } as unknown as HTMLDivElement;

    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/b",
      ownerId: "tool-label",
      node: { dataset: { owner: "tool-label" } } as unknown as HTMLDivElement,
    });
    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/b",
      ownerId: "arc-track",
      node: trackNode,
    });
    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/b",
      ownerId: "tool-label",
      node: null,
    });

    assert.equal(
      resolveRegisteredGhostNode({
        registry,
        layoutId: "playlist:collection:https://example.com/b",
        ownerId: "arc-track",
      }),
      trackNode,
    );

    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/b",
      ownerId: "arc-track",
      node: null,
    });

    assert.equal(
      resolveRegisteredGhostNode({
        registry,
        layoutId: "playlist:collection:https://example.com/b",
        ownerId: "arc-track",
      }),
      null,
    );
  });

  test("does not report a change when the same owner keeps the same node", () => {
    const registry = new Map<string, Map<string, HTMLDivElement>>();
    const stableNode = { dataset: { owner: "tool-label" } } as unknown as HTMLDivElement;

    assert.equal(
      registerGhostNodeOwner({
        registry,
        layoutId: "playlist:collection:https://example.com/c",
        ownerId: "tool-label",
        node: stableNode,
      }),
      true,
    );
    assert.equal(
      registerGhostNodeOwner({
        registry,
        layoutId: "playlist:collection:https://example.com/c",
        ownerId: "tool-label",
        node: stableNode,
      }),
      false,
    );
  });

  test("reports a change when the same owner replaces its node before playback starts", () => {
    const registry = new Map<string, Map<string, HTMLDivElement>>();
    const previousNode = { dataset: { instance: "previous" } } as unknown as HTMLDivElement;
    const nextNode = { dataset: { instance: "next" } } as unknown as HTMLDivElement;

    registerGhostNodeOwner({
      registry,
      layoutId: "playlist:collection:https://example.com/d",
      ownerId: "arc-track",
      node: previousNode,
    });

    assert.equal(
      registerGhostNodeOwner({
        registry,
        layoutId: "playlist:collection:https://example.com/d",
        ownerId: "arc-track",
        node: nextNode,
      }),
      true,
    );
    assert.equal(
      resolveRegisteredGhostNode({
        registry,
        layoutId: "playlist:collection:https://example.com/d",
        ownerId: "arc-track",
      }),
      nextNode,
    );
  });
});
