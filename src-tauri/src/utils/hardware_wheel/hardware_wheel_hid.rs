const RAW_HID_HORIZONTAL_WHEEL_REPORT_ID: u8 = 0x11;
const RAW_HID_HORIZONTAL_WHEEL_REPORT_KIND: u8 = 0x13;
const RAW_HID_HORIZONTAL_WHEEL_DELTA_UNIT: i32 = 120;

pub(super) fn resolve_raw_hid_horizontal_wheel_delta(report: &[u8]) -> Option<i32> {
    if report.len() < 6
        || report[0] != RAW_HID_HORIZONTAL_WHEEL_REPORT_ID
        || report[2] != RAW_HID_HORIZONTAL_WHEEL_REPORT_KIND
    {
        return None;
    }

    let steps = i16::from_le_bytes([report[4], report[5]]);

    if steps == 0 {
        None
    } else {
        Some(i32::from(steps.signum()) * RAW_HID_HORIZONTAL_WHEEL_DELTA_UNIT)
    }
}
