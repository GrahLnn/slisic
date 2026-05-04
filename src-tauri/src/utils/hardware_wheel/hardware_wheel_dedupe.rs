const HARDWARE_HORIZONTAL_WHEEL_DUPLICATE_WINDOW_MS: u128 = 32;
const HARDWARE_HORIZONTAL_WHEEL_DUPLICATE_POINT_TOLERANCE_PX: i64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum HardwareHorizontalWheelPacketSource {
    LowLevelHook,
    RawInput,
    RawInputHid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct HardwareHorizontalWheelPacketDedupeKey {
    pub(super) delta_x: i32,
    pub(super) point_x: i32,
    pub(super) point_y: i32,
    pub(super) source: HardwareHorizontalWheelPacketSource,
}

pub(super) fn is_duplicate_hardware_horizontal_wheel_packet(
    previous: HardwareHorizontalWheelPacketDedupeKey,
    next: HardwareHorizontalWheelPacketDedupeKey,
    elapsed_ms: u128,
) -> bool {
    let point_delta_x = (i64::from(previous.point_x) - i64::from(next.point_x)).abs();
    let point_delta_y = (i64::from(previous.point_y) - i64::from(next.point_y)).abs();

    previous.source != next.source
        && previous.delta_x == next.delta_x
        && elapsed_ms <= HARDWARE_HORIZONTAL_WHEEL_DUPLICATE_WINDOW_MS
        && point_delta_x <= HARDWARE_HORIZONTAL_WHEEL_DUPLICATE_POINT_TOLERANCE_PX
        && point_delta_y <= HARDWARE_HORIZONTAL_WHEEL_DUPLICATE_POINT_TOLERANCE_PX
}
