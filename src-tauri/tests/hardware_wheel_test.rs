mod hardware_wheel_dedupe {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/utils/hardware_wheel/hardware_wheel_dedupe.rs"
    ));
}

mod hardware_wheel_hid {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/utils/hardware_wheel/hardware_wheel_hid.rs"
    ));
}

use hardware_wheel_dedupe::{
    HardwareHorizontalWheelPacketDedupeKey, HardwareHorizontalWheelPacketSource,
    is_duplicate_hardware_horizontal_wheel_packet,
};
use hardware_wheel_hid::resolve_raw_hid_horizontal_wheel_delta;

fn packet_key(
    source: HardwareHorizontalWheelPacketSource,
    delta_x: i32,
) -> HardwareHorizontalWheelPacketDedupeKey {
    HardwareHorizontalWheelPacketDedupeKey {
        delta_x,
        point_x: 320,
        point_y: 240,
        source,
    }
}

#[test]
fn treats_same_hardware_packet_from_both_windows_sources_as_duplicate() {
    let previous = packet_key(HardwareHorizontalWheelPacketSource::LowLevelHook, 120);
    let next = packet_key(HardwareHorizontalWheelPacketSource::RawInput, 120);

    assert!(is_duplicate_hardware_horizontal_wheel_packet(
        previous, next, 4
    ));
}

#[test]
fn keeps_repeated_packets_from_the_same_source_distinct() {
    let previous = packet_key(HardwareHorizontalWheelPacketSource::LowLevelHook, 120);
    let next = packet_key(HardwareHorizontalWheelPacketSource::LowLevelHook, 120);

    assert!(!is_duplicate_hardware_horizontal_wheel_packet(
        previous, next, 4
    ));
}

#[test]
fn keeps_delayed_or_direction_changed_packets_distinct() {
    let previous = packet_key(HardwareHorizontalWheelPacketSource::LowLevelHook, 120);
    let reversed = packet_key(HardwareHorizontalWheelPacketSource::RawInput, -120);
    let delayed = packet_key(HardwareHorizontalWheelPacketSource::RawInput, 120);

    assert!(!is_duplicate_hardware_horizontal_wheel_packet(
        previous, reversed, 4
    ));
    assert!(!is_duplicate_hardware_horizontal_wheel_packet(
        previous, delayed, 64
    ));
}

#[test]
fn treats_raw_hid_source_as_a_duplicate_of_standard_windows_packets() {
    let previous = packet_key(HardwareHorizontalWheelPacketSource::RawInputHid, 120);
    let next = packet_key(HardwareHorizontalWheelPacketSource::RawInput, 120);

    assert!(is_duplicate_hardware_horizontal_wheel_packet(
        previous, next, 4
    ));
}

#[test]
fn resolves_raw_hid_horizontal_wheel_direction_without_exposing_device_brand() {
    let right = [
        0x11, 0x02, 0x13, 0x00, 0x02, 0x00, 0x03, 0x00, 0x02, 0x02, 0x00, 0x00,
    ];
    let left = [
        0x11, 0x02, 0x13, 0x00, 0xfe, 0xff, 0x03, 0x00, 0x02, 0x02, 0x00, 0x00,
    ];

    assert_eq!(resolve_raw_hid_horizontal_wheel_delta(&right), Some(120));
    assert_eq!(resolve_raw_hid_horizontal_wheel_delta(&left), Some(-120));
    assert_eq!(resolve_raw_hid_horizontal_wheel_delta(&right[..4]), None);
}
