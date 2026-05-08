import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveMusicSpectrumContentFadeProps,
  resolveMusicSpectrumFloatingActionPlacementClassName,
  resolveMusicSpectrumResetActionFadeProps,
  resolveMusicSpectrumTitleFadeProps,
  resolveMusicSpectrumWaveformFadeProps,
} from "./MusicSpectrumEditor";

describe("MusicSpectrumEditor", () => {
  test("keeps shared title visible instead of applying page content fade", () => {
    assert.deepEqual(resolveMusicSpectrumTitleFadeProps({ hasSharedTitleLayout: true }), {
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
    assert.deepEqual(resolveMusicSpectrumTitleFadeProps({ hasSharedTitleLayout: false }), {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("delays non-primary editor content for cascade entry", () => {
    assert.deepEqual(resolveMusicSpectrumContentFadeProps({ cascade: true }), {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
        delay: 0.04,
      },
    });
  });

  test("fades admitted waveforms in without changing layout size", () => {
    assert.deepEqual(resolveMusicSpectrumWaveformFadeProps({ presentation: "interactive" }), {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: {
        duration: 0.36,
        ease: [0.22, 1, 0.36, 1],
      },
    });
  });

  test("keeps editor children visible when the page owns the exit fade", () => {
    const pageExitFade = {
      initial: false,
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: { duration: 0 },
    };

    assert.deepEqual(
      resolveMusicSpectrumTitleFadeProps({
        exitPresentation: "page",
        hasSharedTitleLayout: false,
      }),
      pageExitFade,
    );
    assert.deepEqual(
      resolveMusicSpectrumContentFadeProps({
        cascade: true,
        exitPresentation: "page",
      }),
      pageExitFade,
    );
    assert.deepEqual(
      resolveMusicSpectrumResetActionFadeProps({
        exitPresentation: "page",
      }),
      pageExitFade,
    );
  });

  test("places waveform floating actions on explicit canvas sides", () => {
    assert.equal(resolveMusicSpectrumFloatingActionPlacementClassName("start"), "left-12");
    assert.equal(resolveMusicSpectrumFloatingActionPlacementClassName("end"), "right-12");
  });
});
