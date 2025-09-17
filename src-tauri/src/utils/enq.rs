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
use tokio::sync::{mpsc, Mutex};

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

pub fn init_global_download_queue(app: tauri::AppHandle, capacity: usize) -> Result<()> {
    let (tx, rx) = mpsc::channel::<Entry>(capacity);
    // 全局注册
    let _ = DOWNLOAD_TX.set(tx);

    let base_folder = resolve_save_path(app.clone()).map_err(anyhow::Error::msg)?;
    let base_folder = Arc::new(base_folder);

    // 把 Receiver 包一层，便于多 worker 共享
    let rx = Arc::new(Mutex::new(rx));

    for _ in 0..4 {
        let app = app.clone();
        let base = base_folder.clone();
        let rx_arc = rx.clone();

        tauri::async_runtime::spawn(async move {
            loop {
                // 只在拿任务时持锁，拿到就立刻放
                let mut guard = rx_arc.lock().await;
                let mut job = match guard.recv().await {
                    Some(j) => j,
                    None => break, // 所有 sender 都 drop 时退出
                };
                drop(guard);

                let res = process_entry(app.clone(), &base, &mut job, &[], &[]).await;
                match res {
                    Ok(result) => finalize_process(&app, result).await,
                    Err(e) => eprintln!("download error: {e}"),
                }
            }
        });
    }

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
