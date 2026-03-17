use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri::{LogicalSize, Size};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use super::macos_titlebar::FullscreenStateManager;
#[cfg(target_os = "macos")]
use std::cell::RefCell;
use std::fmt;
#[cfg(target_os = "macos")]
thread_local! {
    static MAIN_WINDOW_OBSERVER: RefCell<Option<FullscreenStateManager>> = RefCell::new(None);
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct WindowKindInfo {
    pub window: Option<WindowName>,
    pub label: String,
    pub is_primary_main: bool,
    pub is_user_window: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowIdentity {
    window: Option<WindowName>,
    is_primary_main: bool,
    is_user_window: bool,
}

fn classify_window_identity(label: &str) -> WindowIdentity {
    let window = window_kind_from_label(label);
    let is_primary_main = label == WindowName::Main.as_str();
    let is_user_window = matches!(window, Some(WindowName::Main))
        && (is_primary_main || is_main_user_window_instance_label(label));

    WindowIdentity {
        window,
        is_primary_main,
        is_user_window,
    }
}

fn window_kind_info_for_label(label: &str) -> WindowKindInfo {
    let identity = classify_window_identity(label);

    WindowKindInfo {
        window: identity.window,
        label: label.to_string(),
        is_primary_main: identity.is_primary_main,
        is_user_window: identity.is_user_window,
    }
}

fn is_window_label_for(name: WindowName, label: &str) -> bool {
    if label == name.as_str() {
        return true;
    }

    let window_prefix = format!("{}-", name.as_str());
    label.starts_with(&window_prefix)
}

pub fn window_kind_from_label(label: &str) -> Option<WindowName> {
    for name in WindowName::ALL {
        if is_window_label_for(name, label) {
            return Some(name);
        }
    }

    None
}

#[tauri::command]
#[specta::specta]
pub fn get_window_kind(window: WebviewWindow) -> WindowKindInfo {
    window_kind_info_for_label(window.label())
}

#[allow(dead_code)]
pub fn is_user_window_label(label: &str) -> bool {
    should_label_resolve_as_user_window(label)
}

pub fn should_label_resolve_as_user_window(label: &str) -> bool {
    classify_window_identity(label).is_user_window
}

#[cfg(test)]
fn classify_window_labels<'a>(labels: impl IntoIterator<Item = &'a str>) -> Vec<WindowKindInfo> {
    labels
        .into_iter()
        .map(window_kind_info_for_label)
        .collect()
}

fn is_main_user_window_instance_label(label: &str) -> bool {
    let Some(suffix) = label.strip_prefix("main-") else {
        return false;
    };

    !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
}

fn should_exit_on_window_close_after_visible_user_count(
    closing_label: &str,
    visible_user_window_count_before_close: usize,
) -> bool {
    if !should_label_resolve_as_user_window(closing_label) {
        return false;
    }

    visible_user_window_count_before_close.saturating_sub(1) == 0
}

#[derive(Debug, Clone)]
struct PreparedWindowState {
    label: String,
}

fn prepared_window_inventory() -> &'static Mutex<HashMap<WindowName, PreparedWindowState>> {
    static PREPARED_WINDOWS: OnceLock<Mutex<HashMap<WindowName, PreparedWindowState>>> = OnceLock::new();
    PREPARED_WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reserve_prepared_window(name: WindowName, label: String) {
    let mut inventory = prepared_window_inventory()
        .lock()
        .expect("prepared window inventory poisoned");
    inventory.insert(name, PreparedWindowState { label });
}

fn discard_prepared_window(name: WindowName) -> bool {
    let mut inventory = prepared_window_inventory()
        .lock()
        .expect("prepared window inventory poisoned");
    inventory.remove(&name).is_some()
}

fn take_prepared_window(name: WindowName) -> Option<PreparedWindowState> {
    let mut inventory = prepared_window_inventory()
        .lock()
        .expect("prepared window inventory poisoned");
    inventory.remove(&name)
}

#[cfg(test)]
fn reset_prepared_window_inventory() {
    let mut inventory = prepared_window_inventory()
        .lock()
        .expect("prepared window inventory poisoned");
    inventory.clear();
}

#[cfg(test)]
fn prepared_window_targets() -> Vec<WindowName> {
    let inventory = prepared_window_inventory()
        .lock()
        .expect("prepared window inventory poisoned");
    let mut prepared = inventory.keys().copied().collect::<Vec<_>>();
    prepared.sort_by_key(WindowName::as_str);
    prepared
}

#[cfg(test)]
fn prepared_window_label(name: WindowName) -> Option<String> {
    let inventory = prepared_window_inventory()
        .lock()
        .expect("prepared window inventory poisoned");
    inventory.get(&name).map(|state| state.label.clone())
}

pub fn should_exit_on_window_close(app: &AppHandle, closing_label: &str) -> bool {
    should_exit_on_window_close_after_visible_user_count(closing_label, visible_user_window_count(app))
}

#[cfg(test)]
fn should_exit_on_window_close_with_count(closing_label: &str, visible_user_window_count: usize) -> bool {
    should_exit_on_window_close_after_visible_user_count(closing_label, visible_user_window_count)
}

pub fn visible_user_window_count(app: &AppHandle) -> usize {
    app.webview_windows()
        .values()
        .filter(|window| {
            let label = window.label();
            should_label_resolve_as_user_window(label)
                && window.is_visible().unwrap_or(false)
        })
        .count()
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
pub fn get_mouse_and_window_position(window: WebviewWindow) -> Result<MouseWindowInfo, String> {

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
        let _ = window.set_decorations(false);
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

#[derive(Serialize, Deserialize, Type, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WindowName {
    Main,
}

impl WindowName {
    pub const ALL: [WindowName; 1] = [WindowName::Main];

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

fn build_window(
    app: &tauri::AppHandle,
    label: String,
    title: &str,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .visible(visible)
        .focused(visible)
        .accept_first_mouse(true);

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

pub fn activate_window(window: &WebviewWindow) {
    let label = window.label().to_string();

    if let Err(error) = window.unminimize() {
        eprintln!("Failed to unminimize window {label}: {error}");
    }
    if let Err(error) = window.show() {
        eprintln!("Failed to show window {label}: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("Failed to focus window {label}: {error}");
    }
}

fn apply_window_options(window: &WebviewWindow, options: Option<&CreateWindowOptions>) {
    if let Some(options) = options {
        if let (Some(width), Some(height)) = (options.width, options.height) {
            let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
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
    if let Some(prepared_window) = take_prepared_window(name) {
        if let Some(window) = app.get_webview_window(&prepared_window.label) {
            apply_window_options(&window, options.as_ref());
            activate_window(&window);
            return;
        }
    }

    let label = next_label(name, &app);
    match build_window(&app, label, name.as_str(), true) {
        Ok(window) => {
            apply_window_options(&window, options.as_ref());
            apply_window_setup(&window, false);
            activate_window(&window);
        }
        Err(error) => {
            eprintln!("Failed to create window: {error}");
        }
    }
}

#[specta::specta]
#[tauri::command]
pub fn prewarm_window(app: tauri::AppHandle, name: WindowName) {
    if app.get_webview_window(name.as_str()).is_some() {
        return;
    }

    let already_prepared_label = {
        let inventory = prepared_window_inventory()
            .lock()
            .expect("prepared window inventory poisoned");
        inventory.get(&name).map(|state| state.label.clone())
    };

    if let Some(label) = already_prepared_label {
        if app.get_webview_window(&label).is_some() {
            return;
        }

        let _ = discard_prepared_window(name);
    }

    let label = format!("{}-prewarm", name.as_str());
    match build_window(&app, label.clone(), name.as_str(), false) {
        Ok(window) => {
            apply_window_setup(&window, false);
            reserve_prepared_window(name, label);
        }
        Err(error) => {
            eprintln!("Failed to prewarm window: {error}");
        }
    }
}

#[specta::specta]
#[tauri::command]
pub fn discard_prewarm_window(name: WindowName) -> bool {
    discard_prepared_window(name)
}

#[cfg(test)]
mod tests {
    use super::{
        classify_window_identity, classify_window_labels, discard_prepared_window,
        is_main_user_window_instance_label,
        is_user_window_label, prepared_window_label, prepared_window_targets,
        reserve_prepared_window,
        reset_prepared_window_inventory, should_exit_on_window_close_with_count,
        should_label_resolve_as_user_window, take_prepared_window, window_kind_from_label,
        window_kind_info_for_label, WindowName,
    };

    #[test]
    fn visible_main_labels_resolve_as_user_windows() {
        assert_eq!(window_kind_from_label("main"), Some(WindowName::Main));
        assert_eq!(window_kind_from_label("main-1"), Some(WindowName::Main));
    }

    #[test]
    fn repeated_main_labels_stay_user_windows_without_support_identity() {
        assert_eq!(window_kind_from_label("main-2"), Some(WindowName::Main));
        assert!(should_label_resolve_as_user_window("main-2"));
        assert!(is_user_window_label("main-2"));
    }

    #[test]
    fn unknown_labels_do_not_resolve_as_user_windows() {
        assert!(!should_label_resolve_as_user_window("unknown"));
        assert!(!is_user_window_label("unknown"));
    }

    #[test]
    fn startup_window_kind_marks_primary_main_as_user_window() {
        let info = window_kind_info_for_label("main");

        assert_eq!(info.window, Some(WindowName::Main));
        assert!(info.is_primary_main);
        assert!(info.is_user_window);
    }

    #[test]
    fn repeated_open_window_labels_remain_non_primary_user_windows() {
        let info = window_kind_info_for_label("main-3");

        assert_eq!(info.window, Some(WindowName::Main));
        assert!(!info.is_primary_main);
        assert!(info.is_user_window);
    }

    #[test]
    fn support_like_labels_never_resolve_as_visible_user_windows() {
        for label in ["main-prewarm-1", "support-main", "prewarm-main"] {
            let info = window_kind_info_for_label(label);

            assert_eq!(window_kind_from_label(label), Some(WindowName::Main).filter(|_| label.starts_with("main-")));
            assert!(!info.is_primary_main);
            assert!(!info.is_user_window);
        }
    }

    #[test]
    fn only_numeric_main_suffixes_count_as_user_window_instances() {
        assert!(is_main_user_window_instance_label("main-1"));
        assert!(is_main_user_window_instance_label("main-42"));
        assert!(!is_main_user_window_instance_label("main-prewarm-1"));
        assert!(!is_main_user_window_instance_label("main-secondary"));
        assert!(!is_main_user_window_instance_label("support-main-1"));
    }

    #[test]
    fn startup_and_repeated_open_labels_classify_as_exactly_one_primary_user_window() {
        let infos = classify_window_labels(["main", "main-1", "main-2"]);

        assert_eq!(infos.len(), 3);
        assert_eq!(infos.iter().filter(|info| info.is_primary_main).count(), 1);
        assert!(infos.iter().all(|info| info.is_user_window));
    }

    #[test]
    fn reopen_sequences_never_promote_secondary_labels_to_primary_main() {
        let infos = classify_window_labels(["main", "main-1", "main-2", "main-1", "main-3"]);

        assert_eq!(infos.iter().filter(|info| info.is_primary_main).count(), 1);
        assert!(infos
            .iter()
            .filter(|info| info.label != "main")
            .all(|info| !info.is_primary_main && info.is_user_window));
    }

    #[test]
    fn authoritative_label_classification_stays_stable_across_known_cases() {
        let cases = [
            ("main", Some(WindowName::Main), true, true),
            ("main-1", Some(WindowName::Main), false, true),
            ("main-99", Some(WindowName::Main), false, true),
            ("main-prewarm-1", Some(WindowName::Main), false, false),
            ("support-main", None, false, false),
            ("prewarm-main", None, false, false),
            ("unknown", None, false, false),
        ];

        for (label, expected_window, expected_primary, expected_user) in cases {
            let identity = classify_window_identity(label);

            assert_eq!(identity.window, expected_window, "wrong window kind for {label}");
            assert_eq!(identity.is_primary_main, expected_primary, "wrong primary classification for {label}");
            assert_eq!(identity.is_user_window, expected_user, "wrong user-window classification for {label}");
        }
    }

    #[test]
    fn support_and_prewarm_labels_never_classify_as_user_windows_in_mixed_enumeration() {
        let infos = classify_window_labels([
            "main",
            "main-prewarm-1",
            "support-main",
            "prewarm-main",
            "main-1",
        ]);

        let visible_user_labels = infos
            .iter()
            .filter(|info| info.is_user_window)
            .map(|info| info.label.as_str())
            .collect::<Vec<_>>();

        assert_eq!(visible_user_labels, vec!["main", "main-1"]);
    }

    #[test]
    fn closing_one_of_multiple_user_windows_does_not_exit() {
        assert!(!should_exit_on_window_close_with_count("main-1", 2));
        assert!(!should_exit_on_window_close_with_count("main", 3));
    }

    #[test]
    fn closing_last_user_window_exits() {
        assert!(should_exit_on_window_close_with_count("main", 1));
        assert!(should_exit_on_window_close_with_count("main-1", 1));
    }

    #[test]
    fn reopen_close_accounting_only_exits_when_last_visible_user_window_closes() {
        assert!(!should_exit_on_window_close_with_count("main-2", 3));
        assert!(!should_exit_on_window_close_with_count("main-1", 2));
        assert!(should_exit_on_window_close_with_count("main", 1));
        assert!(should_exit_on_window_close_with_count("main-3", 1));
    }

    #[test]
    fn closing_support_or_prewarm_window_never_exits() {
        for label in ["main-prewarm-1", "support-main", "prewarm-main", "unknown"] {
            assert!(
                !should_exit_on_window_close_with_count(label, 1),
                "label {label} should not participate in exit accounting"
            );
            assert!(
                !should_exit_on_window_close_with_count(label, 3),
                "label {label} should not participate in exit accounting"
            );
        }
    }

    #[test]
    fn typed_prewarm_targets_are_keyed_by_window_enum() {
        reset_prepared_window_inventory();

        reserve_prepared_window(WindowName::Main, "main-prewarm".to_string());

        assert_eq!(prepared_window_targets(), vec![WindowName::Main]);

        reserve_prepared_window(WindowName::Main, "main-prewarm".to_string());

        assert_eq!(prepared_window_targets(), vec![WindowName::Main]);
    }

    #[test]
    fn discarded_prepared_targets_are_removed_from_inventory() {
        reset_prepared_window_inventory();
        reserve_prepared_window(WindowName::Main, "main-prewarm".to_string());

        assert!(discard_prepared_window(WindowName::Main));
        assert!(prepared_window_targets().is_empty());
    }

    #[test]
    fn discarded_prepared_targets_stay_absent_during_future_open_flow() {
        reset_prepared_window_inventory();
        reserve_prepared_window(WindowName::Main, "main-prewarm".to_string());

        assert!(discard_prepared_window(WindowName::Main));

        let consumed_prepared_target = take_prepared_window(WindowName::Main);

        assert!(consumed_prepared_target.is_none());
        assert!(prepared_window_targets().is_empty());
    }

    #[test]
    fn prewarm_creates_real_hidden_backend_window_state() {
        reset_prepared_window_inventory();

        reserve_prepared_window(WindowName::Main, "main-prewarm".to_string());

        let prepared = prepared_window_targets();
        assert_eq!(prepared, vec![WindowName::Main]);
        assert_eq!(prepared_window_label(WindowName::Main).as_deref(), Some("main-prewarm"));
        assert!(take_prepared_window(WindowName::Main).is_some());
        assert!(prepared_window_targets().is_empty());
    }

    #[test]
    fn taking_prepared_window_consumes_authoritative_backend_state_once() {
        reset_prepared_window_inventory();
        reserve_prepared_window(WindowName::Main, "main-prewarm".to_string());

        assert!(take_prepared_window(WindowName::Main).is_some());
        assert!(take_prepared_window(WindowName::Main).is_none());
    }
}
