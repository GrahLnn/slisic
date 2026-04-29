import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveSpectrumTitleFadeProps } from "./SpectrumPage";
import {
  resolveSpectrumBackActionVisualState,
  resolveSpectrumCommittedTitle,
  resolveSpectrumTitle,
} from "./SpectrumPage.view-model";

describe("SpectrumPage", () => {
  test("keeps shared title visible instead of applying page content fade", () => {
    assert.deepEqual(resolveSpectrumTitleFadeProps({ hasSharedTitleLayout: true }), {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("uses regular content fade when no shared title layout exists", () => {
    assert.deepEqual(resolveSpectrumTitleFadeProps({ hasSharedTitleLayout: false }), {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("uses the music title draft as the editable spectrum title", () => {
    assert.equal(
      resolveSpectrumTitle({
        musicTitleDraft: {
          baselineName: "Disc 1 Opening",
          name: "Disc 1 Prelude",
          url: "https://example.com/quiet-morning#disc-1-opening",
        },
        nowPlayingTrackName: "Disc 1 Opening",
        playingPlaylistName: "Focus Session",
      }),
      "Disc 1 Prelude",
    );
  });

  test("switches the back action only when the draft differs from current music data", () => {
    const draft = {
      baselineName: "Disc 1 Opening",
      name: "Disc 1 Opening",
      url: "https://example.com/quiet-morning#disc-1-opening",
    };

    assert.deepEqual(resolveSpectrumBackActionVisualState({ musicTitleDraft: draft }), {
      kind: "back",
      key: "back",
    });
    assert.deepEqual(
      resolveSpectrumBackActionVisualState({
        musicTitleDraft: {
          ...draft,
          name: "Disc 1 Prelude",
        },
      }),
      {
        kind: "check",
        key: "check",
      },
    );
    assert.deepEqual(
      resolveSpectrumBackActionVisualState({
        musicTitleDraft: {
          ...draft,
          name: "Disc 1 Opening",
        },
      }),
      {
        kind: "back",
        key: "back",
      },
    );
  });

  test("resolves the committed spectrum title before returning to playback", () => {
    assert.deepEqual(
      resolveSpectrumCommittedTitle({
        musicTitleDraft: {
          baselineName: "Disc 1 Opening",
          name: "",
          url: "https://example.com/quiet-morning#disc-1-opening",
        },
        renderedTitle: "",
      }),
      {
        kind: "restore",
        name: "Disc 1 Opening",
      },
    );
  });
});
