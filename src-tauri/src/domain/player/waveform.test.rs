use super::waveform::{
    WaveformDecodeRange, quantize_waveform_peak, resolve_waveform_decode_range,
    resolve_waveform_level, resolve_waveform_points_per_chunk, resolve_waveform_tile_point_range,
};

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
