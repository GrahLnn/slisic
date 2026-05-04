//! Windows hardware wheel probe.
//!
//! This module owns only the window-scoped hardware fact: "Windows reported a
//! horizontal hardware-wheel packet while the pointer was inside one of this
//! app's windows". It never consumes the native input and never translates
//! deltas into spectrum viewport coordinates. Component-level ownership stays
//! inside the spectrum component.

use serde::{Deserialize, Serialize};
use specta::Type;
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

#[cfg(target_os = "windows")]
mod platform {
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
    use windows_sys::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, GetRawInputDeviceInfoW, HRAWINPUT, RAWHID, RAWINPUT, RAWINPUTDEVICE,
        RAWINPUTHEADER, RID_DEVICE_INFO, RID_INPUT, RIDEV_INPUTSINK, RIDI_DEVICEINFO, RIM_TYPEHID,
        RIM_TYPEMOUSE,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, EnumChildWindows, GA_ROOT, GetAncestor, GetClassNameW,
        GetMessageW, GetWindowRect, GetWindowThreadProcessId, HC_ACTION, HHOOK, IsChild, IsWindow,
        MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, RI_MOUSE_HWHEEL,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WHEEL_DELTA,
        WM_INPUT, WM_MOUSEHWHEEL, WM_NCDESTROY, WM_QUIT, WindowFromPoint,
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
            return;
        };
        let event = HardwareHorizontalWheelEvent {
            client_x,
            client_y,
            delta_x,
            wheel_delta_unit: WHEEL_DELTA as i32,
            window_label: target.window_label.clone(),
        };

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

    fn raw_input_hid_usage_page(device: HANDLE) -> Option<u16> {
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

        (info.dwType == RIM_TYPEHID).then(|| unsafe { info.Anonymous.hid }.usUsagePage)
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

    fn target_for_screen_point(point: POINT) -> Option<(HWND, HardwareHorizontalWheelTarget)> {
        let hit_hwnd = unsafe { WindowFromPoint(point) };

        if let Some((client_hwnd, target)) = target_for_related_hit_hwnd(hit_hwnd) {
            return Some((client_hwnd, target));
        }

        if hit_hwnd_belongs_to_current_process(hit_hwnd) {
            return target_for_window_rect(point);
        }

        None
    }

    fn emit_hardware_horizontal_wheel_event_from_screen_point(
        target: &HardwareHorizontalWheelTarget,
        client_hwnd: HWND,
        point: POINT,
        delta_x: i32,
    ) {
        let Some(window) = target.app.get_webview_window(&target.window_label) else {
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

        emit_hardware_horizontal_wheel_event_at_client_point(target, client_x, client_y, delta_x);
    }

    fn handle_hardware_horizontal_wheel_packet(packet: HardwareHorizontalWheelPacket) {
        let Some((client_hwnd, target)) = target_for_screen_point(packet.point) else {
            return;
        };

        emit_hardware_horizontal_wheel_event_from_screen_point(
            &target,
            client_hwnd,
            packet.point,
            packet.delta_x,
        );
    }

    fn send_hardware_horizontal_wheel_packet(packet: HardwareHorizontalWheelPacket) {
        if let Some(sender) = hardware_horizontal_wheel_packet_sender().get() {
            match sender.try_send(packet) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Disconnected(_)) => {
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
        if code == HC_ACTION as i32 && wparam as u32 == WM_MOUSEHWHEEL {
            let hook = unsafe { (lparam as *const MSLLHOOKSTRUCT).as_ref() };

            if let Some(hook) = hook {
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
            return Ok(());
        }

        let (sender, receiver) = mpsc::sync_channel(512);
        hardware_horizontal_wheel_packet_sender()
            .set(sender)
            .map_err(|_| "hardware wheel packet sender already initialized".to_string())?;

        thread::Builder::new()
            .name("hardware-horizontal-wheel-worker".to_string())
            .spawn(move || {
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
                    let _ = sender.send(Err(
                        "failed to install hardware horizontal wheel low-level hook".to_string(),
                    ));
                    return;
                }

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
            return;
        }

        let mouse = unsafe { raw_input.data.mouse };
        let buttons = unsafe { mouse.Anonymous.Anonymous };

        if buttons.usButtonFlags & RI_MOUSE_HWHEEL as u16 == 0 {
            return;
        }

        let delta_x = i32::from(buttons.usButtonData as i16);
        if delta_x == 0 {
            return;
        }

        let Some(point) = read_cursor_point() else {
            return;
        };
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
        let usage_page = raw_input_hid_usage_page(raw_input.header.hDevice).unwrap_or(0);

        if usage_page < HID_USAGE_PAGE_VENDOR_DEFINED_BEGIN {
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
                return Ok(());
            }

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
            Ok(())
        } else {
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
