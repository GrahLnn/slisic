use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
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

const PREWARM_TARGET_PER_WINDOW: usize = 1;

static PREWARM_MAIN_PENDING: LazyLock<Mutex<Vec<String>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
static PREWARM_MAIN_READY: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowLifecycleState {
    descriptor: WindowIdentityDescriptor,
    destroyed: bool,
}

static WINDOW_LIFECYCLE: LazyLock<Mutex<Vec<WindowLifecycleState>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum WindowVisibilityKind {
    UserVisible,
    Prepared,
}

impl WindowVisibilityKind {
    pub const fn is_user_visible(self) -> bool {
        matches!(self, Self::UserVisible)
    }

    pub const fn is_prepared(self) -> bool {
        matches!(self, Self::Prepared)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct WindowIdentityDescriptor {
    pub window: Option<WindowName>,
    pub visibility: WindowVisibilityKind,
    pub label: String,
    pub is_primary_main: bool,
}

impl WindowIdentityDescriptor {
    pub fn from_label(label: &str) -> Self {
        let (window, visibility) = descriptor_parts_from_label(label);
        Self {
            window,
            visibility,
            label: label.to_string(),
            is_primary_main: label == WindowName::Main.as_str(),
        }
    }

    pub const fn is_prepared(&self) -> bool {
        self.visibility.is_prepared()
    }

    pub const fn is_user_visible(&self) -> bool {
        self.visibility.is_user_visible()
    }

    pub fn promoted_to_user_visible(&self) -> Self {
        let mut descriptor = self.clone();
        descriptor.visibility = WindowVisibilityKind::UserVisible;
        if let Some(window) = descriptor.window {
            descriptor.label = window.as_str().to_string();
            descriptor.is_primary_main = true;
        }
        descriptor
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct WindowKindInfo {
    pub descriptor: WindowIdentityDescriptor,
    pub window: Option<WindowName>,
    pub is_prewarm: bool,
    pub label: String,
    pub is_primary_main: bool,
}

impl From<WindowIdentityDescriptor> for WindowKindInfo {
    fn from(descriptor: WindowIdentityDescriptor) -> Self {
        Self {
            window: descriptor.window,
            is_prewarm: descriptor.is_prepared(),
            label: descriptor.label.clone(),
            is_primary_main: descriptor.is_primary_main,
            descriptor,
        }
    }
}

fn prewarm_prefix(name: WindowName) -> String {
    format!("{}-prewarm-", name.as_str())
}

fn is_prewarm_label_for(name: WindowName, label: &str) -> bool {
    let prefix = prewarm_prefix(name);
    label.starts_with(&prefix)
}

fn is_window_label_for(name: WindowName, label: &str) -> bool {
    if label == name.as_str() {
        return true;
    }

    let window_prefix = format!("{}-", name.as_str());
    label.starts_with(&window_prefix) && !is_prewarm_label_for(name, label)
}

fn descriptor_parts_from_label(label: &str) -> (Option<WindowName>, WindowVisibilityKind) {
    for name in WindowName::ALL {
        if is_window_label_for(name, label) {
            return (Some(name), WindowVisibilityKind::UserVisible);
        }

        if is_prewarm_label_for(name, label) {
            return (Some(name), WindowVisibilityKind::Prepared);
        }
    }

    (None, WindowVisibilityKind::UserVisible)
}

pub fn window_kind_from_label(label: &str) -> (Option<WindowName>, bool) {
    let descriptor = WindowIdentityDescriptor::from_label(label);
    (descriptor.window, descriptor.is_prepared())
}

#[tauri::command]
#[specta::specta]
pub fn get_window_kind(window: WebviewWindow) -> WindowKindInfo {
    current_window_descriptor(window.label()).into()
}

pub fn should_exit_on_window_close(app: &AppHandle, closing_label: &str) -> bool {
    register_live_window(closing_label);
    let closing_descriptor = current_window_descriptor(closing_label);
    if !closing_descriptor.is_user_visible() {
        return false;
    }

    let visible_window_count = snapshot_live_descriptors(app)
        .into_iter()
        .filter(WindowIdentityDescriptor::is_user_visible)
        .count();

    visible_window_count <= 1
}

pub fn close_all_prewarm_windows(app: &AppHandle) {
    let labels = app
        .webview_windows()
        .keys()
        .filter(|label| matches!(window_kind_from_label(label), (Some(_), true)))
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

fn register_live_window(label: &str) -> WindowIdentityDescriptor {
    let descriptor = WindowIdentityDescriptor::from_label(label);
    upsert_live_window_descriptor(descriptor)
}

fn upsert_live_window_descriptor(descriptor: WindowIdentityDescriptor) -> WindowIdentityDescriptor {
    let mut lifecycle = WINDOW_LIFECYCLE
        .lock()
        .expect("window lifecycle should be lockable");

    if let Some(state) = lifecycle
        .iter_mut()
        .find(|state| state.descriptor.label == descriptor.label)
    {
        state.descriptor = descriptor.clone();
        state.destroyed = false;
        return descriptor;
    }

    lifecycle.push(WindowLifecycleState {
        descriptor: descriptor.clone(),
        destroyed: false,
    });
    descriptor
}

fn current_window_descriptor(label: &str) -> WindowIdentityDescriptor {
    let lifecycle = WINDOW_LIFECYCLE
        .lock()
        .expect("window lifecycle should be lockable");

    lifecycle
        .iter()
        .find(|state| !state.destroyed && state.descriptor.label == label)
        .map(|state| state.descriptor.clone())
        .unwrap_or_else(|| WindowIdentityDescriptor::from_label(label))
}

fn promote_live_window_descriptor(label: &str) -> WindowIdentityDescriptor {
    let descriptor = current_window_descriptor(label).promoted_to_user_visible();
    upsert_live_window_descriptor(descriptor)
}

fn live_window_descriptor_for_label(label: &str) -> Option<WindowIdentityDescriptor> {
    let lifecycle = WINDOW_LIFECYCLE
        .lock()
        .expect("window lifecycle should be lockable");

    lifecycle
        .iter()
        .find(|state| !state.destroyed && state.descriptor.label == label)
        .map(|state| state.descriptor.clone())
}

fn destroy_window_lifecycle(label: &str) -> Option<WindowIdentityDescriptor> {
    let mut lifecycle = WINDOW_LIFECYCLE
        .lock()
        .expect("window lifecycle should be lockable");
    lifecycle
        .iter()
        .position(|state| state.descriptor.label == label)
        .map(|index| lifecycle.swap_remove(index).descriptor)
}

fn snapshot_live_descriptors(app: &AppHandle) -> Vec<WindowIdentityDescriptor> {
    let live_labels = app
        .webview_windows()
        .keys()
        .cloned()
        .collect::<HashSet<_>>();

    let mut lifecycle = WINDOW_LIFECYCLE
        .lock()
        .expect("window lifecycle should be lockable");
    lifecycle.retain(|state| !state.destroyed && live_labels.contains(&state.descriptor.label));

    for label in &live_labels {
        if let Some(state) = lifecycle.iter_mut().find(|state| state.descriptor.label == *label) {
            let fallback_descriptor = WindowIdentityDescriptor::from_label(label);
            state.descriptor.window = fallback_descriptor.window;
            state.descriptor.is_primary_main = fallback_descriptor.is_primary_main;
            state.destroyed = false;
        } else {
            lifecycle.push(WindowLifecycleState {
                descriptor: WindowIdentityDescriptor::from_label(label),
                destroyed: false,
            });
        }
    }

    lifecycle
        .iter()
        .map(|state| state.descriptor.clone())
        .collect()
}

pub fn handle_window_destroyed(label: &str) -> bool {
    let canonical_label = live_window_descriptor_for_label(label)
        .map(|descriptor| descriptor.label)
        .unwrap_or_else(|| label.to_string());
    let removed = destroy_window_lifecycle(&canonical_label).is_some();

    if matches!(window_kind_from_label(label), (Some(_), true)) {
        PREWARM_MAIN_PENDING
            .lock()
            .expect("prewarm pending list should be lockable")
            .retain(|value| value != label);
        PREWARM_MAIN_READY
            .lock()
            .expect("prewarm ready list should be lockable")
            .retain(|value| value != label);
    }

    removed
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

    pub const fn prewarm_target(&self) -> usize {
        PREWARM_TARGET_PER_WINDOW
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

fn next_prewarm_label(name: WindowName, app: &tauri::AppHandle) -> String {
    let prefix = prewarm_prefix(name);
    for index in 1.. {
        let label = format!("{prefix}{index}");
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

fn take_ready_window(app: &tauri::AppHandle, name: WindowName) -> Option<WebviewWindow> {
    let mut ready = PREWARM_MAIN_READY
        .lock()
        .expect("prewarm ready list should be lockable");
    prune_labels(app, &mut ready);

    while let Some(index) = ready
        .iter()
        .position(|label| is_prewarm_label_for(name, label))
    {
        let label = ready.swap_remove(index);
        if let Some(window) = app.get_webview_window(&label) {
            return Some(window);
        }
    }

    None
}

pub fn mark_window_ready(label: &str) -> bool {
    if !matches!(window_kind_from_label(label), (Some(_), true)) {
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

pub fn ensure_window_prewarm(app: &tauri::AppHandle, name: WindowName) {
    let pending_len = {
        let mut pending = PREWARM_MAIN_PENDING
            .lock()
            .expect("prewarm pending list should be lockable");
        prune_labels(app, &mut pending);
        pending
            .iter()
            .filter(|label| is_prewarm_label_for(name, label))
            .count()
    };

    let ready_len = {
        let mut ready = PREWARM_MAIN_READY
            .lock()
            .expect("prewarm ready list should be lockable");
        prune_labels(app, &mut ready);
        ready
            .iter()
            .filter(|label| is_prewarm_label_for(name, label))
            .count()
    };

    let total = pending_len + ready_len;
    if total >= name.prewarm_target() {
        return;
    }

    for _ in total..name.prewarm_target() {
        let label = next_prewarm_label(name, app);
        match build_window(app, label.clone(), name.as_str(), false) {
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

pub fn ensure_prewarm_for_existing_windows(app: &tauri::AppHandle) {
    let existing_names = snapshot_live_descriptors(app)
        .into_iter()
        .filter_map(|label| {
            let name = label.window;
            let is_prewarm = label.is_prepared();
            if is_prewarm {
                None
            } else {
                name
            }
        })
        .collect::<HashSet<_>>();

    for name in existing_names {
        ensure_window_prewarm(app, name);
    }
}

#[specta::specta]
#[tauri::command]
pub async fn create_window(
    app: tauri::AppHandle,
    name: WindowName,
    options: Option<CreateWindowOptions>,
) {
    if let Some(window) = take_ready_window(&app, name) {
        promote_live_window_descriptor(window.label());
        apply_window_options(&window, options.as_ref());
        let _ = window.show();
        let _ = window.set_focus();
        ensure_window_prewarm(&app, name);
        return;
    }

    let label = next_label(name, &app);
    match build_window(&app, label, name.as_str(), true) {
        Ok(window) => {
            apply_window_options(&window, options.as_ref());
            apply_window_setup(&window, false);
            ensure_window_prewarm(&app, name);
        }
        Err(error) => {
            eprintln!("Failed to create window: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        current_window_descriptor, destroy_window_lifecycle, handle_window_destroyed,
        promote_live_window_descriptor, register_live_window, window_kind_from_label,
        WindowIdentityDescriptor, WindowLifecycleState, WindowName, WindowVisibilityKind,
        WINDOW_LIFECYCLE, PREWARM_MAIN_PENDING, PREWARM_MAIN_READY,
    };

    fn reset_window_lifecycle_for_test() {
        WINDOW_LIFECYCLE
            .lock()
            .expect("window lifecycle should be lockable")
            .clear();
        PREWARM_MAIN_PENDING
            .lock()
            .expect("prewarm pending list should be lockable")
            .clear();
        PREWARM_MAIN_READY
            .lock()
            .expect("prewarm ready list should be lockable")
            .clear();
    }

    #[test]
    fn descriptor_true_positive_classifies_user_visible_and_prepared_windows_explicitly() {
        let visible = WindowIdentityDescriptor::from_label("main-2");
        assert_eq!(visible.window, Some(WindowName::Main));
        assert_eq!(visible.visibility, WindowVisibilityKind::UserVisible);
        assert!(visible.is_user_visible());
        assert!(!visible.is_prepared());

        let prepared = WindowIdentityDescriptor::from_label("main-prewarm-1");
        assert_eq!(prepared.window, Some(WindowName::Main));
        assert_eq!(prepared.visibility, WindowVisibilityKind::Prepared);
        assert!(prepared.is_prepared());
        assert!(!prepared.is_user_visible());
    }

    #[test]
    fn descriptor_false_negative_guard_unknown_labels_default_to_user_visible_without_prewarm_heuristic(
    ) {
        let descriptor = WindowIdentityDescriptor::from_label("unknown-window");
        assert_eq!(descriptor.window, None);
        assert_eq!(descriptor.visibility, WindowVisibilityKind::UserVisible);
        assert!(descriptor.is_user_visible());
    }

    #[test]
    fn descriptor_false_positive_guard_compatibility_lookup_matches_descriptor_truth() {
        for label in ["main", "main-3", "main-prewarm-4", "unknown-window"] {
            let descriptor = WindowIdentityDescriptor::from_label(label);
            let (window, is_prewarm) = window_kind_from_label(label);

            assert_eq!(window, descriptor.window);
            assert_eq!(is_prewarm, descriptor.is_prepared());
        }
    }

    #[test]
    fn descriptor_true_positive_promoted_prewarm_window_rewrites_canonical_lookup_truth() {
        reset_window_lifecycle_for_test();
        register_live_window("main-prewarm-1");

        let promoted = promote_live_window_descriptor("main-prewarm-1");
        let looked_up = current_window_descriptor("main");

        assert_eq!(promoted.label, "main");
        assert_eq!(promoted.visibility, WindowVisibilityKind::UserVisible);
        assert_eq!(looked_up, promoted);
        assert!(looked_up.is_user_visible());
        assert!(!looked_up.is_prepared());
    }

    #[test]
    fn descriptor_false_negative_guard_promoted_window_destroyed_cleanup_uses_promoted_canonical_label(
    ) {
        reset_window_lifecycle_for_test();
        register_live_window("main-prewarm-1");
        promote_live_window_descriptor("main-prewarm-1");

        let removed = handle_window_destroyed("main");
        let lifecycle = WINDOW_LIFECYCLE
            .lock()
            .expect("window lifecycle should be lockable")
            .clone();

        assert!(removed);
        assert!(lifecycle.is_empty());
    }

    #[test]
    fn graceful_shutdown_true_positive_closing_final_user_visible_window_exits_even_with_prepared_windows_remaining(
    ) {
        let open_labels = ["main", "main-prewarm-1", "main-prewarm-2"];
        let closing_label = "main";

        let should_exit = WindowIdentityDescriptor::from_label(closing_label).is_user_visible()
            && open_labels
                .iter()
                .map(|label| WindowIdentityDescriptor::from_label(label))
                .filter(WindowIdentityDescriptor::is_user_visible)
                .count()
                <= 1;

        assert!(should_exit);
    }

    #[test]
    fn graceful_shutdown_true_negative_prepared_window_close_does_not_count_as_last_user_window() {
        let open_labels = ["main", "main-prewarm-1"];
        let closing_label = "main-prewarm-1";

        let should_exit = WindowIdentityDescriptor::from_label(closing_label).is_user_visible()
            && open_labels
                .iter()
                .map(|label| WindowIdentityDescriptor::from_label(label))
                .filter(WindowIdentityDescriptor::is_user_visible)
                .count()
                <= 1;

        assert!(!should_exit);
    }

    #[test]
    fn graceful_shutdown_false_negative_guard_keeps_app_alive_while_another_user_visible_window_exists(
    ) {
        let open_labels = ["main", "main-2", "main-prewarm-1"];
        let closing_label = "main-2";

        let should_exit = WindowIdentityDescriptor::from_label(closing_label).is_user_visible()
            && open_labels
                .iter()
                .map(|label| WindowIdentityDescriptor::from_label(label))
                .filter(WindowIdentityDescriptor::is_user_visible)
                .count()
                <= 1;

        assert!(!should_exit);
    }

    #[test]
    fn graceful_shutdown_false_negative_guard_promoted_descriptor_truth_counts_reused_prewarm_window_as_user_visible(
    ) {
        reset_window_lifecycle_for_test();
        register_live_window("main-prewarm-1");
        let promoted = promote_live_window_descriptor("main-prewarm-1");

        let should_exit = promoted.is_user_visible()
            && [promoted.clone()]
                .into_iter()
                .filter(WindowIdentityDescriptor::is_user_visible)
                .count()
                <= 1;

        assert_eq!(promoted.label, "main");
        assert!(should_exit);
    }

    #[test]
    fn graceful_shutdown_false_positive_guard_promoted_descriptor_truth_does_not_treat_reused_prewarm_window_as_prepared_only(
    ) {
        reset_window_lifecycle_for_test();
        register_live_window("main-prewarm-1");
        let promoted = promote_live_window_descriptor("main-prewarm-1");

        let should_exit = promoted.is_user_visible()
            && [WindowIdentityDescriptor::from_label("main-2"), promoted]
                .into_iter()
                .filter(WindowIdentityDescriptor::is_user_visible)
                .count()
                <= 1;

        assert!(!should_exit);
    }

    #[test]
    fn destroyed_window_true_positive_removes_only_matching_stale_lifecycle_ownership() {
        reset_window_lifecycle_for_test();
        register_live_window("main");
        register_live_window("main-2");
        register_live_window("main-prewarm-1");

        let removed = handle_window_destroyed("main-2");
        let lifecycle = WINDOW_LIFECYCLE
            .lock()
            .expect("window lifecycle should be lockable")
            .clone();

        assert!(removed);
        assert_eq!(
            lifecycle,
            vec![
                WindowLifecycleState {
                    descriptor: WindowIdentityDescriptor::from_label("main"),
                    destroyed: false,
                },
                WindowLifecycleState {
                    descriptor: WindowIdentityDescriptor::from_label("main-prewarm-1"),
                    destroyed: false,
                },
            ]
        );
    }

    #[test]
    fn destroyed_window_true_positive_clears_matching_prewarm_bookkeeping() {
        reset_window_lifecycle_for_test();
        register_live_window("main-prewarm-1");
        PREWARM_MAIN_PENDING
            .lock()
            .expect("prewarm pending list should be lockable")
            .extend(["main-prewarm-1".to_string(), "main-prewarm-2".to_string()]);
        PREWARM_MAIN_READY
            .lock()
            .expect("prewarm ready list should be lockable")
            .extend(["main-prewarm-1".to_string(), "main-prewarm-3".to_string()]);

        let removed = handle_window_destroyed("main-prewarm-1");

        assert!(removed);
        assert_eq!(
            PREWARM_MAIN_PENDING
                .lock()
                .expect("prewarm pending list should be lockable")
                .clone(),
            vec!["main-prewarm-2".to_string()]
        );
        assert_eq!(
            PREWARM_MAIN_READY
                .lock()
                .expect("prewarm ready list should be lockable")
                .clone(),
            vec!["main-prewarm-3".to_string()]
        );
    }

    #[test]
    fn destroyed_window_false_negative_guard_late_destroy_for_unknown_label_cannot_clear_other_window_ownership(
    ) {
        reset_window_lifecycle_for_test();
        register_live_window("main");
        register_live_window("main-2");

        let removed = handle_window_destroyed("main-99");
        let lifecycle = WINDOW_LIFECYCLE
            .lock()
            .expect("window lifecycle should be lockable")
            .clone();

        assert!(!removed);
        assert_eq!(
            lifecycle,
            vec![
                WindowLifecycleState {
                    descriptor: WindowIdentityDescriptor::from_label("main"),
                    destroyed: false,
                },
                WindowLifecycleState {
                    descriptor: WindowIdentityDescriptor::from_label("main-2"),
                    destroyed: false,
                },
            ]
        );
    }

    #[test]
    fn destroyed_window_false_positive_guard_destroyed_identity_is_removed_instead_of_marked_live() {
        reset_window_lifecycle_for_test();
        register_live_window("main");

        let removed_descriptor = destroy_window_lifecycle("main");
        let lifecycle = WINDOW_LIFECYCLE
            .lock()
            .expect("window lifecycle should be lockable")
            .clone();

        assert_eq!(removed_descriptor, Some(WindowIdentityDescriptor::from_label("main")));
        assert!(lifecycle.is_empty());
    }
}
