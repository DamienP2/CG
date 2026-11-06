//! HTTPS: a certificate (one Strata makes and signs itself, or the one of
//! the company's PKI), the HTTPS listener, and what plain HTTP still does.
//!
//! Plain HTTP stays as it is for the server itself (the tray app, a local
//! Premiere panel) and, in the « redirect » mode, for the HTML5 output pages
//! that vision mixers' browser sources load (they refuse a self-signed
//! certificate).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::api::{bad, internal, require, ApiResult};
use crate::auth::CurrentUser;
use crate::state::Shared;

/// Where the certificate comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CertMode {
    /// No HTTPS.
    #[default]
    Off,
    /// Made and signed by Strata (browsers warn once).
    SelfSigned,
    /// The PEM files an admin gave (the company's PKI).
    Custom,
}

/// What plain HTTP does once HTTPS is on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HttpMode {
    /// Pages go to HTTPS, but for the server itself and the HTML5 outputs.
    #[default]
    Redirect,
    /// Everything goes to HTTPS (the server's own API calls aside).
    HttpsOnly,
    /// HTTP and HTTPS side by side.
    Open,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpsConfig {
    #[serde(default)]
    pub mode: CertMode,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub http: HttpMode,
}

impl Default for HttpsConfig {
    fn default() -> Self {
        Self {
            mode: CertMode::Off,
            port: default_port(),
            http: HttpMode::Redirect,
        }
    }
}

fn default_port() -> u16 {
    8443
}

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tls")
}

/// (certificate, key) files of a mode.
fn files(data_dir: &Path, mode: CertMode) -> (PathBuf, PathBuf) {
    let d = dir(data_dir);
    match mode {
        CertMode::Custom => (d.join("cert.pem"), d.join("key.pem")),
        _ => (
            d.join("self-signed-cert.pem"),
            d.join("self-signed-key.pem"),
        ),
    }
}

/// The names a self-signed certificate is for: the machine's names and
/// addresses.
fn own_names() -> Vec<String> {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let mut names = vec!["localhost".to_string()];
    if !host.is_empty() {
        names.push(host.clone());
        if !host.contains('.') {
            names.push(format!("{host}.local"));
        }
    }
    for i in if_addrs::get_if_addrs().unwrap_or_default() {
        let ip = i.ip().to_string();
        if !names.contains(&ip) {
            names.push(ip);
        }
    }
    names
}

/// Makes a new self-signed certificate (10 years).
fn make_self_signed(data_dir: &Path) -> anyhow::Result<()> {
    let names = own_names();
    let mut params = rcgen::CertificateParams::new(names)?;
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, format!("Strata Graphics {host}"));
    let now = std::time::SystemTime::now();
    params.not_before = (now - std::time::Duration::from_secs(86_400)).into();
    params.not_after = (now + std::time::Duration::from_secs(10 * 365 * 86_400)).into();
    let key = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key)?;
    let (c, k) = files(data_dir, CertMode::SelfSigned);
    std::fs::create_dir_all(dir(data_dir))?;
    std::fs::write(&c, cert.pem())?;
    write_private(&k, key.serialize_pem().as_bytes())?;
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Checks a certificate chain and its key go together (PEM).
fn check_pair(cert: &[u8], key: &[u8]) -> Result<(), String> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let chain: Vec<CertificateDer> = CertificateDer::pem_slice_iter(cert)
        .collect::<Result<_, _>>()
        .map_err(|e| format!("certificate: {e}"))?;
    if chain.is_empty() {
        return Err("no certificate in the file".into());
    }
    let key = PrivateKeyDer::from_pem_slice(key).map_err(|e| format!("key: {e}"))?;
    let signer =
        rustls::crypto::ring::sign::any_supported_type(&key).map_err(|e| format!("key: {e}"))?;
    rustls::sign::CertifiedKey::new(chain, signer)
        .keys_match()
        .map_err(|_| "the key does not belong to the certificate".to_string())
}

/// What a certificate says.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub subject: String,
    pub names: Vec<String>,
    /// ms since 1970.
    pub not_after: i64,
    pub self_signed: bool,
    /// SHA-256 of the certificate, "AB:CD:…".
    pub fingerprint: String,
}

fn info_of(pem: &[u8]) -> Option<CertInfo> {
    let (_, p) = x509_parser::pem::parse_x509_pem(pem).ok()?;
    let cert = p.parse_x509().ok()?;
    let cn = |n: &x509_parser::x509::X509Name| {
        n.iter_common_name()
            .next()
            .and_then(|c| c.as_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| n.to_string())
    };
    let mut names = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for n in &san.value.general_names {
            match n {
                x509_parser::extensions::GeneralName::DNSName(d) => names.push(d.to_string()),
                x509_parser::extensions::GeneralName::IPAddress(b) => match b.len() {
                    4 => names.push(std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string()),
                    16 => {
                        let a: [u8; 16] = (*b).try_into().ok()?;
                        names.push(std::net::Ipv6Addr::from(a).to_string())
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, &p.contents);
    Some(CertInfo {
        subject: cn(cert.subject()),
        names,
        not_after: cert.validity().not_after.timestamp() * 1000,
        self_signed: cert.subject() == cert.issuer(),
        fingerprint: digest
            .as_ref()
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":"),
    })
}

/// The certificate and key to serve with, made when self-signed and missing.
pub fn pem_pair(data_dir: &Path, mode: CertMode) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let (c, k) = files(data_dir, mode);
    if mode == CertMode::SelfSigned && (!c.is_file() || !k.is_file()) {
        make_self_signed(data_dir)?;
    }
    let cert = std::fs::read(&c).map_err(|e| anyhow::anyhow!("{}: {e}", c.display()))?;
    let key = std::fs::read(&k).map_err(|e| anyhow::anyhow!("{}: {e}", k.display()))?;
    check_pair(&cert, &key).map_err(|e| anyhow::anyhow!(e))?;
    Ok((cert, key))
}

/// Uses ring (already in the build) for TLS.
pub fn install_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// The HTTPS listener as it runs.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub on: bool,
    pub port: u16,
    pub error: String,
}

fn running() -> std::sync::MutexGuard<'static, Running> {
    static R: Mutex<Running> = Mutex::new(Running {
        on: false,
        port: 0,
        error: String::new(),
    });
    R.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn set_running(on: bool, port: u16, error: String) {
    *running() = Running { on, port, error };
}

/// The request came in over HTTPS (set on the HTTPS listener's requests).
#[derive(Debug, Clone, Copy)]
pub struct Https;

/// The request came over HTTPS (here, or through a proxy that says so).
pub fn is_https(req_ext: &axum::http::Extensions, headers: &HeaderMap) -> bool {
    req_ext.get::<Https>().is_some()
        || headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case("https"))
}

/// HTTP/2 has no `Host` header (the host is in the request's URI): put it
/// back, for what reads it (same-site checks, the SSO return address).
pub async fn host_from_authority(mut req: Request, next: Next) -> Response {
    if !req.headers().contains_key(header::HOST) {
        if let Some(v) = req
            .uri()
            .authority()
            .and_then(|a| axum::http::HeaderValue::from_str(a.as_str()).ok())
        {
            req.headers_mut().insert(header::HOST, v);
        }
    }
    next.run(req).await
}

/// What plain HTTP lets through, by [`HttpMode`].
pub async fn http_policy(
    State((mode, port)): State<(HttpMode, u16)>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let local = peer.ip().is_loopback();
    let api = path.starts_with("/api/");
    let pass = match mode {
        HttpMode::Open => true,
        // The tray app and local tools call the API of the machine itself.
        HttpMode::HttpsOnly => local && api,
        HttpMode::Redirect => {
            local
                || path.starts_with("/output")
                || path.starts_with("/hls/")
                || path.starts_with("/assets/")
                || path.starts_with("/fonts/")
                || path == "/ws"
                || (api && !path.starts_with("/api/auth/"))
                || !wants_page(req.method(), req.headers()) && !api
        }
    };
    if pass {
        return next.run(req).await;
    }
    // Passwords and sign-ins do not travel in clear.
    if api && mode == HttpMode::Redirect {
        return (StatusCode::FORBIDDEN, "use HTTPS to sign in").into_response();
    }
    let Some(host) = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(host_without_port)
    else {
        return (StatusCode::BAD_REQUEST, "no host").into_response();
    };
    let at = if port == 443 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    (
        StatusCode::PERMANENT_REDIRECT,
        [(header::LOCATION, format!("https://{at}{pq}"))],
    )
        .into_response()
}

/// A page a browser opens (not a script, picture or API call).
fn wants_page(method: &Method, headers: &HeaderMap) -> bool {
    method == Method::GET
        && headers
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|a| a.contains("text/html"))
}

/// "host:8080" → "host"; "[::1]:8080" → "[::1]".
fn host_without_port(h: &str) -> &str {
    if let Some(end) = h.find(']') {
        return &h[..=end];
    }
    h.rsplit_once(':').map_or(h, |(a, _)| a)
}

// ── API ───────────────────────────────────────────────────────────────────

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/security/tls", get(status))
        .route("/api/security/tls/certificate", post(upload))
        .route("/api/security/tls/self-signed", post(renew))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    running: Running,
    /// The certificate of each mode, when there is one.
    self_signed: Option<CertInfo>,
    custom: Option<CertInfo>,
}

fn cert_of(data_dir: &Path, mode: CertMode) -> Option<CertInfo> {
    std::fs::read(files(data_dir, mode).0)
        .ok()
        .and_then(|p| info_of(&p))
}

async fn status(State(s): State<Shared>, CurrentUser(me): CurrentUser) -> ApiResult<Json<Status>> {
    require(me.is_admin())?;
    Ok(Json(Status {
        running: running().clone(),
        self_signed: cert_of(&s.data_dir, CertMode::SelfSigned),
        custom: cert_of(&s.data_dir, CertMode::Custom),
    }))
}

#[derive(Deserialize)]
struct Pair {
    cert: String,
    key: String,
}

/// The company's certificate and its key (PEM).
async fn upload(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Json(p): Json<Pair>,
) -> ApiResult<Json<CertInfo>> {
    require(me.is_admin())?;
    check_pair(p.cert.as_bytes(), p.key.as_bytes()).map_err(bad)?;
    let info = info_of(p.cert.as_bytes()).ok_or_else(|| bad("unreadable certificate"))?;
    let (c, k) = files(&s.data_dir, CertMode::Custom);
    std::fs::create_dir_all(dir(&s.data_dir)).map_err(internal)?;
    std::fs::write(&c, p.cert.as_bytes()).map_err(internal)?;
    write_private(&k, p.key.as_bytes()).map_err(internal)?;
    // In use: the listener takes it.
    if s.config.load().security.https.mode == CertMode::Custom {
        s.restart.notify_one();
    }
    Ok(Json(info))
}

/// A new self-signed certificate (the machine's names or addresses changed).
async fn renew(State(s): State<Shared>, CurrentUser(me): CurrentUser) -> ApiResult<Json<CertInfo>> {
    require(me.is_admin())?;
    let dir = s.data_dir.clone();
    tokio::task::spawn_blocking(move || make_self_signed(&dir))
        .await
        .map_err(internal)?
        .map_err(internal)?;
    if s.config.load().security.https.mode == CertMode::SelfSigned {
        s.restart.notify_one();
    }
    cert_of(&s.data_dir, CertMode::SelfSigned)
        .map(Json)
        .ok_or_else(|| internal("certificate not readable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_self_signed_certificate_is_made_and_read() {
        install_crypto();
        let d = std::env::temp_dir().join(format!("strata-tls-{}", uuid::Uuid::new_v4().simple()));
        let (cert, key) = pem_pair(&d, CertMode::SelfSigned).unwrap();
        check_pair(&cert, &key).unwrap();
        let info = info_of(&cert).unwrap();
        assert!(info.self_signed);
        assert!(info.names.contains(&"localhost".to_string()));
        assert!(info.not_after > 1_900_000_000_000);
        assert_eq!(info.fingerprint.len(), 32 * 3 - 1);
        // Another key does not go with it.
        let other = rcgen::KeyPair::generate().unwrap().serialize_pem();
        assert!(check_pair(&cert, other.as_bytes()).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn hosts_lose_their_port() {
        assert_eq!(host_without_port("strata.local:8080"), "strata.local");
        assert_eq!(host_without_port("10.0.0.5"), "10.0.0.5");
        assert_eq!(host_without_port("[::1]:8080"), "[::1]");
    }
}
