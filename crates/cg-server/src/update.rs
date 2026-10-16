//! Over-the-air updates, without uninstalling.
//!
//! A new version comes either from the GitHub releases of the project
//! (private repository: a read-only token is stored in `<data>/update/`), or
//! from a release archive uploaded by an admin (servers without internet).
//! Either way the server:
//!
//! 1. extracts `cg-server` from the platform archive (`.tar.gz` / `.zip`) and
//!    checks the SHA-256 published by GitHub when there is one;
//! 2. runs `<new> --version`, which proves the binary runs on this machine;
//! 3. keeps the running binary as `cg-server.previous` and swaps the new one
//!    in (atomic rename; the running process keeps its old image);
//! 4. exits so the service manager (systemd, launchd, Windows SCM) starts the
//!    new version; a foreground server re-launches itself.
//!
//! The new version must start cleanly: if it fails to come up three times
//! in a row, the previous binary is put back automatically. Updates are
//! never installed on their own; checking only tells the admins.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DEFAULT_REPO: &str = "DamienP2/CG";

/// Name of this build's release archive: `pulse-cg-<version>-<PLATFORM>.*`.
pub const PLATFORM: &str = if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
    "linux-arm64"
} else if cfg!(target_os = "linux") {
    "linux-x86_64"
} else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "macos-arm64"
} else if cfg!(target_os = "macos") {
    "macos-x86_64"
} else {
    "windows-x86_64"
};

const EXE: &str = if cfg!(windows) {
    "cg-server.exe"
} else {
    "cg-server"
};
const PREVIOUS: &str = if cfg!(windows) {
    "cg-server.previous.exe"
} else {
    "cg-server.previous"
};
const STAGED: &str = if cfg!(windows) {
    "cg-server.new.exe"
} else {
    "cg-server.new"
};
/// Exit code asking the service manager for a restart.
const RESTART_CODE: i32 = 75;
const MAX_FAILED_STARTS: u32 = 3;

static SUPERVISED: AtomicBool = AtomicBool::new(false);

/// Running under systemd, launchd or the Windows SCM (they restart us).
pub fn set_supervised(windows_service: bool) {
    // systemd sets INVOCATION_ID, launchd sets XPC_SERVICE_NAME to the label.
    let env = |k: &str| std::env::var(k).ok();
    let supervised = windows_service
        || env("CG_SUPERVISED").is_some_and(|v| v == "1")
        || env("INVOCATION_ID").is_some()
        || env("XPC_SERVICE_NAME").is_some_and(|v| v == "com.pulsecg.server");
    SUPERVISED.store(supervised, Ordering::Relaxed);
    let _ = exe_path();
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("update")
}

static EXE_PATH: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Path of the executable, resolved at startup: once the file is replaced,
/// Linux reports the running image as "… (deleted)".
fn exe_path() -> Result<PathBuf> {
    EXE_PATH
        .get_or_init(|| {
            std::env::current_exe()
                .ok()
                .map(|e| e.canonicalize().unwrap_or(e))
        })
        .clone()
        .ok_or_else(|| anyhow!("cannot locate the running executable"))
}

fn sibling(name: &str) -> Result<PathBuf> {
    Ok(exe_path()?.with_file_name(name))
}

// ------------------------------------------------------------- settings ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// `owner/name` of the GitHub repository publishing releases.
    #[serde(default = "default_repo")]
    pub repo: String,
    /// Read-only token for private repositories (never sent to clients).
    #[serde(default)]
    pub token: String,
    /// Look for new versions in the background (installing stays manual).
    #[serde(default = "yes")]
    pub auto_check: bool,
}

fn default_repo() -> String {
    DEFAULT_REPO.into()
}
fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            repo: default_repo(),
            token: String::new(),
            auto_check: true,
        }
    }
}

impl Settings {
    pub fn load(data_dir: &Path) -> Self {
        std::fs::read(dir(data_dir).join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, data_dir: &Path) -> Result<()> {
        let d = dir(data_dir);
        std::fs::create_dir_all(&d)?;
        let path = d.join("settings.json");
        std::fs::write(&path, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

// --------------------------------------------------------------- status ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub name: String,
    pub notes: String,
    pub published_at: String,
    pub url: String,
    pub asset_id: u64,
    pub asset_name: String,
    pub size: u64,
    /// "sha256:<hex>" as published by GitHub.
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Downloading,
    Installing,
    Restarting,
    Error,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    /// 0..1 while downloading.
    pub progress: f32,
    pub message: String,
    pub latest: Option<Release>,
    pub last_check: Option<i64>,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);

pub fn status() -> Status {
    STATUS
        .lock()
        .map(|s| s.clone().unwrap_or_default())
        .unwrap_or_default()
}

fn set_status(f: impl FnOnce(&mut Status)) {
    if let Ok(mut s) = STATUS.lock() {
        f(s.get_or_insert_with(Status::default));
    }
}

fn busy() -> bool {
    matches!(
        status().phase,
        Phase::Checking | Phase::Downloading | Phase::Installing | Phase::Restarting
    )
}

/// Fails the update with a message the UI shows.
pub fn fail(e: &anyhow::Error) {
    tracing::error!("update failed: {e:#}");
    set_status(|s| {
        s.phase = Phase::Error;
        s.message = format!("{e:#}");
    });
}

/// What the settings page shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub current: &'static str,
    pub platform: &'static str,
    pub repo: String,
    pub has_token: bool,
    pub auto_check: bool,
    /// Version kept for rollback.
    pub previous: Option<String>,
    /// Last update installed (or rolled back) and when.
    pub history: Option<History>,
    pub status: Status,
    pub supervised: bool,
}

pub fn info(data_dir: &Path) -> Info {
    let s = Settings::load(data_dir);
    Info {
        current: current_version(),
        platform: PLATFORM,
        repo: s.repo,
        has_token: !s.token.is_empty(),
        auto_check: s.auto_check,
        previous: sibling(PREVIOUS)
            .ok()
            .filter(|p| p.exists())
            .and_then(|p| binary_version(&p).ok()),
        history: read_json(&dir(data_dir).join("history.json")),
        status: status(),
        supervised: SUPERVISED.load(Ordering::Relaxed),
    }
}

// --------------------------------------------------------------- github ----

fn agent() -> ureq::Agent {
    // The OS trust store: works behind corporate TLS inspection too.
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(Some(Duration::from_secs(600)))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent(concat!("pulse-cg/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn github_get(s: &Settings, url: &str, accept: &str) -> Result<ureq::http::Response<ureq::Body>> {
    let mut req = agent()
        .get(url)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28");
    if !s.token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", s.token.trim()));
    }
    req.call().with_context(|| format!("cannot reach {url}"))
}

fn http_error(status: u16, what: &str, s: &Settings) -> anyhow::Error {
    match status {
        401 => anyhow!("GitHub refused the token (expired or revoked?)"),
        403 => anyhow!(
            "GitHub refused the request (rate limit, or the token cannot read {})",
            s.repo
        ),
        404 if s.token.is_empty() => anyhow!(
            "{} not found: the repository is private, add a read-only token",
            s.repo
        ),
        404 => anyhow!("no {what} found in {}", s.repo),
        code => anyhow!("GitHub answered HTTP {code}"),
    }
}

#[derive(Deserialize)]
struct GhAsset {
    id: u64,
    name: String,
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    html_url: String,
    assets: Vec<GhAsset>,
}

/// Latest published release with an archive for this platform.
pub fn check(data_dir: &Path) -> Result<Release> {
    let s = Settings::load(data_dir);
    set_status(|st| {
        st.phase = Phase::Checking;
        st.message.clear();
    });
    let res = (|| {
        let url = format!(
            "https://api.github.com/repos/{}/releases/latest",
            s.repo.trim()
        );
        let mut r = github_get(&s, &url, "application/vnd.github+json")?;
        if r.status() != 200 {
            return Err(http_error(r.status().as_u16(), "published release", &s));
        }
        let body = r.body_mut().read_to_string()?;
        let gh: GhRelease = serde_json::from_str(&body).context("unexpected answer from GitHub")?;
        let suffix_tgz = format!("-{PLATFORM}.tar.gz");
        let suffix_zip = format!("-{PLATFORM}.zip");
        let asset = gh
            .assets
            .into_iter()
            .find(|a| a.name.ends_with(&suffix_tgz) || a.name.ends_with(&suffix_zip))
            .ok_or_else(|| anyhow!("release {} has no package for {PLATFORM}", gh.tag_name))?;
        Ok(Release {
            version: gh.tag_name.trim_start_matches('v').to_string(),
            name: gh.name.unwrap_or_else(|| gh.tag_name.clone()),
            notes: gh.body.unwrap_or_default(),
            published_at: gh.published_at.unwrap_or_default(),
            url: gh.html_url,
            asset_id: asset.id,
            asset_name: asset.name,
            size: asset.size,
            digest: asset.digest,
        })
    })();
    match &res {
        Ok(r) => set_status(|st| {
            st.phase = Phase::Idle;
            st.latest = Some(r.clone());
            st.last_check = Some(crate::state::now_ms());
        }),
        Err(e) => fail(e),
    }
    res
}

/// Downloads a release archive, reporting progress.
fn download(s: &Settings, r: &Release) -> Result<Vec<u8>> {
    let url = format!(
        "https://api.github.com/repos/{}/releases/assets/{}",
        s.repo.trim(),
        r.asset_id
    );
    let mut res = github_get(s, &url, "application/octet-stream")?;
    // Private assets redirect to a signed storage URL: follow it without
    // the GitHub token.
    if (300..400).contains(&res.status().as_u16()) {
        let location = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| anyhow!("GitHub redirect without location"))?
            .to_string();
        res = agent()
            .get(&location)
            .call()
            .context("cannot download the package")?;
    }
    if res.status() != 200 {
        return Err(http_error(res.status().as_u16(), "package", s));
    }
    let total = r.size.max(1);
    let mut reader = res
        .into_body()
        .into_with_config()
        .limit(512 * 1024 * 1024)
        .reader();
    let mut out = Vec::with_capacity(r.size as usize);
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        set_status(|st| st.progress = (out.len() as f32 / total as f32).min(1.0));
    }
    if let Some(d) = r.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        let got = hex(&Sha256::digest(&out));
        if !got.eq_ignore_ascii_case(d) {
            bail!("the download is corrupted (SHA-256 mismatch)");
        }
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads and installs the latest release, then restarts.
pub fn install_latest(data_dir: &Path) -> Result<()> {
    if busy() {
        bail!("an update is already in progress");
    }
    let s = Settings::load(data_dir);
    let release = match status().latest {
        Some(r) => r,
        None => check(data_dir)?,
    };
    set_status(|st| {
        st.phase = Phase::Downloading;
        st.progress = 0.0;
        st.message = format!("Downloading {}", release.asset_name);
    });
    let res = (|| {
        let archive = download(&s, &release)?;
        let binary = extract_binary(&archive)?;
        install(data_dir, &binary, false)
    })();
    match res {
        Ok(v) => {
            tracing::info!(version = v, "update installed, restarting");
            restart_soon();
            Ok(())
        }
        Err(e) => {
            fail(&e);
            Err(e)
        }
    }
}

// ------------------------------------------------------------- packages ----

/// `cg-server` from a release archive (`.tar.gz` / `.zip`) or a bare binary.
pub fn extract_binary(bytes: &[u8]) -> Result<Vec<u8>> {
    let is_exe = |name: &str| Path::new(name).file_name().and_then(|n| n.to_str()) == Some(EXE);
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        for entry in archive.entries().context("not a valid .tar.gz")? {
            let mut entry = entry?;
            let path = entry.path()?.to_string_lossy().into_owned();
            if is_exe(&path) {
                let mut out = Vec::new();
                entry.read_to_end(&mut out)?;
                return Ok(out);
            }
        }
        bail!("no {EXE} in this archive");
    }
    if bytes.starts_with(b"PK") {
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).context("not a valid .zip")?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i)?;
            if f.name().is_ok_and(|n| is_exe(&n)) {
                let mut out = Vec::new();
                f.read_to_end(&mut out)?;
                return Ok(out);
            }
        }
        bail!("no {EXE} in this archive");
    }
    // ELF, Mach-O (thin or universal) or PE.
    let magic = [
        &b"\x7fELF"[..],
        &[0xcf, 0xfa, 0xed, 0xfe],
        &[0xca, 0xfe, 0xba, 0xbe],
        b"MZ",
    ];
    if magic.iter().any(|m| bytes.starts_with(m)) {
        return Ok(bytes.to_vec());
    }
    bail!("unknown package: upload the pulse-cg-<version>-{PLATFORM} archive (.tar.gz or .zip)")
}

/// Version printed by `<binary> --version` ("cg-server 0.3.0").
fn binary_version(path: &Path) -> Result<String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .output()
        .context("the new binary cannot run on this machine")?;
    let text = String::from_utf8_lossy(&out.stdout);
    match text.trim().strip_prefix("cg-server ") {
        Some(v) if out.status.success() => Ok(v.trim().to_string()),
        _ => bail!("this is not a Pulse CG server for {PLATFORM}"),
    }
}

/// Orders "1.2.10" after "1.2.9"; pre-release suffixes compare as text.
fn version_key(v: &str) -> Vec<u64> {
    v.split(['.', '-', '+'])
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    version_key(candidate) > version_key(current)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    from: String,
    to: String,
    starts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub from: String,
    pub to: String,
    pub at: i64,
    /// "installed", "rolled back" or "restored automatically".
    pub outcome: String,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(v)?)?;
    Ok(())
}

fn permission_hint(e: std::io::Error, dir: &Path) -> anyhow::Error {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        anyhow!(
            "the server cannot replace its own program in {} (permission denied). On Linux, run the installer once more (sudo ./install.sh) so updates can be applied from the web.",
            dir.display()
        )
    } else {
        e.into()
    }
}

/// Swaps `binary` in place of the running executable. Returns its version.
pub fn install(data_dir: &Path, binary: &[u8], allow_older: bool) -> Result<String> {
    set_status(|st| {
        st.phase = Phase::Installing;
        st.message = "Checking the new version".into();
    });
    let exe = exe_path()?;
    let folder = exe
        .parent()
        .ok_or_else(|| anyhow!("no folder for {}", exe.display()))?
        .to_path_buf();
    let staged = folder.join(STAGED);
    std::fs::write(&staged, binary).map_err(|e| permission_hint(e, &folder))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    let version = match binary_version(&staged) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&staged);
            return Err(e);
        }
    };
    if !allow_older && !is_newer(&version, current_version()) {
        let _ = std::fs::remove_file(&staged);
        bail!(
            "version {version} is not newer than {} (allow older versions to install it anyway)",
            current_version()
        );
    }
    let previous = folder.join(PREVIOUS);
    swap_in(&exe, &staged, &previous).map_err(|e| permission_hint(e, &folder))?;
    write_json(
        &dir(data_dir).join("pending.json"),
        &Pending {
            from: current_version().into(),
            to: version.clone(),
            starts: 0,
        },
    )?;
    write_json(
        &dir(data_dir).join("history.json"),
        &History {
            from: current_version().into(),
            to: version.clone(),
            at: crate::state::now_ms(),
            outcome: "installed".into(),
        },
    )?;
    set_status(|st| {
        st.phase = Phase::Restarting;
        st.message = format!("Restarting with version {version}");
    });
    Ok(version)
}

/// Makes `staged` the executable and keeps the current one as `previous`.
fn swap_in(exe: &Path, staged: &Path, previous: &Path) -> std::io::Result<()> {
    if previous.exists() {
        std::fs::remove_file(previous)?;
    }
    if cfg!(windows) {
        // A running .exe cannot be overwritten, but it can be renamed.
        std::fs::rename(exe, previous)?;
    } else {
        std::fs::copy(exe, previous)?;
    }
    if let Err(e) = std::fs::rename(staged, exe) {
        if cfg!(windows) {
            let _ = std::fs::rename(previous, exe);
        }
        return Err(e);
    }
    Ok(())
}

/// Puts the previous version back (the current one becomes "previous").
pub fn rollback(data_dir: &Path, outcome: &str) -> Result<String> {
    let exe = exe_path()?;
    let folder = exe
        .parent()
        .ok_or_else(|| anyhow!("no folder"))?
        .to_path_buf();
    let previous = folder.join(PREVIOUS);
    if !previous.exists() {
        bail!("no previous version to go back to");
    }
    let version = binary_version(&previous)?;
    let staged = folder.join(STAGED);
    std::fs::copy(&previous, &staged).map_err(|e| permission_hint(e, &folder))?;
    swap_in(&exe, &staged, &previous).map_err(|e| permission_hint(e, &folder))?;
    let _ = std::fs::remove_file(dir(data_dir).join("pending.json"));
    write_json(
        &dir(data_dir).join("history.json"),
        &History {
            from: current_version().into(),
            to: version.clone(),
            at: crate::state::now_ms(),
            outcome: outcome.into(),
        },
    )?;
    set_status(|st| {
        st.phase = Phase::Restarting;
        st.message = format!("Going back to version {version}");
    });
    Ok(version)
}

// -------------------------------------------------------------- restart ----

/// Lets the HTTP answer leave, then restarts on the new binary.
pub fn restart_soon() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(800));
        restart_now();
    });
}

fn restart_now() -> ! {
    if !SUPERVISED.load(Ordering::Relaxed) {
        // Foreground server: start the new binary with the same arguments;
        // it waits for this process to release the port.
        match exe_path().and_then(|exe| {
            std::process::Command::new(exe)
                .args(std::env::args_os().skip(1))
                .spawn()
                .map_err(Into::into)
        }) {
            Ok(_) => std::process::exit(0),
            Err(e) => tracing::error!("cannot relaunch: {e:#}"),
        }
    }
    // Non-zero exit: systemd (Restart=always), launchd (KeepAlive) and the
    // Windows SCM (failure actions) start the service again.
    std::process::exit(RESTART_CODE);
}

/// Called first thing at startup: counts starts of a fresh update and puts
/// the previous version back if the new one keeps failing.
pub fn startup_guard(data_dir: &Path) {
    let path = dir(data_dir).join("pending.json");
    let Some(mut p) = read_json::<Pending>(&path) else {
        return;
    };
    if p.to != current_version() {
        // Rolled back by hand, or replaced outside the updater.
        let _ = std::fs::remove_file(&path);
        return;
    }
    p.starts += 1;
    if p.starts > MAX_FAILED_STARTS {
        tracing::error!(
            version = p.to,
            "the update failed to start {MAX_FAILED_STARTS} times; restoring {}",
            p.from
        );
        match rollback(data_dir, "restored automatically") {
            Ok(_) => restart_now(),
            Err(e) => tracing::error!("automatic rollback failed: {e:#}"),
        }
        let _ = std::fs::remove_file(&path);
        return;
    }
    let _ = write_json(&path, &p);
}

/// Marks the update as good once the server has run for a while.
pub fn confirm_after(data_dir: PathBuf, delay: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        let path = dir(&data_dir).join("pending.json");
        if path.exists() {
            tracing::info!(version = current_version(), "update confirmed");
            let _ = std::fs::remove_file(path);
        }
    });
}

/// Background check every 6 hours (never installs).
pub fn spawn_auto_check(data_dir: PathBuf) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            let s = Settings::load(&data_dir);
            if s.auto_check && !busy() {
                let d = data_dir.clone();
                match tokio::task::spawn_blocking(move || check(&d)).await {
                    Ok(Ok(r)) if is_newer(&r.version, current_version()) => {
                        tracing::info!(version = r.version, "a new version is available")
                    }
                    Ok(Err(e)) => tracing::debug!("update check: {e:#}"),
                    _ => {}
                }
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.10.0", "0.9.3"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
    }

    #[test]
    fn extracts_server_from_archives() {
        // tar.gz with a nested folder, like the release archives.
        let mut tar = tar::Builder::new(Vec::new());
        let body = b"\x7fELF fake binary";
        let mut add = |name: String, data: &[u8]| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o755);
            tar.append_data(&mut h, name, data).unwrap();
        };
        add(format!("pulse-cg-9.9.9-{PLATFORM}/README.md"), b"hello");
        add(format!("pulse-cg-9.9.9-{PLATFORM}/{EXE}"), body);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar.into_inner().unwrap()).unwrap();
        assert_eq!(extract_binary(&gz.finish().unwrap()).unwrap(), body);
        assert!(extract_binary(b"not a package").is_err());
    }
}
