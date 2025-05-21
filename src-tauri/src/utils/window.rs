use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};

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
    let window = app.get_webview_window("main").unwrap();

    // ① 鼠标位置（物理像素，桌面左上角原点）
    let cursor = window.cursor_position().unwrap(); // PhysicalPosition<f64>

    // ② 窗口外框左上角（物理像素，桌面左上角原点）
    let win_pos = window.outer_position().unwrap(); // PhysicalPosition<i32>

    // ③ 窗口尺寸（物理像素）
    let win_size = window.outer_size().unwrap(); // PhysicalSize<u32>

    // ④ 计算鼠标在窗口坐标系里的相对位置
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
        pixel_ratio: window.scale_factor().unwrap(),
    })
}
