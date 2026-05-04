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
    use std::ptr;
    use std::sync::mpsc::{self, SyncSender, TrySendError};
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use tauri::{Manager, WebviewWindow};
    use tauri_specta::Event;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, EnumChildWindows, GA_ROOT, GetAncestor, GetClassNameW,
        GetMessageW, GetWindowRect, GetWindowThreadProcessId, HC_ACTION, HHOOK, IsChild, MSG,
        MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WHEEL_DELTA, WM_MOUSEHWHEEL,
        WM_NCDESTROY, WM_QUIT, WindowFromPoint,
    };

    const HARDWARE_HORIZONTAL_WHEEL_SUBCLASS_ID: usize = 0x7261_6E73_4857;

    use super::HardwareHorizontalWheelEvent;

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
        mouse_data: u32,
        point: POINT,
    }

    struct HardwareHorizontalWheelHook {
        handle: HHOOK,
        thread_id: u32,
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

        println!(
            "[hardwareHorizontalWheel] low-level horizontal window={} hit={} class={} hwnd=0x{:x} delta_x={} client_x={client_x:.2} client_y={client_y:.2}",
            target.window_label,
            hit_reason,
            class_name(client_hwnd),
            client_hwnd as usize,
            delta_x
        );
        emit_hardware_horizontal_wheel_event_at_client_point(target, client_x, client_y, delta_x);
    }

    fn handle_hardware_horizontal_wheel_packet(packet: HardwareHorizontalWheelPacket) {
        let Some((client_hwnd, target, hit_reason)) = target_for_screen_point(packet.point) else {
            return;
        };
        let delta_x = i32::from(signed_high_word(packet.mouse_data as usize));

        emit_hardware_horizontal_wheel_event_from_screen_point(
            &target,
            client_hwnd,
            hit_reason,
            packet.point,
            delta_x,
        );
    }

    unsafe extern "system" fn hardware_horizontal_wheel_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 && wparam as u32 == WM_MOUSEHWHEEL {
            let hook = unsafe { (lparam as *const MSLLHOOKSTRUCT).as_ref() };

            if let Some(hook) = hook {
                if let Some(sender) = hardware_horizontal_wheel_packet_sender().get() {
                    match sender.try_send(HardwareHorizontalWheelPacket {
                        mouse_data: hook.mouseData,
                        point: hook.pt,
                    }) {
                        Ok(()) | Err(TrySendError::Full(_)) => {}
                        Err(TrySendError::Disconnected(_)) => {
                            eprintln!("[hardwareHorizontalWheel] packet worker disconnected");
                        }
                    }
                }
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
        println!("[hardwareHorizontalWheel] low-level hook installed thread_id={thread_id}");
        Ok(())
    }

    unsafe extern "system" fn hardware_horizontal_wheel_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        ref_data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            let monitor = unsafe { monitor_from_ref_data(ref_data) };
            let window_label = monitor.window_label.clone();
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if let Some(monitor) = take_monitor(hwnd) {
                unsafe { drop_monitor(monitor) };
                println!("[hardwareHorizontalWheel] monitor removed window={window_label}");
            }
            return result;
        }

        // The subclass is only a window-membership owner. WebView can bypass
        // WM_MOUSEHWHEEL for Logitech horizontal wheels, so dispatching input
        // here would create a second, incomplete source of wheel truth. The
        // low-level hook is the only hardware packet source; this subclass only
        // keeps the HWND registry accurate for that hook's app-window filter.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
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

        let class_name = class_name(hwnd);
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
            println!(
                "[hardwareHorizontalWheel] monitor installed window={} class={} hwnd=0x{:x}",
                window.label(),
                class_name,
                hwnd as usize
            );
            Ok(true)
        } else {
            let _ = unsafe { Box::from_raw(monitor as *mut HardwareHorizontalWheelMonitor) };
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
        install_low_level_hook()?;

        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let hwnd = hwnd.0 as HWND;
        let mut installed_count = usize::from(install_on_hwnd(window, hwnd)?);

        unsafe {
            EnumChildWindows(
                hwnd,
                Some(install_child_monitor),
                window as *const WebviewWindow as LPARAM,
            );
        }

        if let Ok(monitored) = monitored_windows().lock() {
            installed_count = monitored.len();
        }
        println!(
            "[hardwareHorizontalWheel] monitor scan complete window={} installed_count={installed_count}",
            window.label()
        );

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
