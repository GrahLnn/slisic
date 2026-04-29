use super::waveform::{
    WaveformDecodeRange, WaveformPeak, WaveformPeakAccumulator, build_waveform_ffmpeg_args,
    quantize_waveform_peak, resolve_waveform_decode_range, resolve_waveform_level,
};
use std::path::Path;

#[test]
fn waveform_range_uses_bounded_duration_only_when_end_is_after_start() {
    assert_eq!(
        resolve_waveform_decode_range(Some(12), Some(45)),
        WaveformDecodeRange {
            start_ms: 12_000,
            duration_ms: Some(33_000),
        }
    );

    assert_eq!(
        resolve_waveform_decode_range(Some(12), Some(12)),
        WaveformDecodeRange {
            start_ms: 12_000,
            duration_ms: None,
        }
    );
}

#[test]
fn waveform_accumulator_keeps_negative_and_positive_peak_per_bucket() {
    let mut accumulator = WaveformPeakAccumulator::new(3);

    for sample in [0.2, -0.8, 0.4, 0.1, -0.3] {
        accumulator.push_sample(sample).unwrap();
    }

    assert_eq!(
        accumulator.finish(),
        vec![
            WaveformPeak {
                min: -0.8,
                max: 0.4,
            },
            WaveformPeak {
                min: -0.3,
                max: 0.1,
            },
        ]
    );
}

#[test]
fn waveform_level_uses_the_lowest_resolution_that_preserves_pixel_density() {
    assert_eq!(resolve_waveform_level(12, &[50, 100, 200, 400, 800]), 50);
    assert_eq!(resolve_waveform_level(192, &[50, 100, 200, 400, 800]), 200);
    assert_eq!(resolve_waveform_level(900, &[50, 100, 200, 400, 800]), 800);
}

#[test]
fn waveform_peak_quantization_keeps_signed_unit_range() {
    assert_eq!(quantize_waveform_peak(-1.2), -127);
    assert_eq!(quantize_waveform_peak(0.0), 0);
    assert_eq!(quantize_waveform_peak(1.2), 127);
}

#[test]
fn waveform_ffmpeg_args_seek_before_input_and_limit_bounded_output() {
    let args = build_waveform_ffmpeg_args(
        Path::new("C:/music/track.m4a"),
        WaveformDecodeRange {
            start_ms: 2_500,
            duration_ms: Some(8_000),
        },
    )
    .into_iter()
    .map(|value| value.to_string_lossy().to_string())
    .collect::<Vec<_>>();

    let seek_index = args.iter().position(|arg| arg == "-ss").unwrap();
    let input_index = args.iter().position(|arg| arg == "-i").unwrap();
    let duration_index = args.iter().position(|arg| arg == "-t").unwrap();
    let thread_index = args.iter().position(|arg| arg == "-threads").unwrap();

    assert!(thread_index < input_index);
    assert!(seek_index < input_index);
    assert!(duration_index > input_index);
    assert_eq!(args[seek_index + 1], "2.500");
    assert_eq!(args[duration_index + 1], "8.000");
    assert!(args.windows(2).any(|pair| pair == ["-f", "f32le"]));
}
