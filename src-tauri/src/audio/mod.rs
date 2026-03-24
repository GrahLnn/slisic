use crate::domain::music::normalization;
use audio_playback::{
    ensure_debug_mode_available, generate_debug_spectrogram_with_binary, run_audio_debug_probe,
    AudioDebugProbeRequest, AudioDebugProbeResult, AudioDebugSpectrogram,
    AudioDebugSpectrogramRequest, AudioEndedPayload, AudioEventSink, AudioFailedPayload,
    AudioPausedPayload, AudioPlayAck, AudioPlayRequest, AudioResumedPayload, AudioStatus,
    AudioStoppedPayload, EngineRequestError, Playback, PlaybackNormalization, PlaybackRequest,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Event)]
pub struct AudioState {
    pub path: Option<String>,
    pub playing: bool,
    pub paused: bool,
    pub position_ms: u32,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct AudioEnded {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct AudioStopped {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct AudioPaused {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct AudioResumed {
    pub session_id: u64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type, PartialEq, Eq, Event)]
pub struct AudioFailed {
    pub session_id: u64,
    pub path: String,
    pub action: String,
    pub error: String,
}

impl From<AudioStatus> for AudioState {
    fn from(value: AudioStatus) -> Self {
        Self {
            path: value.path,
            playing: value.playing,
            paused: value.paused,
            position_ms: value.position_ms,
            duration_ms: value.duration_ms,
        }
    }
}

impl From<AudioEndedPayload> for AudioEnded {
    fn from(value: AudioEndedPayload) -> Self {
        Self {
            session_id: value.session_id,
            path: value.path,
        }
    }
}

impl From<AudioStoppedPayload> for AudioStopped {
    fn from(value: AudioStoppedPayload) -> Self {
        Self {
            session_id: value.session_id,
            path: value.path,
        }
    }
}

impl From<AudioPausedPayload> for AudioPaused {
    fn from(value: AudioPausedPayload) -> Self {
        Self {
            session_id: value.session_id,
            path: value.path,
        }
    }
}

impl From<AudioResumedPayload> for AudioResumed {
    fn from(value: AudioResumedPayload) -> Self {
        Self {
            session_id: value.session_id,
            path: value.path,
        }
    }
}

impl From<AudioFailedPayload> for AudioFailed {
    fn from(value: AudioFailedPayload) -> Self {
        Self {
            session_id: value.session_id,
            path: value.path,
            action: value.action,
            error: value.error,
        }
    }
}

struct TauriAudioEventSink {
    app: AppHandle,
}

impl TauriAudioEventSink {
    fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl AudioEventSink for TauriAudioEventSink {
    fn emit_state(&self, status: &AudioStatus) {
        AudioState::from(status.clone()).emit(&self.app).ok();
    }

    fn emit_ended(&self, payload: &AudioEndedPayload) {
        AudioEnded::from(payload.clone()).emit(&self.app).ok();
    }

    fn emit_stopped(&self, payload: &AudioStoppedPayload) {
        AudioStopped::from(payload.clone()).emit(&self.app).ok();
    }

    fn emit_paused(&self, payload: &AudioPausedPayload) {
        AudioPaused::from(payload.clone()).emit(&self.app).ok();
    }

    fn emit_resumed(&self, payload: &AudioResumedPayload) {
        AudioResumed::from(payload.clone()).emit(&self.app).ok();
    }

    fn emit_failed(&self, payload: &AudioFailedPayload) {
        AudioFailed::from(payload.clone()).emit(&self.app).ok();
    }
}

static ENGINE: OnceLock<Mutex<Option<Playback>>> = OnceLock::new();

fn engine_slot() -> &'static Mutex<Option<Playback>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

fn ensure_engine(app: &AppHandle) -> Result<Playback, String> {
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| "audio engine lock poisoned".to_string())?;

    if let Some(playback) = guard.as_ref() {
        return Ok(playback.clone());
    }

    let ffmpeg = crate::utils::ffmpeg::ensure_ffmpeg(app)?;
    let playback = Playback::builder(ffmpeg)
        .event_sink(Arc::new(TauriAudioEventSink::new(app.clone())))
        .build()?;
    *guard = Some(playback.clone());
    Ok(playback)
}

fn current_engine() -> Result<Option<Playback>, String> {
    engine_slot()
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "audio engine lock poisoned".to_string())
}

fn reset_engine() {
    if let Ok(mut guard) = engine_slot().lock() {
        *guard = None;
    }
}

async fn send_cmd<T, F, Fut>(app: AppHandle, mut op: F) -> Result<T, String>
where
    F: FnMut(Playback) -> Fut,
    Fut: Future<Output = Result<T, EngineRequestError>>,
{
    let mut last_error = "audio engine unavailable".to_string();

    for _ in 0..2 {
        let engine = ensure_engine(&app)?;
        match op(engine).await {
            Ok(value) => return Ok(value),
            Err(error) if error.should_reset() => {
                reset_engine();
                last_error = error.to_string();
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    Err(last_error)
}

async fn send_cmd_if_engine<T, F, Fut>(mut op: F, fallback: impl FnOnce() -> T) -> Result<T, String>
where
    F: FnMut(Playback) -> Fut,
    Fut: Future<Output = Result<T, EngineRequestError>>,
{
    let Some(engine) = current_engine()? else {
        return Ok(fallback());
    };

    match op(engine).await {
        Ok(value) => Ok(value),
        Err(error) if error.should_reset() => {
            reset_engine();
            Ok(fallback())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn audio_play(app: AppHandle, req: AudioPlayRequest) -> Result<AudioPlayAck, String> {
    let normalization::PlaybackNormalization {
        target_lufs,
        integrated_lufs,
        true_peak_dbtp,
    } = normalization::resolve_playback_normalization(&app, &req.path).await?;

    send_cmd(app, move |engine| {
        let request = PlaybackRequest::new(req.path.clone())
            .with_session_id(req.session_id)
            .with_normalization(PlaybackNormalization {
                target_lufs,
                integrated_lufs,
                true_peak_dbtp,
            });
        async move { engine.play_request(request).await }
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_pause(app: AppHandle) -> Result<(), String> {
    let _ = app;
    send_cmd_if_engine(|engine| async move { engine.pause().await }, || ()).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_resume(app: AppHandle) -> Result<(), String> {
    let _ = app;
    send_cmd_if_engine(|engine| async move { engine.resume().await }, || ()).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_stop(app: AppHandle) -> Result<(), String> {
    let _ = app;
    send_cmd_if_engine(|engine| async move { engine.stop().await }, || ()).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_status(app: AppHandle) -> Result<AudioStatus, String> {
    let _ = app;
    send_cmd_if_engine(
        |engine| async move { engine.status().await },
        || AudioStatus {
            path: None,
            playing: false,
            paused: false,
            position_ms: 0,
            duration_ms: None,
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_debug_spectrogram(
    app: AppHandle,
    req: AudioDebugSpectrogramRequest,
) -> Result<AudioDebugSpectrogram, String> {
    ensure_debug_mode_available("audio_debug_spectrogram")?;
    let ffmpeg = crate::utils::ffmpeg::ensure_ffmpeg(&app)?;

    tokio::task::spawn_blocking(move || {
        generate_debug_spectrogram_with_binary(ffmpeg.as_path(), req)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn audio_debug_pipeline_probe(
    app: AppHandle,
    req: AudioDebugProbeRequest,
) -> Result<AudioDebugProbeResult, String> {
    ensure_debug_mode_available("audio_debug_pipeline_probe")?;
    let ffmpeg = crate::utils::ffmpeg::ensure_ffmpeg(&app)?;
    let mut output_root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    output_root.push("debug");
    output_root.push("audio-probe");

    tokio::task::spawn_blocking(move || {
        run_audio_debug_probe(ffmpeg.as_path(), output_root.as_path(), req)
    })
    .await
    .map_err(|e| e.to_string())?
}
