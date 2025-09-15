use crate::{
    domain::models::music::{download_ok, DownloadAnswer},
    utils::{
        config::resolve_save_path,
        ytdlp::{process_entry, Entry, ProcessResult},
    },
};
use anyhow::Result;
use std::{
    fs,
    sync::{Arc, OnceLock},
};
use tauri_specta::Event;
use tokio::sync::mpsc;

impl From<ProcessResult> for DownloadAnswer {
    fn from(d: ProcessResult) -> Self {
        Self {
            path: d.saved_path,
            name: d.name,
            playlist: d.playlist,
        }
    }
}

// 全局 Sender
static DOWNLOAD_TX: OnceLock<mpsc::Sender<Entry>> = OnceLock::new();

pub async fn finalize_process(app: &tauri::AppHandle, result: ProcessResult) {
    // 清理 working 目录（可容错）
    if let Err(e) = fs::remove_dir_all(&result.working_path) {
        eprintln!("[download] cleanup failed: {}", e);
    }

    // 业务回调（比如写 DB / 通知 UI）
    match download_ok(app, result.clone().into()).await {
        Ok(()) => {
            // 广播事件给前端（ProcessResult #[derive(Event)] 已就绪）
            result.emit(app).ok();
        }
        Err(e) => {
            eprintln!("[download] download_ok failed: {}", e);
        }
    }
}

/// 在 Tauri setup 里调用：初始化队列 + 启动单个 worker 循环
pub fn init_global_download_queue(app: tauri::AppHandle, capacity: usize) -> Result<()> {
    let (tx, mut rx) = mpsc::channel::<Entry>(capacity);
    // 全局注册
    let _ = DOWNLOAD_TX.set(tx);
    let base_folder = resolve_save_path(app.clone()).map_err(anyhow::Error::msg)?;
    let base_folder = Arc::new(base_folder);

    // 单 worker 循环（需要多 worker 就开多个 spawn）
    tauri::async_runtime::spawn(async move {
        while let Some(mut job) = rx.recv().await {
            let res = process_entry(app.clone(), &base_folder, &mut job, &[], &[]).await;

            match res {
                Ok(result) => finalize_process(&app, result).await,
                Err(e) => println!("download error: {}", e),
            }
        }
    });
    Ok(())
}

/// 对外暴露：把任务扔进全局队列
pub async fn enqueue(job: Entry) -> Result<(), String> {
    let tx = DOWNLOAD_TX.get().ok_or("download queue not initialized")?;
    tx.send(job).await.map_err(|e| e.to_string())
}

/// 如果你不想 await，可用 try_send（失败就返回 Busy）
pub fn try_enqueue(job: Entry) -> Result<(), String> {
    let tx = DOWNLOAD_TX.get().ok_or("download queue not initialized")?;
    tx.try_send(job).map_err(|e| e.to_string())
}
