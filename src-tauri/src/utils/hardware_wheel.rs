//! Windows hardware wheel probe.
//!
//! This module owns only the window-scoped hardware fact: "Windows reported a
//! horizontal hardware-wheel packet while the pointer was inside one of this
//! app's windows". It never consumes the native input and never translates
//! deltas into spectrum viewport coordinates. Component-level ownership stays
//! inside the spectrum component.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::WebviewWindow;
use tauri_specta::Event;

#[cfg(target_os = "windows")]
mod hardware_wheel_dedupe;
#[cfg(target_os = "windows")]
mod hardware_wheel_hid;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct HardwareHorizontalWheelEvent {
    pub client_x: f64,
    pub client_y: f64,
    pub delta_x: i32,
    pub wheel_delta_unit: i32,
    pub window_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HardwareHorizontalWheelTraceEntry {
    pub elapsed_ms: u64,
    pub event: String,
    pub payload_json: String,
    pub seq: u64,
    pub thread: String,
    pub unix_ms: u64,
}

const HARDWARE_HORIZONTAL_WHEEL_TRACE_LIMIT: usize = 20_000;

fn hardware_horizontal_wheel_trace_entries()
-> &'static Mutex<VecDeque<HardwareHorizontalWheelTraceEntry>> {
    static HARDWARE_HORIZONTAL_WHEEL_TRACE_ENTRIES: OnceLock<
        Mutex<VecDeque<HardwareHorizontalWheelTraceEntry>>,
    > = OnceLock::new();
    HARDWARE_HORIZONTAL_WHEEL_TRACE_ENTRIES.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn hardware_horizontal_wheel_trace_start() -> &'static Instant {
    static HARDWARE_HORIZONTAL_WHEEL_TRACE_START: OnceLock<Instant> = OnceLock::new();
    HARDWARE_HORIZONTAL_WHEEL_TRACE_START.get_or_init(Instant::now)
}

fn hardware_horizontal_wheel_trace_seq() -> &'static AtomicU64 {
    static HARDWARE_HORIZONTAL_WHEEL_TRACE_SEQ: AtomicU64 = AtomicU64::new(0);
    &HARDWARE_HORIZONTAL_WHEEL_TRACE_SEQ
}

fn record_hardware_horizontal_wheel_trace(event: &str, payload: serde_json::Value) {
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let entry = HardwareHorizontalWheelTraceEntry {
        elapsed_ms: hardware_horizontal_wheel_trace_start()
            .elapsed()
            .as_millis() as u64,
        event: event.to_string(),
        payload_json: payload.to_string(),
        seq: hardware_horizontal_wheel_trace_seq().fetch_add(1, Ordering::Relaxed),
        thread: format!("{:?}", std::thread::current().id()),
        unix_ms,
    };

    if let Ok(mut entries) = hardware_horizontal_wheel_trace_entries().lock() {
        entries.push_back(entry);
        while entries.len() > HARDWARE_HORIZONTAL_WHEEL_TRACE_LIMIT {
            entries.pop_front();
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_hardware_horizontal_wheel_trace_entries() -> Vec<HardwareHorizontalWheelTraceEntry> {
    hardware_horizontal_wheel_trace_entries()
        .lock()
        .map(|entries| entries.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
#[specta::specta]
pub fn clear_hardware_horizontal_wheel_trace() {
    if let Ok(mut entries) = hardware_horizontal_wheel_trace_entries().lock() {
        entries.clear();
    }
    hardware_horizontal_wheel_trace_seq().store(0, Ordering::Relaxed);
    record_hardware_horizontal_wheel_trace("trace-cleared", serde_json::json!({}));
}

#[cfg(target_os = "windows")]
mod platform {
    use serde_json::json;
    use std::collections::HashMap;
    use std::mem;
    use std::ptr;
    use std::sync::mpsc::{self, SyncSender, TrySendError};
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use std::time::Instant;
    use tauri::{Manager, WebviewWindow};
    use tauri_specta::Event;
    use windows_sys::Win32::Devices::HumanInterfaceDevice::{
        HID_USAGE_GENERIC_MOUSE, HID_USAGE_PAGE_GENERIC, HID_USAGE_PAGE_VENDOR_DEFINED_BEGIN,
    };
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, GetRawInputDeviceInfoW, HRAWINPUT, RAWHID, RAWINPUT, RAWINPUTDEVICE,
        RAWINPUTHEADER, RID_DEVICE_INFO, RID_INPUT, RIDEV_INPUTSINK, RIDI_DEVICEINFO,
        RIDI_DEVICENAME, RIM_TYPEHID, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, EnumChildWindows, GA_ROOT, GetAncestor, GetClassNameW,
        GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowThreadProcessId, HC_ACTION,
        HHOOK, IsChild, IsWindow, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW,
        PostThreadMessageW, RI_MOUSE_HWHEEL, RI_MOUSE_WHEEL, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, WH_MOUSE_LL, WHEEL_DELTA, WM_INPUT, WM_MOUSEHWHEEL, WM_MOUSEWHEEL,
        WM_NCDESTROY, WM_QUIT, WindowFromPoint,
    };

    const HARDWARE_HORIZONTAL_WHEEL_SUBCLASS_ID: usize = 0x7261_6E73_4857;
    const RAW_INPUT_VENDOR_DEFINED_HID_USAGES: [u16; 2] = [1, 2];

    use super::{
        HardwareHorizontalWheelEvent,
        hardware_wheel_dedupe::{
            HardwareHorizontalWheelPacketDedupeKey, HardwareHorizontalWheelPacketSource,
            is_duplicate_hardware_horizontal_wheel_packet,
        },
        hardware_wheel_hid::resolve_raw_hid_horizontal_wheel_delta,
        record_hardware_horizontal_wheel_trace,
    };

    struct HardwareHorizontalWheelMonitor {
        app: tauri::AppHandle,
        window_label: String,
    }

    #[derive(Clone)]
    struct HardwareHorizontalWheelTarget {
        app: tauri::AppHandle,
        window_label: String,
    }

    #[derive(Clone, Copy)]
    struct HardwareHorizontalWheelPacket {
        delta_x: i32,
        point: POINT,
        source: HardwareHorizontalWheelPacketSource,
    }

    impl HardwareHorizontalWheelPacket {
        fn dedupe_key(self) -> HardwareHorizontalWheelPacketDedupeKey {
            HardwareHorizontalWheelPacketDedupeKey {
                delta_x: self.delta_x,
                point_x: self.point.x,
                point_y: self.point.y,
                source: self.source,
            }
        }
    }

    #[derive(Clone, Copy)]
    struct QueuedHardwareHorizontalWheelPacket {
        key: HardwareHorizontalWheelPacketDedupeKey,
        queued_at: Instant,
    }

    struct HardwareHorizontalWheelHook {
        handle: HHOOK,
        thread_id: u32,
    }

    struct RawInputBuffer {
        words: Vec<usize>,
    }

    impl RawInputBuffer {
        fn as_raw_input(&self) -> &RAWINPUT {
            unsafe { &*(self.words.as_ptr() as *const RAWINPUT) }
        }
    }

    unsafe impl Send for HardwareHorizontalWheelHook {}

    impl Drop for HardwareHorizontalWheelHook {
        fn drop(&mut self) {
            let _ = unsafe { UnhookWindowsHookEx(self.handle) };
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
        }
    }

    fn monitored_windows() -> &'static Mutex<HashMap<isize, usize>> {
        static MONITORED_WINDOWS: OnceLock<Mutex<HashMap<isize, usize>>> = OnceLock::new();
        MONITORED_WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn hardware_horizontal_wheel_hook() -> &'static Mutex<Option<HardwareHorizontalWheelHook>> {
        static HARDWARE_HORIZONTAL_WHEEL_HOOK: OnceLock<
            Mutex<Option<HardwareHorizontalWheelHook>>,
        > = OnceLock::new();
        HARDWARE_HORIZONTAL_WHEEL_HOOK.get_or_init(|| Mutex::new(None))
    }

    fn raw_input_sink_hwnd() -> &'static Mutex<Option<isize>> {
        static RAW_INPUT_SINK_HWND: OnceLock<Mutex<Option<isize>>> = OnceLock::new();
        RAW_INPUT_SINK_HWND.get_or_init(|| Mutex::new(None))
    }

    fn clear_raw_input_sink_if_matches(hwnd: HWND) {
        let Ok(mut sink) = raw_input_sink_hwnd().lock() else {
            return;
        };

        if sink.is_some_and(|sink_hwnd| sink_hwnd == hwnd as isize) {
            *sink = None;
            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.sink-cleared",
                json!({
                    "hwnd": trace_hwnd(hwnd),
                }),
            );
        }
    }

    fn hardware_horizontal_wheel_recent_standard_state()
    -> &'static Mutex<Option<QueuedHardwareHorizontalWheelPacket>> {
        static HARDWARE_HORIZONTAL_WHEEL_RECENT_STANDARD_STATE: OnceLock<
            Mutex<Option<QueuedHardwareHorizontalWheelPacket>>,
        > = OnceLock::new();
        HARDWARE_HORIZONTAL_WHEEL_RECENT_STANDARD_STATE.get_or_init(|| Mutex::new(None))
    }

    fn hardware_horizontal_wheel_packet_sender()
    -> &'static OnceLock<SyncSender<HardwareHorizontalWheelPacket>> {
        static HARDWARE_HORIZONTAL_WHEEL_PACKET_SENDER: OnceLock<
            SyncSender<HardwareHorizontalWheelPacket>,
        > = OnceLock::new();
        &HARDWARE_HORIZONTAL_WHEEL_PACKET_SENDER
    }

    fn signed_high_word(value: usize) -> i16 {
        ((value >> 16) & 0xffff) as u16 as i16
    }

    fn point_is_inside_rect(point: POINT, rect: RECT) -> bool {
        point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
    }

    fn emit_hardware_horizontal_wheel_event_at_client_point(
        target: &HardwareHorizontalWheelTarget,
        client_x: f64,
        client_y: f64,
        delta_x: i32,
    ) {
        let Some(window) = target.app.get_webview_window(&target.window_label) else {
            record_hardware_horizontal_wheel_trace(
                "backend.emit.window-missing",
                json!({
                    "deltaX": delta_x,
                    "targetWindowLabel": target.window_label,
                }),
            );
            return;
        };
        let event = HardwareHorizontalWheelEvent {
            client_x,
            client_y,
            delta_x,
            wheel_delta_unit: WHEEL_DELTA as i32,
            window_label: target.window_label.clone(),
        };

        record_hardware_horizontal_wheel_trace(
            "backend.emit.before",
            json!({
                "clientX": client_x,
                "clientY": client_y,
                "deltaX": delta_x,
                "targetWindowLabel": target.window_label,
            }),
        );
        let _ = event.emit(&window);
    }

    unsafe fn monitor_from_ref_data(ref_data: usize) -> &'static HardwareHorizontalWheelMonitor {
        unsafe {
            (ref_data as *const HardwareHorizontalWheelMonitor)
                .as_ref()
                .unwrap()
        }
    }

    fn take_monitor(hwnd: HWND) -> Option<usize> {
        monitored_windows()
            .lock()
            .ok()
            .and_then(|mut monitored| monitored.remove(&(hwnd as isize)))
    }

    unsafe fn drop_monitor(monitor: usize) {
        let _ = unsafe { Box::from_raw(monitor as *mut HardwareHorizontalWheelMonitor) };
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buffer = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };

        if len <= 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buffer[..len as usize])
    }

    fn trace_point(point: POINT) -> serde_json::Value {
        json!({
            "x": point.x,
            "y": point.y,
        })
    }

    fn trace_hwnd(hwnd: HWND) -> serde_json::Value {
        json!({
            "class": class_name(hwnd),
            "hwnd": format!("0x{:x}", hwnd as usize),
            "isNull": hwnd.is_null(),
        })
    }

    fn trace_process_hwnd(hwnd: HWND) -> serde_json::Value {
        let mut process_id = 0u32;
        let thread_id = if hwnd.is_null() {
            0
        } else {
            unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) }
        };

        json!({
            "class": class_name(hwnd),
            "hwnd": format!("0x{:x}", hwnd as usize),
            "isCurrentProcess": thread_id != 0 && process_id == unsafe { GetCurrentProcessId() },
            "isNull": hwnd.is_null(),
            "processId": process_id,
            "root": trace_hwnd(root_hwnd(hwnd)),
            "threadId": thread_id,
        })
    }

    fn trace_pointer_context(point: POINT) -> serde_json::Value {
        let foreground_hwnd = unsafe { GetForegroundWindow() };
        let hit_hwnd = unsafe { WindowFromPoint(point) };

        json!({
            "foregroundHwnd": trace_process_hwnd(foreground_hwnd),
            "hitHwnd": trace_process_hwnd(hit_hwnd),
            "point": trace_point(point),
        })
    }

    fn raw_input_device_name(device: windows_sys::Win32::Foundation::HANDLE) -> Option<String> {
        if device.is_null() {
            return None;
        }

        let mut minimum_size = 0u32;
        let status = unsafe {
            GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, ptr::null_mut(), &mut minimum_size)
        };

        if status != 0 || minimum_size == 0 {
            return None;
        }

        let mut name = Vec::<u16>::with_capacity(minimum_size as usize);
        let status = unsafe {
            GetRawInputDeviceInfoW(
                device,
                RIDI_DEVICENAME,
                name.as_mut_ptr() as *mut _,
                &mut minimum_size,
            )
        };

        if status == u32::MAX || status == 0 {
            return None;
        }

        unsafe { name.set_len(minimum_size as usize) };
        let end = name
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(name.len());
        Some(String::from_utf16_lossy(&name[..end]))
    }

    fn raw_input_device_info(
        device: windows_sys::Win32::Foundation::HANDLE,
    ) -> Option<serde_json::Value> {
        if device.is_null() {
            return None;
        }

        let mut info = RID_DEVICE_INFO::default();
        info.cbSize = mem::size_of::<RID_DEVICE_INFO>() as u32;
        let mut info_size = info.cbSize;
        let status = unsafe {
            GetRawInputDeviceInfoW(
                device,
                RIDI_DEVICEINFO,
                &mut info as *mut _ as *mut _,
                &mut info_size,
            )
        };

        if status == u32::MAX || status == 0 {
            return None;
        }

        Some(match info.dwType {
            RIM_TYPEMOUSE => {
                let mouse = unsafe { info.Anonymous.mouse };
                json!({
                    "fHasHorizontalWheel": mouse.fHasHorizontalWheel != 0,
                    "kind": "mouse",
                    "mouseId": mouse.dwId,
                    "numberOfButtons": mouse.dwNumberOfButtons,
                    "sampleRate": mouse.dwSampleRate,
                })
            }
            RIM_TYPEKEYBOARD => {
                let keyboard = unsafe { info.Anonymous.keyboard };
                json!({
                    "functionKeys": keyboard.dwNumberOfFunctionKeys,
                    "indicators": keyboard.dwNumberOfIndicators,
                    "kind": "keyboard",
                    "keyboardMode": keyboard.dwKeyboardMode,
                    "numberOfKeysTotal": keyboard.dwNumberOfKeysTotal,
                    "subType": keyboard.dwSubType,
                    "type": keyboard.dwType,
                })
            }
            RIM_TYPEHID => {
                let hid = unsafe { info.Anonymous.hid };
                json!({
                    "kind": "hid",
                    "productId": hid.dwProductId,
                    "usage": hid.usUsage,
                    "usagePage": hid.usUsagePage,
                    "vendorId": hid.dwVendorId,
                    "versionNumber": hid.dwVersionNumber,
                })
            }
            other => json!({
                "kind": "unknown",
                "type": other,
            }),
        })
    }

    fn trace_raw_input_device(device: windows_sys::Win32::Foundation::HANDLE) -> serde_json::Value {
        json!({
            "handle": format!("0x{:x}", device as usize),
            "info": raw_input_device_info(device),
            "name": raw_input_device_name(device),
        })
    }

    fn trace_packet(packet: HardwareHorizontalWheelPacket) -> serde_json::Value {
        json!({
            "deltaX": packet.delta_x,
            "point": trace_point(packet.point),
            "source": match packet.source {
                HardwareHorizontalWheelPacketSource::LowLevelHook => "low-level-hook",
                HardwareHorizontalWheelPacketSource::RawInput => "raw-input",
                HardwareHorizontalWheelPacketSource::RawInputHid => "raw-input-hid",
            },
        })
    }

    fn read_cursor_point() -> Option<POINT> {
        let mut point = POINT::default();

        (unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) } != 0)
            .then_some(point)
    }

    fn raw_hid_ref(raw_input: &RAWINPUT) -> &RAWHID {
        unsafe { &*ptr::addr_of!(raw_input.data.hid) }
    }

    fn raw_hid_report_bytes(raw_input: &RAWINPUT) -> Vec<u8> {
        let hid = raw_hid_ref(raw_input);
        let byte_len = hid.dwSizeHid.saturating_mul(hid.dwCount) as usize;

        if byte_len == 0 {
            return Vec::new();
        }

        let first_byte = ptr::addr_of!(hid.bRawData) as *const u8;
        unsafe { std::slice::from_raw_parts(first_byte, byte_len).to_vec() }
    }

    fn hex_bytes(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);

        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }

        output
    }

    fn trace_low_level_mouse(message: u32, hook: &MSLLHOOKSTRUCT) -> serde_json::Value {
        json!({
            "context": trace_pointer_context(hook.pt),
            "delta": i32::from(signed_high_word(hook.mouseData as usize)),
            "flags": hook.flags,
            "mouseData": format!("0x{:x}", hook.mouseData),
            "point": trace_point(hook.pt),
            "time": hook.time,
            "message": message,
            "messageName": match message {
                WM_MOUSEHWHEEL => "WM_MOUSEHWHEEL",
                WM_MOUSEWHEEL => "WM_MOUSEWHEEL",
                _ => "other",
            },
        })
    }

    fn root_hwnd(hwnd: HWND) -> HWND {
        unsafe { GetAncestor(hwnd, GA_ROOT) }
    }

    fn hwnd_belongs_to_monitor(root: HWND, child: HWND, monitored_hwnd: HWND) -> bool {
        monitored_hwnd == root
            || monitored_hwnd == child
            || unsafe { IsChild(monitored_hwnd, child) != 0 }
            || unsafe { IsChild(monitored_hwnd, root) != 0 }
            || unsafe { IsChild(root, monitored_hwnd) != 0 }
    }

    fn monitor_target_from_ref_data(ref_data: usize) -> HardwareHorizontalWheelTarget {
        let monitor = unsafe { monitor_from_ref_data(ref_data) };

        HardwareHorizontalWheelTarget {
            app: monitor.app.clone(),
            window_label: monitor.window_label.clone(),
        }
    }

    fn target_for_related_hit_hwnd(
        hit_hwnd: HWND,
    ) -> Option<(HWND, HardwareHorizontalWheelTarget)> {
        if hit_hwnd.is_null() {
            return None;
        }

        let root = root_hwnd(hit_hwnd);
        let monitored = monitored_windows().lock().ok()?;

        if let Some(monitor) = monitored.get(&(hit_hwnd as isize)) {
            return Some((hit_hwnd, monitor_target_from_ref_data(*monitor)));
        }

        let child_match = monitored.iter().find_map(|(hwnd, monitor)| {
            let monitored_hwnd = *hwnd as HWND;
            hwnd_belongs_to_monitor(root, hit_hwnd, monitored_hwnd)
                .then(|| (monitored_hwnd, monitor_target_from_ref_data(*monitor)))
        });

        if child_match.is_some() {
            return child_match;
        }

        if !root.is_null() {
            if let Some(monitor) = monitored.get(&(root as isize)) {
                return Some((root, monitor_target_from_ref_data(*monitor)));
            }
        }

        None
    }

    fn hit_hwnd_belongs_to_current_process(hit_hwnd: HWND) -> bool {
        if hit_hwnd.is_null() {
            return false;
        }

        let mut process_id = 0u32;
        let thread_id = unsafe { GetWindowThreadProcessId(hit_hwnd, &mut process_id) };

        thread_id != 0 && process_id == unsafe { GetCurrentProcessId() }
    }

    fn target_for_window_rect(point: POINT) -> Option<(HWND, HardwareHorizontalWheelTarget)> {
        let monitored = monitored_windows().lock().ok()?;

        monitored
            .iter()
            .filter_map(|(hwnd, monitor)| {
                let monitored_hwnd = *hwnd as HWND;
                let mut rect = RECT::default();
                let has_rect = unsafe { GetWindowRect(monitored_hwnd, &mut rect) } != 0;

                if !has_rect || !point_is_inside_rect(point, rect) {
                    return None;
                }

                let width = i64::from((rect.right - rect.left).max(1));
                let height = i64::from((rect.bottom - rect.top).max(1));

                Some((
                    width * height,
                    monitored_hwnd,
                    monitor_target_from_ref_data(*monitor),
                ))
            })
            .min_by_key(|(area, _, _)| *area)
            .map(|(_, hwnd, target)| (hwnd, target))
    }

    fn target_for_screen_point(
        point: POINT,
    ) -> Option<(HWND, HardwareHorizontalWheelTarget, &'static str)> {
        let hit_hwnd = unsafe { WindowFromPoint(point) };

        record_hardware_horizontal_wheel_trace(
            "backend.hit.start",
            json!({
                "hitHwnd": trace_hwnd(hit_hwnd),
                "point": trace_point(point),
            }),
        );

        if let Some((client_hwnd, target)) = target_for_related_hit_hwnd(hit_hwnd) {
            return Some((client_hwnd, target, "hwnd-tree"));
        }

        if hit_hwnd_belongs_to_current_process(hit_hwnd) {
            return target_for_window_rect(point)
                .map(|(client_hwnd, target)| (client_hwnd, target, "process-rect"));
        }

        None
    }

    fn emit_hardware_horizontal_wheel_event_from_screen_point(
        target: &HardwareHorizontalWheelTarget,
        client_hwnd: HWND,
        hit_reason: &str,
        point: POINT,
        delta_x: i32,
    ) {
        let Some(window) = target.app.get_webview_window(&target.window_label) else {
            record_hardware_horizontal_wheel_trace(
                "backend.emit-screen.window-missing",
                json!({
                    "deltaX": delta_x,
                    "hitReason": hit_reason,
                    "point": trace_point(point),
                    "targetWindowLabel": target.window_label,
                }),
            );
            return;
        };
        let scale_factor = window
            .scale_factor()
            .ok()
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0);
        let mut client_point = point;
        let point_is_client = unsafe { ScreenToClient(client_hwnd, &mut client_point) } != 0;
        let client_x = if point_is_client {
            f64::from(client_point.x) / scale_factor
        } else {
            f64::NAN
        };
        let client_y = if point_is_client {
            f64::from(client_point.y) / scale_factor
        } else {
            f64::NAN
        };

        record_hardware_horizontal_wheel_trace(
            "backend.emit-screen.resolved",
            json!({
                "clientHwnd": trace_hwnd(client_hwnd),
                "clientPoint": trace_point(client_point),
                "clientX": client_x,
                "clientY": client_y,
                "deltaX": delta_x,
                "hitReason": hit_reason,
                "point": trace_point(point),
                "pointIsClient": point_is_client,
                "scaleFactor": scale_factor,
                "targetWindowLabel": target.window_label,
            }),
        );
        emit_hardware_horizontal_wheel_event_at_client_point(target, client_x, client_y, delta_x);
    }

    fn handle_hardware_horizontal_wheel_packet(packet: HardwareHorizontalWheelPacket) {
        let Some((client_hwnd, target, hit_reason)) = target_for_screen_point(packet.point) else {
            record_hardware_horizontal_wheel_trace(
                "backend.packet.no-target",
                trace_packet(packet),
            );
            return;
        };

        record_hardware_horizontal_wheel_trace(
            "backend.packet.target",
            json!({
                "clientHwnd": trace_hwnd(client_hwnd),
                "hitReason": hit_reason,
                "packet": trace_packet(packet),
                "targetWindowLabel": target.window_label,
            }),
        );
        emit_hardware_horizontal_wheel_event_from_screen_point(
            &target,
            client_hwnd,
            hit_reason,
            packet.point,
            packet.delta_x,
        );
    }

    fn send_hardware_horizontal_wheel_packet(packet: HardwareHorizontalWheelPacket) {
        record_hardware_horizontal_wheel_trace("backend.packet.queue", trace_packet(packet));
        if let Some(sender) = hardware_horizontal_wheel_packet_sender().get() {
            match sender.try_send(packet) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    record_hardware_horizontal_wheel_trace(
                        "backend.packet.queue-full",
                        trace_packet(packet),
                    );
                }
                Err(TrySendError::Disconnected(_)) => {
                    record_hardware_horizontal_wheel_trace(
                        "backend.packet.queue-disconnected",
                        trace_packet(packet),
                    );
                    eprintln!("[hardwareHorizontalWheel] packet worker disconnected");
                }
            }
        }
    }

    fn queue_hardware_horizontal_wheel_packet(packet: HardwareHorizontalWheelPacket) {
        // Raw Input and WH_MOUSE_LL can report the same wheel detent, but Raw
        // Input readiness is not a license to suppress the hook. Some WebView
        // cold starts deliver the hook before the raw-input stream is alive;
        // the queue therefore deduplicates facts instead of letting either
        // source disable the other.
        let key = packet.dedupe_key();
        let now = Instant::now();

        if let Ok(mut state) = hardware_horizontal_wheel_recent_standard_state().lock() {
            if state.as_ref().is_some_and(|previous| {
                is_duplicate_hardware_horizontal_wheel_packet(
                    previous.key,
                    key,
                    now.duration_since(previous.queued_at).as_millis(),
                )
            }) {
                record_hardware_horizontal_wheel_trace(
                    "backend.packet.duplicate",
                    trace_packet(packet),
                );
                return;
            }

            *state = Some(QueuedHardwareHorizontalWheelPacket {
                key,
                queued_at: now,
            });
        }

        send_hardware_horizontal_wheel_packet(packet);
    }

    unsafe extern "system" fn hardware_horizontal_wheel_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 && matches!(wparam as u32, WM_MOUSEHWHEEL | WM_MOUSEWHEEL) {
            let hook = unsafe { (lparam as *const MSLLHOOKSTRUCT).as_ref() };

            if let Some(hook) = hook {
                record_hardware_horizontal_wheel_trace(
                    "backend.low-level.mouse-wheel-message",
                    trace_low_level_mouse(wparam as u32, hook),
                );
            }
        }

        if code == HC_ACTION as i32 && wparam as u32 == WM_MOUSEHWHEEL {
            let hook = unsafe { (lparam as *const MSLLHOOKSTRUCT).as_ref() };

            if let Some(hook) = hook {
                record_hardware_horizontal_wheel_trace(
                    "backend.source.low-level",
                    trace_low_level_mouse(wparam as u32, hook),
                );
                queue_hardware_horizontal_wheel_packet(HardwareHorizontalWheelPacket {
                    delta_x: i32::from(signed_high_word(hook.mouseData as usize)),
                    point: hook.pt,
                    source: HardwareHorizontalWheelPacketSource::LowLevelHook,
                });
            }
        }

        unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) }
    }

    fn spawn_packet_worker() -> Result<(), String> {
        if hardware_horizontal_wheel_packet_sender().get().is_some() {
            record_hardware_horizontal_wheel_trace("backend.worker.already-started", json!({}));
            return Ok(());
        }

        let (sender, receiver) = mpsc::sync_channel(512);
        hardware_horizontal_wheel_packet_sender()
            .set(sender)
            .map_err(|_| "hardware wheel packet sender already initialized".to_string())?;

        thread::Builder::new()
            .name("hardware-horizontal-wheel-worker".to_string())
            .spawn(move || {
                record_hardware_horizontal_wheel_trace("backend.worker.started", json!({}));
                while let Ok(packet) = receiver.recv() {
                    handle_hardware_horizontal_wheel_packet(packet);
                }
            })
            .map_err(|error| {
                format!("failed to spawn hardware horizontal wheel packet worker: {error}")
            })?;

        Ok(())
    }

    fn spawn_hook_thread() -> Result<(u32, HHOOK), String> {
        let (sender, receiver) = mpsc::sync_channel(1);

        thread::Builder::new()
            .name("hardware-horizontal-wheel-hook".to_string())
            .spawn(move || {
                let thread_id = unsafe { GetCurrentThreadId() };
                let mut message = MSG::default();
                let _ = unsafe { PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_NOREMOVE) };
                let module = unsafe { GetModuleHandleW(ptr::null()) };
                let handle = unsafe {
                    SetWindowsHookExW(
                        WH_MOUSE_LL,
                        Some(hardware_horizontal_wheel_hook_proc),
                        module,
                        0,
                    )
                };

                if handle.is_null() {
                    record_hardware_horizontal_wheel_trace(
                        "backend.low-level.install-failed",
                        json!({}),
                    );
                    let _ = sender.send(Err(
                        "failed to install hardware horizontal wheel low-level hook".to_string(),
                    ));
                    return;
                }

                record_hardware_horizontal_wheel_trace(
                    "backend.low-level.installed",
                    json!({
                        "threadId": thread_id,
                    }),
                );
                let _ = sender.send(Ok((thread_id, handle as usize)));

                while unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } > 0 {
                    unsafe {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
            })
            .map_err(|error| {
                format!("failed to spawn hardware horizontal wheel hook thread: {error}")
            })?;

        receiver
            .recv()
            .map_err(|error| {
                format!("failed to receive hardware horizontal wheel hook handle: {error}")
            })?
            .map(|(thread_id, handle)| (thread_id, handle as HHOOK))
    }

    fn install_low_level_hook() -> Result<(), String> {
        let mut hook_slot = hardware_horizontal_wheel_hook()
            .lock()
            .map_err(|_| "hardware wheel hook state poisoned".to_string())?;

        if hook_slot.is_some() {
            return Ok(());
        }

        spawn_packet_worker()?;
        let (thread_id, handle) = spawn_hook_thread()?;

        *hook_slot = Some(HardwareHorizontalWheelHook { handle, thread_id });
        Ok(())
    }

    fn install_packet_workers() -> Result<(), String> {
        spawn_packet_worker()?;
        Ok(())
    }

    fn read_raw_input(lparam: LPARAM) -> Option<RawInputBuffer> {
        let mut data_size = 0u32;
        let header_size = mem::size_of::<RAWINPUTHEADER>() as u32;
        let status = unsafe {
            GetRawInputData(
                lparam as HRAWINPUT,
                RID_INPUT,
                ptr::null_mut(),
                &mut data_size,
                header_size,
            )
        };

        if status == u32::MAX || data_size == 0 {
            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.read-failed",
                json!({
                    "dataSize": data_size,
                    "status": status,
                }),
            );
            return None;
        }

        let word_size = mem::size_of::<usize>();
        let word_len = (data_size as usize).div_ceil(word_size);
        let mut words = vec![0usize; word_len];
        let status = unsafe {
            GetRawInputData(
                lparam as HRAWINPUT,
                RID_INPUT,
                words.as_mut_ptr() as *mut _,
                &mut data_size,
                header_size,
            )
        };

        if status == u32::MAX || status == 0 {
            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.read-failed",
                json!({
                    "dataSize": data_size,
                    "status": status,
                }),
            );
            return None;
        }

        Some(RawInputBuffer { words })
    }

    fn queue_raw_input_horizontal_wheel(lparam: LPARAM) {
        let Some(raw_input_buffer) = read_raw_input(lparam) else {
            return;
        };
        let raw_input = raw_input_buffer.as_raw_input();

        if raw_input.header.dwType != RIM_TYPEMOUSE {
            queue_raw_hid_horizontal_wheel(raw_input);
            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.not-mouse",
                json!({
                    "device": trace_raw_input_device(raw_input.header.hDevice),
                    "dwType": raw_input.header.dwType,
                    "rawInputHeaderWparam": raw_input.header.wParam,
                }),
            );
            return;
        }

        let mouse = unsafe { raw_input.data.mouse };
        let buttons = unsafe { mouse.Anonymous.Anonymous };
        let cursor_point = read_cursor_point();
        let point = cursor_point.unwrap_or_default();
        let has_point = cursor_point.is_some();
        let pointer_context = has_point.then(|| trace_pointer_context(point));
        let raw_trace = json!({
            "buttonData": buttons.usButtonData,
            "buttonFlags": buttons.usButtonFlags,
            "cursorPoint": has_point.then(|| trace_point(point)),
            "isHorizontalWheel": buttons.usButtonFlags & RI_MOUSE_HWHEEL as u16 != 0,
            "isVerticalWheel": buttons.usButtonFlags & RI_MOUSE_WHEEL as u16 != 0,
            "lastX": mouse.lLastX,
            "lastY": mouse.lLastY,
            "pointerContext": pointer_context,
            "rawButtons": mouse.ulRawButtons,
            "rawInputDevice": trace_raw_input_device(raw_input.header.hDevice),
            "rawInputHeaderDevice": format!("0x{:x}", raw_input.header.hDevice as usize),
            "rawInputHeaderWparam": raw_input.header.wParam,
            "usFlags": mouse.usFlags,
        });

        record_hardware_horizontal_wheel_trace("backend.raw-input.mouse", raw_trace.clone());

        if buttons.usButtonFlags & RI_MOUSE_HWHEEL as u16 == 0 {
            if buttons.usButtonFlags != 0 {
                record_hardware_horizontal_wheel_trace(
                    "backend.raw-input.non-horizontal",
                    raw_trace,
                );
            }
            return;
        }

        let delta_x = i32::from(buttons.usButtonData as i16);
        if delta_x == 0 {
            record_hardware_horizontal_wheel_trace("backend.raw-input.zero-horizontal", raw_trace);
            return;
        }

        if !has_point {
            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.cursor-missing",
                json!({
                    "buttonData": buttons.usButtonData,
                    "buttonFlags": buttons.usButtonFlags,
                    "deltaX": delta_x,
                }),
            );
            return;
        }

        record_hardware_horizontal_wheel_trace(
            "backend.source.raw-input",
            json!({
                "buttonData": buttons.usButtonData,
                "buttonFlags": buttons.usButtonFlags,
                "deltaX": delta_x,
                "point": trace_point(point),
            }),
        );
        queue_hardware_horizontal_wheel_packet(HardwareHorizontalWheelPacket {
            delta_x,
            point,
            source: HardwareHorizontalWheelPacketSource::RawInput,
        });
    }

    fn queue_raw_hid_horizontal_wheel(raw_input: &RAWINPUT) {
        if raw_input.header.dwType != RIM_TYPEHID {
            return;
        }

        // Some Windows mouse drivers expose a physical horizontal wheel as
        // vendor-page Raw Input HID reports before they emit WM_MOUSEHWHEEL or
        // RI_MOUSE_HWHEEL. This source still owns only the same hardware fact
        // as the standard Windows wheel sources: a signed horizontal detent at
        // the current cursor point. It must not grow into brand-specific policy
        // or component viewport behavior.
        let device_info = raw_input_device_info(raw_input.header.hDevice);
        let usage_page = device_info
            .as_ref()
            .and_then(|info| info.get("usagePage"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0);

        if usage_page < u64::from(HID_USAGE_PAGE_VENDOR_DEFINED_BEGIN) {
            return;
        }

        let reports = raw_hid_report_bytes(raw_input);
        let hid = raw_hid_ref(raw_input);
        let dw_size_hid = hid.dwSizeHid as usize;

        if dw_size_hid == 0 || reports.is_empty() {
            return;
        }

        for report in reports.chunks(dw_size_hid) {
            let Some(delta_x) = resolve_raw_hid_horizontal_wheel_delta(report) else {
                continue;
            };
            let Some(point) = read_cursor_point() else {
                continue;
            };

            record_hardware_horizontal_wheel_trace(
                "backend.source.raw-input-hid",
                json!({
                    "deltaX": delta_x,
                    "point": trace_point(point),
                    "rawDataHex": hex_bytes(report),
                    "rawInputDevice": trace_raw_input_device(raw_input.header.hDevice),
                    "rawInputHeaderDevice": format!("0x{:x}", raw_input.header.hDevice as usize),
                    "rawInputHeaderWparam": raw_input.header.wParam,
                }),
            );
            queue_hardware_horizontal_wheel_packet(HardwareHorizontalWheelPacket {
                delta_x,
                point,
                source: HardwareHorizontalWheelPacketSource::RawInputHid,
            });
        }
    }

    unsafe extern "system" fn hardware_horizontal_wheel_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _ref_data: usize,
    ) -> LRESULT {
        if message == WM_INPUT {
            record_hardware_horizontal_wheel_trace(
                "backend.window-message.wm-input",
                json!({
                    "hwnd": trace_hwnd(hwnd),
                    "wparam": wparam,
                }),
            );
            queue_raw_input_horizontal_wheel(lparam);
            return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
        }

        if message == WM_NCDESTROY {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if let Some(monitor) = take_monitor(hwnd) {
                unsafe { drop_monitor(monitor) };
            }
            clear_raw_input_sink_if_matches(hwnd);
            return result;
        }

        // The subclass owns window-scoped input facts only. Raw Input and the
        // low-level hook are both hardware packet sources; the packet queue
        // merges duplicate reports into one fact before any component sees it.
        // Neither source translates input into spectrum viewport state.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    fn raw_input_devices_for_hwnd(hwnd: HWND) -> Vec<RAWINPUTDEVICE> {
        let mut devices = vec![RAWINPUTDEVICE {
            usUsagePage: HID_USAGE_PAGE_GENERIC,
            usUsage: HID_USAGE_GENERIC_MOUSE,
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        }];

        // The vendor-page HID collections are hardware fact sources, not a
        // brand fallback. Some Windows mouse drivers expose the physical
        // horizontal wheel through a vendor top-level collection before the
        // standard mouse collection begins emitting RI_MOUSE_HWHEEL.
        devices.extend(
            RAW_INPUT_VENDOR_DEFINED_HID_USAGES
                .into_iter()
                .map(|usage| RAWINPUTDEVICE {
                    usUsagePage: HID_USAGE_PAGE_VENDOR_DEFINED_BEGIN,
                    usUsage: usage,
                    dwFlags: RIDEV_INPUTSINK,
                    hwndTarget: hwnd,
                }),
        );

        devices
    }

    fn ensure_raw_mouse_input_registered(hwnd: HWND) -> Result<(), String> {
        // Windows keeps one raw-input target per device class for the process.
        // Re-registering from prewarm or secondary windows would move mouse
        // packets away from the visible startup window and recreate the cold
        // start dependency this module exists to remove. The remembered target
        // is only valid while its HWND is still alive; otherwise Raw Input
        // becomes a stale backend lifecycle state that no component can fix.
        let mut sink = raw_input_sink_hwnd()
            .lock()
            .map_err(|_| "hardware wheel raw input sink state poisoned".to_string())?;

        if let Some(existing_hwnd) = *sink {
            let existing_hwnd = existing_hwnd as HWND;
            if unsafe { IsWindow(existing_hwnd) } != 0 {
                record_hardware_horizontal_wheel_trace(
                    "backend.raw-input.register-skip-existing",
                    json!({
                        "existingHwnd": trace_hwnd(existing_hwnd),
                        "requestedHwnd": trace_hwnd(hwnd),
                    }),
                );
                return Ok(());
            }

            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.sink-stale",
                json!({
                    "existingHwnd": trace_hwnd(existing_hwnd),
                    "requestedHwnd": trace_hwnd(hwnd),
                }),
            );
            *sink = None;
        }

        let devices = raw_input_devices_for_hwnd(hwnd);

        let registered = unsafe {
            windows_sys::Win32::UI::Input::RegisterRawInputDevices(
                devices.as_ptr(),
                devices.len() as u32,
                mem::size_of::<RAWINPUTDEVICE>() as u32,
            )
        } != 0;

        if registered {
            *sink = Some(hwnd as isize);
            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.registered",
                json!({
                    "hwnd": trace_hwnd(hwnd),
                    "registeredDevices": devices
                        .iter()
                        .map(|device| {
                            json!({
                                "flags": device.dwFlags,
                                "usage": device.usUsage,
                                "usagePage": device.usUsagePage,
                            })
                        })
                        .collect::<Vec<_>>(),
                }),
            );
            Ok(())
        } else {
            record_hardware_horizontal_wheel_trace(
                "backend.raw-input.register-failed",
                json!({
                    "hwnd": trace_hwnd(hwnd),
                }),
            );
            Err(format!(
                "failed to register raw mouse input hwnd=0x{:x}",
                hwnd as usize
            ))
        }
    }

    fn install_on_hwnd(window: &WebviewWindow, hwnd: HWND) -> Result<bool, String> {
        let hwnd_key = hwnd as isize;
        {
            let monitored = monitored_windows()
                .lock()
                .map_err(|_| "hardware wheel monitor state poisoned".to_string())?;
            if monitored.contains_key(&hwnd_key) {
                return Ok(false);
            }
        }

        let monitor = Box::into_raw(Box::new(HardwareHorizontalWheelMonitor {
            app: window.app_handle().clone(),
            window_label: window.label().to_string(),
        })) as usize;
        let installed = unsafe {
            SetWindowSubclass(
                hwnd,
                Some(hardware_horizontal_wheel_subclass_proc),
                HARDWARE_HORIZONTAL_WHEEL_SUBCLASS_ID,
                monitor,
            )
        };

        if installed != 0 {
            let mut monitored = monitored_windows()
                .lock()
                .map_err(|_| "hardware wheel monitor state poisoned".to_string())?;
            monitored.insert(hwnd_key, monitor);
            record_hardware_horizontal_wheel_trace(
                "backend.monitor.installed",
                json!({
                    "hwnd": trace_hwnd(hwnd),
                    "windowLabel": window.label(),
                }),
            );
            Ok(true)
        } else {
            let _ = unsafe { Box::from_raw(monitor as *mut HardwareHorizontalWheelMonitor) };
            let class_name = class_name(hwnd);
            Err(format!(
                "failed to install hardware horizontal wheel monitor for {} class={} hwnd=0x{:x}",
                window.label(),
                class_name,
                hwnd as usize
            ))
        }
    }

    unsafe extern "system" fn install_child_monitor(hwnd: HWND, lparam: LPARAM) -> i32 {
        let window = unsafe { (lparam as *const WebviewWindow).as_ref().unwrap() };
        let _ = install_on_hwnd(window, hwnd);
        1
    }

    pub fn install(window: &WebviewWindow) -> Result<(), String> {
        record_hardware_horizontal_wheel_trace(
            "backend.install.start",
            json!({
                "windowLabel": window.label(),
            }),
        );
        install_packet_workers()?;
        install_low_level_hook()?;

        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let hwnd = hwnd.0 as HWND;
        ensure_raw_mouse_input_registered(hwnd)?;
        let _ = install_on_hwnd(window, hwnd)?;

        unsafe {
            EnumChildWindows(
                hwnd,
                Some(install_child_monitor),
                window as *const WebviewWindow as LPARAM,
            );
        }

        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::WebviewWindow;

    pub fn install(_window: &WebviewWindow) -> Result<(), String> {
        Ok(())
    }
}

pub fn install_hardware_horizontal_wheel_monitor(window: &WebviewWindow) {
    if let Err(error) = platform::install(window) {
        eprintln!("[hardwareHorizontalWheel] {error}");
    }
}
