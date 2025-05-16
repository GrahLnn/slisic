#![cfg(target_os = "macos")]
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, ProtocolObject};
use objc2_app_kit::{
    NSWindow,
    NSWindowButton,
    NSWindowDidEnterFullScreenNotification, // Import for entering fullscreen
    NSWindowDidExitFullScreenNotification,
    NSWindowWillExitFullScreenNotification, // Added for exiting fullscreen intent
};
use objc2_foundation::{
    MainThreadMarker, NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue,
};
use tauri::WebviewWindow; // Manager for emit
use tauri_specta::Event;

use crate::utils::event::FullScreenEvent;

// --- Helper to show/hide traffic lights ---
unsafe fn set_native_traffic_lights_hidden(
    ns_window: &Retained<NSWindow>,
    hidden: bool,
    _mtm: MainThreadMarker,
) {
    if let Some(close_button) = ns_window.standardWindowButton(NSWindowButton::CloseButton) {
        close_button.setHidden(hidden);
    }
    if let Some(miniaturize_button) =
        ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
    {
        miniaturize_button.setHidden(hidden);
    }
    if let Some(zoom_button) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) {
        zoom_button.setHidden(hidden);
    }
    // println!("[macos_titlebar] Native traffic lights hidden: {}", hidden);
}

// --- Public function to initially hide (called once) ---
unsafe fn hide_native_traffic_lights_initial(
    ns_window: &Retained<NSWindow>,
    mtm: MainThreadMarker,
) {
    set_native_traffic_lights_hidden(ns_window, true, mtm);
}

pub fn setup_custom_macos_titlebar(window: &WebviewWindow) {
    window
        .set_title_bar_style(tauri::TitleBarStyle::Overlay)
        .expect("Failed to set title bar style to Overlay");

    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr as *mut objc2_app_kit::NSWindow,
        Err(e) => {
            eprintln!("Failed to get NSWindow pointer: {:?}", e);
            return;
        }
    };

    if ns_window_ptr.is_null() {
        eprintln!("NSWindow pointer is null. Cannot hide traffic lights.");
        return;
    }

    match unsafe { Retained::retain(ns_window_ptr) } {
        Some(ns_window_id) => {
            if let Some(mtm) = MainThreadMarker::new() {
                unsafe {
                    // Call the initial hide function
                    hide_native_traffic_lights_initial(&ns_window_id, mtm);
                }
            } else {
                eprintln!("Failed to get MainThreadMarker for initial traffic light hide.");
            }
        }
        None => {
            eprintln!("Failed to retain NSWindow for initial traffic light hide.");
        }
    }
}

pub struct FullscreenStateManager {
    enter_fullscreen_token: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    will_exit_fullscreen_token: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>, // New token
    exit_fullscreen_token: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

impl FullscreenStateManager {
    pub fn new(webview_window: &WebviewWindow, mtm: MainThreadMarker) -> Option<Self> {
        let ns_window_ptr = webview_window.ns_window().ok()? as *mut objc2_app_kit::NSWindow;
        if ns_window_ptr.is_null() {
            return None;
        }
        let ns_window_id = unsafe { Retained::retain(ns_window_ptr)? };

        let notification_center = unsafe { NSNotificationCenter::defaultCenter() };
        let main_queue = unsafe { NSOperationQueue::mainQueue() };

        // --- Observer for DidExitFullScreen (now only for event emission) ---
        let tauri_webview_clone_exit = webview_window.clone();

        let exit_block = RcBlock::new(
            move |_notification_ptr: std::ptr::NonNull<NSNotification>| {
                // Only emit event, traffic lights already hidden by WillExit
                FullScreenEvent {
                    is_fullscreen: false,
                }
                .emit(&tauri_webview_clone_exit)
                .unwrap();
            },
        );
        let ns_window_obj_ref_exit: &NSObject = &*ns_window_id;
        let exit_token = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidExitFullScreenNotification),
                Some(ns_window_obj_ref_exit),
                Some(&main_queue),
                &exit_block,
            )
        };

        // --- NEW Observer for WillExitFullScreen (hides traffic lights immediately) ---
        let tauri_webview_clone_exit = webview_window.clone();
        let window_clone_will_exit = ns_window_id.clone();
        let mtm_clone_will_exit = mtm;

        let will_exit_block = RcBlock::new(
            move |_notification_ptr: std::ptr::NonNull<NSNotification>| unsafe {
                // Hide traffic lights immediately when starting to exit fullscreen
                set_native_traffic_lights_hidden(
                    &window_clone_will_exit,
                    true,
                    mtm_clone_will_exit,
                );
                FullScreenEvent {
                    is_fullscreen: false,
                }
                .emit(&tauri_webview_clone_exit)
                .unwrap();
            },
        );
        let ns_window_obj_ref_will_exit: &NSObject = &*ns_window_id;
        let will_exit_token = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowWillExitFullScreenNotification),
                Some(ns_window_obj_ref_will_exit),
                Some(&main_queue),
                &will_exit_block,
            )
        };

        // --- Observer for DidEnterFullScreen (unchanged) ---
        let window_clone_enter = ns_window_id.clone();
        let mtm_clone_enter = mtm;
        let tauri_webview_clone_enter = webview_window.clone();

        let enter_block = RcBlock::new(
            move |_notification_ptr: std::ptr::NonNull<NSNotification>| unsafe {
                set_native_traffic_lights_hidden(&window_clone_enter, false, mtm_clone_enter);

                FullScreenEvent {
                    is_fullscreen: true,
                }
                .emit(&tauri_webview_clone_enter)
                .unwrap();
            },
        );
        let ns_window_obj_ref_enter: &NSObject = &*ns_window_id;
        let enter_token = unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidEnterFullScreenNotification),
                Some(ns_window_obj_ref_enter),
                Some(&main_queue),
                &enter_block,
            )
        };

        Some(Self {
            enter_fullscreen_token: Some(enter_token),
            will_exit_fullscreen_token: Some(will_exit_token),
            exit_fullscreen_token: Some(exit_token),
        })
    }
}

impl Drop for FullscreenStateManager {
    fn drop(&mut self) {
        let center = unsafe { NSNotificationCenter::defaultCenter() };
        if let Some(token) = self.enter_fullscreen_token.take() {
            let observer_as_nsobject: Retained<NSObject> =
                unsafe { Retained::cast_unchecked(token) };
            let observer_as_anyobject_ref: &AnyObject = &*observer_as_nsobject;
            unsafe { center.removeObserver(observer_as_anyobject_ref) };
        }
        if let Some(token) = self.will_exit_fullscreen_token.take() {
            let observer_as_nsobject: Retained<NSObject> =
                unsafe { Retained::cast_unchecked(token) };
            let observer_as_anyobject_ref: &AnyObject = &*observer_as_nsobject;
            unsafe { center.removeObserver(observer_as_anyobject_ref) };
        }
        if let Some(token) = self.exit_fullscreen_token.take() {
            let observer_as_nsobject: Retained<NSObject> =
                unsafe { Retained::cast_unchecked(token) };
            let observer_as_anyobject_ref: &AnyObject = &*observer_as_nsobject;
            unsafe { center.removeObserver(observer_as_anyobject_ref) };
        }
    }
}
