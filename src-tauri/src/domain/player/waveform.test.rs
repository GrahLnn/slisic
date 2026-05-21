use super::waveform::{
    WaveformDecodeRange, WaveformPeak, WaveformPeakAccumulator, build_waveform_ffmpeg_args,
    quantize_waveform_peak, resolve_waveform_decode_range, resolve_waveform_level,
    resolve_waveform_points_per_chunk, resolve_waveform_tile_point_range,
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
    let levels = [50, 100, 200, 400, 800, 1600, 3200];

    assert_eq!(resolve_waveform_level(12, &levels), 50);
    assert_eq!(resolve_waveform_level(50, &levels), 50);
    assert_eq!(resolve_waveform_level(51, &levels), 100);
    assert_eq!(resolve_waveform_level(192, &levels), 200);
    assert_eq!(resolve_waveform_level(401, &levels), 800);
    assert_eq!(resolve_waveform_level(900, &levels), 1600);
    assert_eq!(resolve_waveform_level(1_601, &levels), 3200);
    assert_eq!(resolve_waveform_level(3_600, &levels), 3200);
}

#[test]
fn waveform_cache_chunks_are_large_enough_for_viewport_tile_reads() {
    assert_eq!(resolve_waveform_points_per_chunk(50), 3_000);
    assert_eq!(resolve_waveform_points_per_chunk(100), 6_000);
    assert_eq!(resolve_waveform_points_per_chunk(200), 12_000);
    assert_eq!(resolve_waveform_points_per_chunk(400), 24_000);
    assert_eq!(resolve_waveform_points_per_chunk(800), 48_000);
    assert_eq!(resolve_waveform_points_per_chunk(1600), 96_000);
    assert_eq!(resolve_waveform_points_per_chunk(3200), 192_000);
}

#[test]
fn waveform_tile_point_range_maps_display_pixels_to_source_points() {
    assert_eq!(
        resolve_waveform_tile_point_range(2_041, 0, 50.0, 50),
        super::waveform::WaveformTilePointRange {
            start_index: 2_041,
            end_index: 2_042,
        }
    );
    assert_eq!(
        resolve_waveform_tile_point_range(2_041, 0, 24.0, 50),
        super::waveform::WaveformTilePointRange {
            start_index: 4_252,
            end_index: 4_255,
        }
    );
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
    assert_eq!(args[thread_index + 1], "0");
    assert!(seek_index < input_index);
    assert!(duration_index > input_index);
    assert_eq!(args[seek_index + 1], "2.500");
    assert_eq!(args[duration_index + 1], "8.000");
    assert!(args.windows(2).any(|pair| {
        pair == [
            "-filter:a",
            "aresample=48000:filter_size=8:phase_shift=0:linear_interp=1",
        ]
    }));
    assert!(args.windows(2).any(|pair| pair == ["-f", "f32le"]));
}
