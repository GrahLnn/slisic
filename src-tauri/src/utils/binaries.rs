use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BIN_DIR_NAME: &str = "bin";
const GITHUB_API_BASE: &str = "https://api.github.com/repos";
const GITHUB_RELAY_BASE: &str = "https://xget.r2g2.org/gh";
const UPDATE_INTERVAL: Duration = Duration::from_secs(60 * 60 * 5);
const ACTIVATION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const BINARY_HTTP_RETRY_ATTEMPTS: usize = 3;
const BINARY_HTTP_RETRY_BASE_DELAY_MS: u64 = 350;
const USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));
static BINARY_OPERATION_LOCKS: LazyLock<[Mutex<()>; 2]> =
    LazyLock::new(|| [Mutex::new(()), Mutex::new(())]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ManagedBinary {
    Ffmpeg,
    YtDlp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Raw,
    Zip,
    TarXz,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitHubReleaseAssetMatcher {
    Exact(&'static str),
    Suffix(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DownloadPlan {
    install_name: &'static str,
    checksum_asset_name: Option<String>,
    download_url: String,
    checksum_url: Option<String>,
    archive_kind: ArchiveKind,
}

pub(crate) struct StagedBinary {
    pub(crate) executable_path: PathBuf,
    pub(crate) remote: RemoteIdentity,
    pub(crate) stage_dir: PathBuf,
    pub(crate) version: Option<String>,
}

#[derive(Clone)]
pub(crate) struct BinaryMaintenanceActivity {
    has_active_player_binary_tasks: Arc<dyn Fn() -> bool + Send + Sync>,
    has_active_download_tasks: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubLatestRelease {
    assets: Vec<GitHubLatestReleaseAsset>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubLatestReleaseAsset {
    pub(crate) name: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RemoteIdentity {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BinaryInstallState {
    pub(crate) remote: RemoteIdentity,
    pub(crate) installed_version: Option<String>,
}

impl BinaryMaintenanceActivity {
    pub(crate) fn new(
        has_active_player_binary_tasks: impl Fn() -> bool + Send + Sync + 'static,
        has_active_download_tasks: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            has_active_player_binary_tasks: Arc::new(has_active_player_binary_tasks),
            has_active_download_tasks: Arc::new(has_active_download_tasks),
        }
    }

    pub(crate) fn is_busy(&self) -> bool {
        (self.has_active_player_binary_tasks)() || (self.has_active_download_tasks)()
    }
}

impl ManagedBinary {
    fn all() -> [Self; 2] {
        [Self::Ffmpeg, Self::YtDlp]
    }

    fn key(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::YtDlp => "yt-dlp",
        }
    }

    fn state_file_name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg.state.json",
            Self::YtDlp => "yt-dlp.state.json",
        }
    }
}

impl RemoteIdentity {
    fn from_headers(headers: &reqwest::header::HeaderMap) -> Self {
        Self {
            etag: headers
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            last_modified: headers
                .get(reqwest::header::LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            content_length: headers
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok()),
        }
    }

    fn is_empty(&self) -> bool {
        self.etag.is_none() && self.last_modified.is_none() && self.content_length.is_none()
    }
}

/// Keep maintenance work off the startup critical path while still running an
/// immediate first sync as soon as the app is ready.
pub fn spawn_binary_maintenance(app: AppHandle, activity: BinaryMaintenanceActivity) {
    let builder = thread::Builder::new().name("binary-maintenance".to_string());
    if let Err(error) = builder.spawn(move || {
        run_maintenance_cycle(&app, &activity);
        loop {
            thread::sleep(UPDATE_INTERVAL);
            run_maintenance_cycle(&app, &activity);
        }
    }) {
        eprintln!("[binary-maintenance] failed to spawn worker: {error}");
    }
}

pub(crate) fn managed_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app_bin_dir(app)
}

pub(crate) fn ensure_managed_binary(
    app: &AppHandle,
    kind: ManagedBinary,
) -> Result<PathBuf, String> {
    with_binary_kind_lock(kind, || {
        let install_path = installed_bin_path(app, install_name_for_kind(kind))?;
        if install_path.exists() {
            return Ok(install_path);
        }

        let client = http_client()?;
        let plan = plan_for_current_platform(&client, kind)?;
        let state_path = install_state_path(app, kind)?;
        install_binary(app, kind, &plan, &install_path, &state_path, &client)?;
        Ok(install_path)
    })
}

fn run_maintenance_cycle(app: &AppHandle, activity: &BinaryMaintenanceActivity) {
    for kind in ManagedBinary::all() {
        if let Err(error) = maintain_binary(app, kind, activity) {
            eprintln!(
                "[binary-maintenance] {} maintenance failed: {}",
                kind.key(),
                error
            );
        }
    }
}

fn maintain_binary(
    app: &AppHandle,
    kind: ManagedBinary,
    activity: &BinaryMaintenanceActivity,
) -> Result<(), String> {
    let install_path = installed_bin_path(app, install_name_for_kind(kind))?;
    let client = http_client()?;
    let plan = plan_for_current_platform(&client, kind)?;
    let state_path = install_state_path(app, kind)?;

    if !install_path.exists() {
        return with_binary_kind_lock(kind, || {
            if install_path.exists() {
                return Ok(());
            }

            println!(
                "[binary-maintenance] {} missing, downloading latest managed copy",
                kind.key()
            );
            install_binary(app, kind, &plan, &install_path, &state_path, &client)
        });
    }

    let remote = match head_remote_identity(&client, &plan.download_url) {
        Ok(remote) => remote,
        Err(error) => {
            eprintln!(
                "[binary-maintenance] failed to inspect remote {} asset {}: {}",
                kind.key(),
                plan.download_url,
                error
            );
            return Ok(());
        }
    };

    let state = read_install_state(&state_path);
    if !needs_install_or_update(true, state.as_ref(), &remote) {
        return Ok(());
    }

    println!(
        "[binary-maintenance] {} remote asset changed, downloading managed update",
        kind.key()
    );
    let staged = stage_binary_update(app, kind, &plan, &client)?;
    activate_staged_binary_when_idle(kind, &install_path, &state_path, staged, activity)
}

pub(crate) fn with_binary_kind_lock<T>(
    kind: ManagedBinary,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    // Startup maintenance and on-demand ensure run on different call paths; the
    // lock must therefore be per binary kind, not one coarse global mutex.
    let _guard = binary_operation_lock(kind)
        .lock()
        .map_err(|_| format!("{} operation lock is poisoned", kind.key()))?;
    work()
}

fn binary_operation_lock(kind: ManagedBinary) -> &'static Mutex<()> {
    match kind {
        ManagedBinary::Ffmpeg => &BINARY_OPERATION_LOCKS[0],
        ManagedBinary::YtDlp => &BINARY_OPERATION_LOCKS[1],
    }
}

/// Persist the last remote identity so periodic update checks can stay on the
/// relay download path instead of depending on GitHub API metadata.
fn install_binary(
    app: &AppHandle,
    kind: ManagedBinary,
    plan: &DownloadPlan,
    install_path: &Path,
    state_path: &Path,
    client: &Client,
) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;

    let download_path = cache_dir.join(format!("{}.download", kind.key()));
    let remote = download_to_path(
        client,
        &plan.download_url,
        &download_path,
        checksum_for_plan(client, plan)?.as_deref(),
    )?;

    if let Some(parent) = install_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    match plan.archive_kind {
        ArchiveKind::Raw => replace_file(&download_path, install_path)?,
        ArchiveKind::Zip | ArchiveKind::TarXz => {
            extract_and_place_executable(&download_path, install_path, plan.archive_kind)?
        }
    }

    make_executable(install_path)?;
    remove_quarantine(install_path);

    let installed_version = read_binary_version(kind, install_path);
    write_install_state(
        state_path,
        &BinaryInstallState {
            remote,
            installed_version: installed_version.clone(),
        },
    )?;

    println!(
        "[binary-maintenance] {} ready at {}{}",
        kind.key(),
        install_path.display(),
        installed_version
            .as_deref()
            .map(|version| format!(" ({version})"))
            .unwrap_or_default()
    );

    Ok(())
}

fn stage_binary_update(
    app: &AppHandle,
    kind: ManagedBinary,
    plan: &DownloadPlan,
    client: &Client,
) -> Result<StagedBinary, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let stage_dir = cache_dir.join(format!("{}.staged", kind.key()));
    if stage_dir.exists() {
        let _ = fs::remove_dir_all(&stage_dir);
    }
    fs::create_dir_all(&stage_dir).map_err(|error| error.to_string())?;

    let download_path = stage_dir.join(format!("{}.download", kind.key()));
    let executable_path = stage_dir.join(plan.install_name);
    let remote = download_to_path(
        client,
        &plan.download_url,
        &download_path,
        checksum_for_plan(client, plan)?.as_deref(),
    )?;

    match plan.archive_kind {
        ArchiveKind::Raw => replace_file(&download_path, &executable_path)?,
        ArchiveKind::Zip | ArchiveKind::TarXz => {
            extract_and_place_executable(&download_path, &executable_path, plan.archive_kind)?
        }
    }

    make_executable(&executable_path)?;
    remove_quarantine(&executable_path);
    let version = read_binary_version(kind, &executable_path);

    Ok(StagedBinary {
        executable_path,
        remote,
        stage_dir,
        version,
    })
}

fn activate_staged_binary_when_idle(
    kind: ManagedBinary,
    install_path: &Path,
    state_path: &Path,
    staged: StagedBinary,
    activity: &BinaryMaintenanceActivity,
) -> Result<(), String> {
    let mut deferred_logged = false;
    loop {
        if activity.is_busy() {
            if !deferred_logged {
                println!(
                    "[binary-maintenance] {} update downloaded; activation deferred until playback and tasks are idle",
                    kind.key()
                );
                deferred_logged = true;
            }
            thread::sleep(ACTIVATION_RETRY_INTERVAL);
            continue;
        }

        let activated = with_binary_kind_lock(kind, || {
            if activity.is_busy() {
                return Ok(false);
            }

            activate_staged_binary(kind, install_path, state_path, &staged)?;
            Ok(true)
        })?;

        if activated {
            let _ = fs::remove_dir_all(&staged.stage_dir);
            return Ok(());
        }

        thread::sleep(ACTIVATION_RETRY_INTERVAL);
    }
}

pub(crate) fn activate_staged_binary(
    kind: ManagedBinary,
    install_path: &Path,
    state_path: &Path,
    staged: &StagedBinary,
) -> Result<(), String> {
    if let Some(parent) = install_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    replace_installed_binary(&staged.executable_path, install_path)?;
    make_executable(install_path)?;
    remove_quarantine(install_path);

    write_install_state(
        state_path,
        &BinaryInstallState {
            remote: staged.remote.clone(),
            installed_version: staged.version.clone(),
        },
    )?;

    println!(
        "[binary-maintenance] {} ready at {}{}",
        kind.key(),
        install_path.display(),
        staged
            .version
            .as_deref()
            .map(|version| format!(" ({version})"))
            .unwrap_or_default()
    );

    Ok(())
}

fn checksum_for_plan(client: &Client, plan: &DownloadPlan) -> Result<Option<String>, String> {
    let Some(checksum_url) = &plan.checksum_url else {
        return Ok(None);
    };
    let Some(asset_name) = plan.checksum_asset_name.as_deref() else {
        return Ok(None);
    };

    let response = match send_binary_http_with_retry(|| client.get(checksum_url.as_str())) {
        Ok(response) => response,
        Err(error) => {
            eprintln!(
                "[binary-maintenance] checksum fetch failed for {}: {}",
                checksum_url, error
            );
            return Ok(None);
        }
    };
    let sums = match response.text() {
        Ok(sums) => sums,
        Err(error) => {
            eprintln!(
                "[binary-maintenance] checksum body read failed for {}: {}",
                checksum_url, error
            );
            return Ok(None);
        }
    };

    Ok(parse_sha256(&sums, asset_name))
}

fn head_remote_identity(client: &Client, url: &str) -> Result<RemoteIdentity, String> {
    let response = send_binary_http_with_retry(|| client.head(url))?;
    Ok(RemoteIdentity::from_headers(response.headers()))
}

fn download_to_path(
    client: &Client,
    url: &str,
    dest: &Path,
    expected_sha256: Option<&str>,
) -> Result<RemoteIdentity, String> {
    let mut response = send_binary_http_with_retry(|| client.get(url))?;
    let remote = RemoteIdentity::from_headers(response.headers());

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut file = fs::File::create(dest).map_err(|error| error.to_string())?;
    let mut hasher = expected_sha256.map(|_| Sha256::new());
    copy_response_to_file(&mut response, &mut file, hasher.as_mut())?;

    if let (Some(expected), Some(hasher)) = (expected_sha256, hasher) {
        let actual = hex::encode(hasher.finalize());
        if actual != expected.to_lowercase() {
            let _ = fs::remove_file(dest);
            return Err(format!(
                "sha256 mismatch for {}: expected {}, got {}",
                url, expected, actual
            ));
        }
    }

    Ok(remote)
}

fn send_binary_http_with_retry(
    build_request: impl Fn() -> reqwest::blocking::RequestBuilder,
) -> Result<Response, String> {
    for attempt in 0..BINARY_HTTP_RETRY_ATTEMPTS {
        match build_request().send() {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    return Ok(response);
                }

                let error = binary_http_status_error(&response);
                if !should_retry_binary_http_status(status)
                    || attempt + 1 == BINARY_HTTP_RETRY_ATTEMPTS
                {
                    return Err(error);
                }
            }
            Err(error) => {
                let should_retry = should_retry_binary_http_error(&error);
                let error = error.to_string();
                if !should_retry || attempt + 1 == BINARY_HTTP_RETRY_ATTEMPTS {
                    return Err(error);
                }
            }
        }

        thread::sleep(binary_http_retry_delay(attempt));
    }

    Err("binary HTTP retry attempts exhausted".to_string())
}

fn binary_http_status_error(response: &Response) -> String {
    let status = response.status();
    let kind = if status.is_client_error() {
        "client error"
    } else if status.is_server_error() {
        "server error"
    } else {
        "unexpected status"
    };

    format!("HTTP status {kind} ({status}) for url ({})", response.url())
}

pub(crate) fn should_retry_binary_http_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn should_retry_binary_http_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect()
}

pub(crate) fn binary_http_retry_delay(attempt: usize) -> Duration {
    Duration::from_millis(BINARY_HTTP_RETRY_BASE_DELAY_MS.saturating_mul(attempt as u64 + 1))
}

fn copy_response_to_file(
    response: &mut Response,
    file: &mut fs::File,
    mut hasher: Option<&mut Sha256>,
) -> Result<(), String> {
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }

        file.write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;

        if let Some(ref mut digest) = hasher {
            digest.update(&buffer[..read]);
        }
    }

    file.flush().map_err(|error| error.to_string())
}

fn replace_file(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        fs::remove_file(dest).map_err(|error| error.to_string())?;
    }
    fs::rename(source, dest).map_err(|error| error.to_string())
}

fn replace_installed_binary(source: &Path, dest: &Path) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", dest.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let file_name = dest
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("{} has no file name", dest.display()))?;
    let pending = parent.join(format!("{file_name}.next"));
    let backup = parent.join(format!("{file_name}.previous"));

    let _ = fs::remove_file(&pending);
    fs::copy(source, &pending).map_err(|error| error.to_string())?;

    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }

    if dest.exists() {
        if let Err(error) = fs::rename(dest, &backup) {
            let _ = fs::remove_file(&pending);
            return Err(error.to_string());
        }
    }

    if let Err(error) = fs::rename(&pending, dest) {
        let activation_error = error.to_string();
        if backup.exists() {
            if let Err(restore_error) = fs::rename(&backup, dest) {
                let _ = fs::remove_file(&pending);
                return Err(format!(
                    "{activation_error}; failed to restore previous binary: {restore_error}"
                ));
            }
        }
        let _ = fs::remove_file(&pending);
        return Err(activation_error);
    }

    let _ = fs::remove_file(&backup);
    Ok(())
}

fn extract_and_place_executable(
    archive: &Path,
    dest_exec: &Path,
    archive_kind: ArchiveKind,
) -> Result<(), String> {
    let unpack_dir = archive.with_extension("unpack");
    if unpack_dir.exists() {
        let _ = fs::remove_dir_all(&unpack_dir);
    }
    fs::create_dir_all(&unpack_dir).map_err(|error| error.to_string())?;

    let extract_result = match archive_kind {
        ArchiveKind::Zip => unpack_zip(archive, &unpack_dir),
        ArchiveKind::TarXz => unpack_tar_xz(archive, &unpack_dir),
        ArchiveKind::Raw => Err("raw binaries do not need archive extraction".to_string()),
    };
    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&unpack_dir);
        let _ = fs::remove_file(archive);
        return Err(error);
    }

    let wanted = dest_exec
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "missing executable file name".to_string())?;
    let found = find_file_recursive(&unpack_dir, wanted)
        .ok_or_else(|| format!("{wanted} not found in extracted archive"))?;

    if dest_exec.exists() {
        fs::remove_file(dest_exec).map_err(|error| error.to_string())?;
    }
    fs::copy(found, dest_exec).map_err(|error| error.to_string())?;

    let _ = fs::remove_dir_all(&unpack_dir);
    let _ = fs::remove_file(archive);
    Ok(())
}

fn unpack_zip(archive: &Path, unpack_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut source = archive.by_index(index).map_err(|error| error.to_string())?;
        let output = unpack_dir.join(source.mangled_name());
        if source.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }

        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut dest = fs::File::create(&output).map_err(|error| error.to_string())?;
        std::io::copy(&mut source, &mut dest).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn unpack_tar_xz(archive: &Path, unpack_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|error| error.to_string())?;
    let decoder = xz2::read::XzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(unpack_dir)
        .map_err(|error| error.to_string())
}

fn find_file_recursive(dir: &Path, file_name: &str) -> Option<PathBuf> {
    for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|value| value.to_str()) == Some(file_name) {
            return Some(path.to_path_buf());
        }
    }
    None
}

fn read_binary_version(kind: ManagedBinary, exec: &Path) -> Option<String> {
    let mut command = Command::new(exec);
    match kind {
        ManagedBinary::Ffmpeg => {
            command.arg("-version");
        }
        ManagedBinary::YtDlp => {
            command.arg("--version");
        }
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    match kind {
        ManagedBinary::Ffmpeg => stdout
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(2))
            .map(ToOwned::to_owned),
        ManagedBinary::YtDlp => {
            let version = stdout.trim();
            if version.is_empty() {
                None
            } else {
                Some(version.to_string())
            }
        }
    }
}

fn write_install_state(path: &Path, state: &BinaryInstallState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn read_install_state(path: &Path) -> Option<BinaryInstallState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())
}

fn app_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(BIN_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// The on-disk executable name is local runtime state, not release metadata.
/// Keep it independent from network resolution so existing installs stay usable
/// even when the latest release API is temporarily unavailable.
fn install_name_for_kind(kind: ManagedBinary) -> &'static str {
    match kind {
        ManagedBinary::Ffmpeg => {
            if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            }
        }
        ManagedBinary::YtDlp => {
            if cfg!(windows) {
                "yt-dlp.exe"
            } else {
                "yt-dlp"
            }
        }
    }
}

fn installed_bin_path(app: &AppHandle, install_name: &str) -> Result<PathBuf, String> {
    Ok(app_bin_dir(app)?.join(install_name))
}

fn install_state_path(app: &AppHandle, kind: ManagedBinary) -> Result<PathBuf, String> {
    Ok(app_bin_dir(app)?.join(kind.state_file_name()))
}

fn plan_for_current_platform(client: &Client, kind: ManagedBinary) -> Result<DownloadPlan, String> {
    match kind {
        ManagedBinary::YtDlp => ytdlp_plan(client),
        ManagedBinary::Ffmpeg => ffmpeg_plan(client),
    }
}

fn ytdlp_plan(client: &Client) -> Result<DownloadPlan, String> {
    let (asset_matcher, install_name) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86") => (
            GitHubReleaseAssetMatcher::Exact("yt-dlp_x86.exe"),
            "yt-dlp.exe",
        ),
        ("windows", _) => (GitHubReleaseAssetMatcher::Exact("yt-dlp.exe"), "yt-dlp.exe"),
        ("linux", "aarch64") => (
            GitHubReleaseAssetMatcher::Exact("yt-dlp_linux_aarch64"),
            "yt-dlp",
        ),
        ("linux", "arm") | ("linux", "armv7") => (
            GitHubReleaseAssetMatcher::Exact("yt-dlp_linux_armv7l"),
            "yt-dlp",
        ),
        ("linux", _) => (GitHubReleaseAssetMatcher::Exact("yt-dlp_linux"), "yt-dlp"),
        ("macos", _) => (GitHubReleaseAssetMatcher::Exact("yt-dlp_macos"), "yt-dlp"),
        _ => {
            return Err(format!(
                "yt-dlp is not configured for {}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
        }
    };
    let release = fetch_github_latest_release(client, "yt-dlp", "yt-dlp")?;
    let asset_name = select_release_asset_name(&release.assets, asset_matcher)?.to_string();
    let checksum_asset_name = select_release_asset_name(
        &release.assets,
        GitHubReleaseAssetMatcher::Exact("SHA2-256SUMS"),
    )?
    .to_string();

    Ok(DownloadPlan {
        install_name,
        checksum_asset_name: Some(asset_name.clone()),
        download_url: build_github_relay_url(
            "yt-dlp",
            "yt-dlp",
            &format!("releases/latest/download/{asset_name}"),
        ),
        checksum_url: Some(build_github_relay_url(
            "yt-dlp",
            "yt-dlp",
            &format!("releases/latest/download/{checksum_asset_name}"),
        )),
        archive_kind: ArchiveKind::Raw,
    })
}

fn ffmpeg_plan(client: &Client) -> Result<DownloadPlan, String> {
    let install_name = install_name_for_kind(ManagedBinary::Ffmpeg);
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86") | ("windows", "x86_64") | ("windows", "aarch64") => {
            let release = fetch_github_latest_release(client, "BtbN", "FFmpeg-Builds")?;
            let asset_name = select_release_asset_name(
                &release.assets,
                GitHubReleaseAssetMatcher::Suffix("-win64-gpl.zip"),
            )?
            .to_string();
            Ok(DownloadPlan {
                install_name,
                checksum_asset_name: None,
                download_url: build_github_relay_url(
                    "BtbN",
                    "FFmpeg-Builds",
                    &format!("releases/latest/download/{asset_name}"),
                ),
                checksum_url: None,
                archive_kind: ArchiveKind::Zip,
            })
        }
        ("linux", "x86_64") => {
            let release = fetch_github_latest_release(client, "BtbN", "FFmpeg-Builds")?;
            let asset_name = select_release_asset_name(
                &release.assets,
                GitHubReleaseAssetMatcher::Suffix("-linux64-gpl.tar.xz"),
            )?
            .to_string();
            Ok(DownloadPlan {
                install_name,
                checksum_asset_name: None,
                download_url: build_github_relay_url(
                    "BtbN",
                    "FFmpeg-Builds",
                    &format!("releases/latest/download/{asset_name}"),
                ),
                checksum_url: None,
                archive_kind: ArchiveKind::TarXz,
            })
        }
        ("linux", "aarch64") => {
            let release = fetch_github_latest_release(client, "BtbN", "FFmpeg-Builds")?;
            let asset_name = select_release_asset_name(
                &release.assets,
                GitHubReleaseAssetMatcher::Suffix("-linuxarm64-gpl.tar.xz"),
            )?
            .to_string();
            Ok(DownloadPlan {
                install_name,
                checksum_asset_name: None,
                download_url: build_github_relay_url(
                    "BtbN",
                    "FFmpeg-Builds",
                    &format!("releases/latest/download/{asset_name}"),
                ),
                checksum_url: None,
                archive_kind: ArchiveKind::TarXz,
            })
        }
        ("macos", "aarch64") => Ok(DownloadPlan {
            install_name,
            checksum_asset_name: None,
            download_url:
                "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/snapshot/ffmpeg.zip"
                    .to_string(),
            checksum_url: None,
            archive_kind: ArchiveKind::Zip,
        }),
        ("macos", "x86_64") => Ok(DownloadPlan {
            install_name,
            checksum_asset_name: None,
            download_url: "https://evermeet.cx/ffmpeg/get/zip".to_string(),
            checksum_url: None,
            archive_kind: ArchiveKind::Zip,
        }),
        _ => Err(format!(
            "ffmpeg is not configured for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )),
    }
}

pub(crate) fn build_github_api_url(owner: &str, repo: &str, suffix: &str) -> String {
    format!("{GITHUB_API_BASE}/{owner}/{repo}/{suffix}")
}

pub(crate) fn build_github_relay_url(owner: &str, repo: &str, suffix: &str) -> String {
    format!("{GITHUB_RELAY_BASE}/{owner}/{repo}/{suffix}")
}

/// Release asset names are upstream-owned and may change shape over time even
/// when the platform flavor stays the same. Resolve them from the latest
/// release metadata instead of treating a guessed filename as canonical.
fn fetch_github_latest_release(
    client: &Client,
    owner: &str,
    repo: &str,
) -> Result<GitHubLatestRelease, String> {
    let url = build_github_api_url(owner, repo, "releases/latest");
    send_binary_http_with_retry(|| {
        client
            .get(url.as_str())
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
    })?
    .json::<GitHubLatestRelease>()
    .map_err(|error| error.to_string())
}

pub(crate) fn select_release_asset_name<'a>(
    assets: &'a [GitHubLatestReleaseAsset],
    matcher: GitHubReleaseAssetMatcher,
) -> Result<&'a str, String> {
    let matched = assets
        .iter()
        .map(|asset| asset.name.as_str())
        .find(|name| release_asset_matcher_matches(matcher, name));

    if let Some(name) = matched {
        return Ok(name);
    }

    let available_assets = assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "release asset {:?} not found in latest release assets [{}]",
        matcher, available_assets
    ))
}

pub(crate) fn release_asset_matcher_matches(
    matcher: GitHubReleaseAssetMatcher,
    asset_name: &str,
) -> bool {
    match matcher {
        GitHubReleaseAssetMatcher::Exact(expected) => asset_name == expected,
        GitHubReleaseAssetMatcher::Suffix(expected) => asset_name.ends_with(expected),
    }
}

pub(crate) fn parse_sha256(sums: &str, asset_name: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() || !line.ends_with(asset_name) {
            continue;
        }

        let hash = line.split_whitespace().next()?.trim();
        if hash.len() == 64 && hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Some(hash.to_lowercase());
        }
    }

    None
}

pub(crate) fn needs_install_or_update(
    local_exists: bool,
    state: Option<&BinaryInstallState>,
    remote: &RemoteIdentity,
) -> bool {
    if !local_exists {
        return true;
    }

    let Some(state) = state else {
        return true;
    };

    if remote.is_empty() {
        return false;
    }

    state.remote != *remote
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|error| error.to_string())?;
    }

    #[cfg(not(unix))]
    {
        let _ = path;
    }

    Ok(())
}

fn remove_quarantine(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("xattr")
            .arg("-d")
            .arg("com.apple.quarantine")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
    }
}
