import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolvePlayListTitleHandoffEndpointKind,
  resolvePlayListTitleHandoffInstruction,
  resolvePlayListTitleHandoffPlan,
  type PlayListTitleEndpoint,
} from "./playListTitleHandoff.model";

const quietMorningEndpoint: PlayListTitleEndpoint = {
  layoutId: "playlist-title:Quiet Morning",
  playlistName: "Quiet Morning",
};

const nightDriveEndpoint: PlayListTitleEndpoint = {
  layoutId: "playlist-title:Night Drive",
  playlistName: "Night Drive",
};

describe("playListTitleHandoff model", () => {
  test("models list-to-play as a timed source and target path", () => {
    const plan = resolvePlayListTitleHandoffPlan({
      pageState: "play",
      endpoints: [nightDriveEndpoint, quietMorningEndpoint],
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: null,
      transition: {
        outgoingSourceLayoutId: null,
        returnTargetLayoutId: null,
        committedLayoutId: "playlist-title:Quiet Morning",
      },
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.deepEqual(plan, {
      displayLock: {
        kind: "opening-playback",
        playlistName: "Quiet Morning",
      },
      arrow: {
        kind: "list-to-play",
        source: {
          kind: "list",
          layoutId: "playlist-title:Quiet Morning",
        },
        target: {
          kind: "play",
          layoutId: "playlist-title:Quiet Morning",
        },
        targetRetainLease: "timed",
      },
      sourceLayoutId: "playlist-title:Quiet Morning",
      targetLayoutId: "playlist-title:Quiet Morning",
      targetRetainLease: "timed",
    });
    assert.equal(
      resolvePlayListTitleHandoffEndpointKind({
        plan,
        layoutId: "playlist-title:Quiet Morning",
        sourceEnabled: true,
      }),
      "play",
    );
    assert.deepEqual(
      resolvePlayListTitleHandoffInstruction({
        plan,
        endpointKind: "list",
        layoutId: "playlist-title:Quiet Morning",
        sourceEnabled: true,
      }),
      {
        titleHoverVisual: "hold",
        titleHoverRetainLease: "timed",
      },
    );
    assert.deepEqual(
      resolvePlayListTitleHandoffInstruction({
        plan,
        endpointKind: "play",
        layoutId: "playlist-title:Quiet Morning",
        sourceEnabled: true,
      }),
      {
        titleHoverVisual: "retain",
        titleHoverRetainLease: "timed",
      },
    );
  });

  test("keeps return-to-play target retention stage-only and separate from list-to-play", () => {
    const plan = resolvePlayListTitleHandoffPlan({
      pageState: "play",
      endpoints: [nightDriveEndpoint, quietMorningEndpoint],
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      transition: {
        outgoingSourceLayoutId: null,
        returnTargetLayoutId: "playlist-title:Quiet Morning",
        committedLayoutId: null,
      },
      playbackSurface: null,
      titleReturnSurface: null,
    });

    assert.deepEqual(plan, {
      displayLock: {
        kind: "return-handoff",
        playlistName: "Quiet Morning",
      },
      arrow: {
        kind: "spectrum-to-play",
        source: {
          kind: "spectrum",
          layoutId: "playlist-title:Quiet Morning",
        },
        target: {
          kind: "play",
          layoutId: "playlist-title:Quiet Morning",
        },
        targetRetainLease: "stage-only",
      },
      sourceLayoutId: null,
      targetLayoutId: "playlist-title:Quiet Morning",
      targetRetainLease: "stage-only",
    });
    assert.deepEqual(
      resolvePlayListTitleHandoffInstruction({
        plan,
        endpointKind: "play",
        layoutId: "playlist-title:Quiet Morning",
        sourceEnabled: true,
      }),
      {
        titleHoverVisual: "retain",
        titleHoverRetainLease: "stage-only",
      },
    );
  });

  test("lets playback text remove title target retention once the track is restored", () => {
    const plan = resolvePlayListTitleHandoffPlan({
      pageState: "play",
      endpoints: [quietMorningEndpoint],
      playingPlaylistName: "Quiet Morning",
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      transition: {
        outgoingSourceLayoutId: null,
        returnTargetLayoutId: "playlist-title:Quiet Morning",
        committedLayoutId: null,
      },
      playbackSurface: {
        phase: "playing",
        playlistName: "Quiet Morning",
        displayedTrackName: "Track A",
        displayedTrackIsPlayable: true,
      },
      titleReturnSurface: null,
    });

    assert.deepEqual(plan, {
      displayLock: {
        kind: "playback-surface",
        playlistName: "Quiet Morning",
      },
      arrow: null,
      sourceLayoutId: null,
      targetLayoutId: null,
      targetRetainLease: "timed",
    });
  });

  test("scopes ready return handoff to consumed layout evidence", () => {
    const plan = resolvePlayListTitleHandoffPlan({
      pageState: "ready",
      endpoints: [quietMorningEndpoint],
      playingPlaylistName: null,
      titleToneHandoff: {
        layoutId: "playlist-title:Quiet Morning",
        tone: "solid",
      },
      transition: {
        outgoingSourceLayoutId: null,
        returnTargetLayoutId: "playlist-title:Quiet Morning",
        committedLayoutId: null,
      },
      playbackSurface: null,
      titleReturnSurface: {
        layoutId: "playlist-title:Quiet Morning",
      },
    });

    assert.deepEqual(plan, {
      displayLock: null,
      arrow: {
        kind: "config-to-list",
        source: null,
        target: {
          kind: "list",
          layoutId: "playlist-title:Quiet Morning",
        },
        targetRetainLease: "stage-only",
      },
      sourceLayoutId: null,
      targetLayoutId: "playlist-title:Quiet Morning",
      targetRetainLease: "stage-only",
    });
  });
});
