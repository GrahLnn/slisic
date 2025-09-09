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
        }
    }
}

// 全局 Sender
static DOWNLOAD_TX: OnceLock<mpsc::Sender<Entry>> = OnceLock::new();

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
                Ok(result) => {
                    fs::remove_dir_all(&result.working_path).ok();
                    match download_ok(&app, result.clone().into()).await {
                        Ok(_) => {
                            result.emit(&app).ok();
                        }
                        Err(e) => {
                            println!("download error: {}", e);
                        }
                    }
                }
                Err(e) => {
                    println!("download error: {}", e);
                }
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
