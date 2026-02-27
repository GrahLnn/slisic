use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri::{LogicalSize, Size};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use super::macos_titlebar::FullscreenStateManager;
#[cfg(target_os = "macos")]
use std::cell::RefCell;
use std::fmt;
use std::sync::{LazyLock, Mutex};
#[cfg(target_os = "macos")]
thread_local! {
    static MAIN_WINDOW_OBSERVER: RefCell<Option<FullscreenStateManager>> = RefCell::new(None);
}

#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
#[cfg(target_os = "windows")]
use windows::core::Interface;

const PREWARM_MAIN_PREFIX: &str = "main-prewarm-";
const PREWARM_MAIN_TARGET: usize = 1;

static PREWARM_MAIN_PENDING: LazyLock<Mutex<Vec<String>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
static PREWARM_MAIN_READY: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn is_prewarm_main_label(label: &str) -> bool {
    label.starts_with(PREWARM_MAIN_PREFIX)
}

pub fn is_non_prewarm_main_label(label: &str) -> bool {
    label == "main" || (label.starts_with("main-") && !is_prewarm_main_label(label))
}

pub fn should_exit_on_window_close(app: &AppHandle, closing_label: &str) -> bool {
    if !is_non_prewarm_main_label(closing_label) {
        return false;
    }

    let main_window_count = app
        .webview_windows()
        .keys()
        .filter(|label| is_non_prewarm_main_label(label))
        .count();

    main_window_count <= 1
}

pub fn close_all_prewarm_main_windows(app: &AppHandle) {
    let labels = app
        .webview_windows()
        .keys()
        .filter(|label| is_prewarm_main_label(label))
        .cloned()
        .collect::<Vec<_>>();

    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }

    PREWARM_MAIN_PENDING
        .lock()
        .expect("prewarm pending list should be lockable")
        .clear();
    PREWARM_MAIN_READY
        .lock()
        .expect("prewarm ready list should be lockable")
        .clear();
}

#[derive(Serialize, Type)]
pub struct MouseWindowInfo {
    mouse_x: i32,
    mouse_y: i32,
    window_x: i32,
    window_y: i32,
    window_width: u32,
    window_height: u32,
    rel_x: i32,
    rel_y: i32,
    pixel_ratio: f64,
}

#[tauri::command]
#[specta::specta]
pub fn get_mouse_and_window_position(app: AppHandle) -> Result<MouseWindowInfo, String> {
    let window = app.get_webview_window("main").ok_or("未找到窗口 main")?;

    // ① 鼠标位置
    let cursor = window
        .cursor_position()
        .map_err(|e| format!("获取鼠标位置失败: {e:?}"))?;

    // ② 窗口左上角
    let win_pos = window
        .outer_position()
        .map_err(|e| format!("获取窗口位置失败: {e:?}"))?;

    // ③ 窗口尺寸
    let win_size = window
        .outer_size()
        .map_err(|e| format!("获取窗口尺寸失败: {e:?}"))?;

    // ④ 缩放因子
    let pixel_ratio = window
        .scale_factor()
        .map_err(|e| format!("获取缩放因子失败: {e:?}"))?;

    // ⑤ 计算相对坐标
    let rel_x = cursor.x as i32 - win_pos.x;
    let rel_y = cursor.y as i32 - win_pos.y;

    Ok(MouseWindowInfo {
        mouse_x: cursor.x as i32,
        mouse_y: cursor.y as i32,
        window_x: win_pos.x,
        window_y: win_pos.y,
        window_width: win_size.width,
        window_height: win_size.height,
        rel_x,
        rel_y,
        pixel_ratio,
    })
}

#[derive(Serialize, Deserialize, Type)]
pub struct CreateWindowOptions {
    width: Option<f64>,
    height: Option<f64>,
}

pub fn apply_window_setup(window: &WebviewWindow, is_main: bool) {
    #[cfg(not(target_os = "macos"))]
    let _ = is_main;
    #[cfg(target_os = "windows")]
    {
        window.set_decorations(false).unwrap();
        window
            .with_webview(|webview| unsafe {
                let core = webview.controller().CoreWebView2().unwrap();
                let settings = core.Settings().unwrap();
                let s4: ICoreWebView2Settings4 = settings.cast().unwrap(); // 提升到 Settings4
                s4.SetIsGeneralAutofillEnabled(false).unwrap();
                s4.SetIsPasswordAutosaveEnabled(false).unwrap();
            })
            .expect("disable autofill");
    }

    #[cfg(target_os = "macos")]
    {
        use super::macos_titlebar;
        use objc2::MainThreadMarker;

        macos_titlebar::setup_custom_macos_titlebar(window);

        if is_main {
            if let Some(mtm) = MainThreadMarker::new() {
                if let Some(observer) = macos_titlebar::FullscreenStateManager::new(window, mtm) {
                    MAIN_WINDOW_OBSERVER.with(|cell| {
                        let mut observer_ref = cell.borrow_mut();
                        *observer_ref = Some(observer);
                    });
                } else {
                    eprintln!("Failed to create FullscreenObserver.");
                }
            } else {
                eprintln!("Failed to get MainThreadMarker for FullscreenObserver setup.");
            }
        }

        window.on_window_event(|event| {
            let _ = matches!(event, tauri::WindowEvent::Resized(_));
        });
    }
}

#[derive(Serialize, Deserialize, Type, Clone, Copy)]
pub enum WindowName {
    Main,
}

impl WindowName {
    pub const fn as_str(&self) -> &'static str {
        match self {
            WindowName::Main => "main",
        }
    }
}

impl fmt::Display for WindowName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

fn next_label(name: WindowName, app: &tauri::AppHandle) -> String {
    for index in 1.. {
        let label = format!("{name}-{index}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
    unreachable!("graph window label overflow")
}

fn next_prewarm_main_label(app: &tauri::AppHandle) -> String {
    for index in 1.. {
        let label = format!("{PREWARM_MAIN_PREFIX}{index}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
    unreachable!("prewarm window label overflow")
}

fn build_window(
    app: &tauri::AppHandle,
    label: String,
    title: &str,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .visible(visible);

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        if let Ok(app_local_data_dir) = app.path().app_local_data_dir() {
            let webview_data_dir = app_local_data_dir.join("webview-profile");
            let _ = std::fs::create_dir_all(&webview_data_dir);
            builder = builder.data_directory(webview_data_dir);
        }
    }

    builder.build().map_err(|error| error.to_string())
}

fn apply_window_options(window: &WebviewWindow, options: Option<&CreateWindowOptions>) {
    if let Some(options) = options {
        if let (Some(width), Some(height)) = (options.width, options.height) {
            let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
        }
    }
}

fn prune_labels(app: &tauri::AppHandle, labels: &mut Vec<String>) {
    labels.retain(|label| app.get_webview_window(label).is_some());
}

fn take_ready_main_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    let mut ready = PREWARM_MAIN_READY
        .lock()
        .expect("prewarm ready list should be lockable");
    prune_labels(app, &mut ready);

    while let Some(label) = ready.pop() {
        if let Some(window) = app.get_webview_window(&label) {
            return Some(window);
        }
    }

    None
}

pub fn mark_main_window_ready(label: &str) -> bool {
    if !label.starts_with(PREWARM_MAIN_PREFIX) {
        return false;
    }

    let mut pending = PREWARM_MAIN_PENDING
        .lock()
        .expect("prewarm pending list should be lockable");
    if let Some(index) = pending.iter().position(|value| value == label) {
        pending.swap_remove(index);
    }
    drop(pending);

    let mut ready = PREWARM_MAIN_READY
        .lock()
        .expect("prewarm ready list should be lockable");
    if !ready.iter().any(|value| value == label) {
        ready.push(label.to_string());
    }

    true
}

pub fn ensure_main_window_prewarm(app: &tauri::AppHandle) {
    let pending_len = {
        let mut pending = PREWARM_MAIN_PENDING
            .lock()
            .expect("prewarm pending list should be lockable");
        prune_labels(app, &mut pending);
        pending.len()
    };

    let ready_len = {
        let mut ready = PREWARM_MAIN_READY
            .lock()
            .expect("prewarm ready list should be lockable");
        prune_labels(app, &mut ready);
        ready.len()
    };

    let total = pending_len + ready_len;
    if total >= PREWARM_MAIN_TARGET {
        return;
    }

    for _ in total..PREWARM_MAIN_TARGET {
        let label = next_prewarm_main_label(app);
        match build_window(app, label.clone(), WindowName::Main.as_str(), false) {
            Ok(window) => {
                apply_window_setup(&window, false);
                PREWARM_MAIN_PENDING
                    .lock()
                    .expect("prewarm pending list should be lockable")
                    .push(label);
            }
            Err(error) => {
                eprintln!("Failed to prewarm main window: {error}");
                break;
            }
        }
    }
}

#[specta::specta]
#[tauri::command]
pub async fn create_window(
    app: tauri::AppHandle,
    name: WindowName,
    options: Option<CreateWindowOptions>,
) {
    if matches!(name, WindowName::Main) {
        if let Some(window) = take_ready_main_window(&app) {
            apply_window_options(&window, options.as_ref());
            let _ = window.show();
            let _ = window.set_focus();
            ensure_main_window_prewarm(&app);
            return;
        }
    }

    let label = next_label(name, &app);
    match build_window(&app, label, name.as_str(), true) {
        Ok(window) => {
            apply_window_options(&window, options.as_ref());
            apply_window_setup(&window, false);

            if matches!(name, WindowName::Main) {
                ensure_main_window_prewarm(&app);
            }
        }
        Err(error) => {
            eprintln!("Failed to create window: {error}");
        }
    }
}
