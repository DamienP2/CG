//! Sign-in through the company's directory: OpenID Connect (Microsoft Entra,
//! Okta, Keycloak, Google, ADFS…), authorization code flow with PKCE.
//!
//! The ID token is checked here (signature against the provider's keys,
//! issuer, audience, expiry, nonce). The role comes from the user's groups
//! (the `groups` claim), unless an admin fixed it on the account.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{require, ApiResult};
use crate::auth::{CurrentUser, Role, SsoIdentity};
use crate::state::Shared;

/// What is shown instead of the client secret.
pub const SECRET_MASK: &str = "••••••••";

/// Who may still sign in with a local password once SSO is on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalAccounts {
    /// Nobody (the server itself aside, to fix the settings).
    None,
    /// Admins: a way in when the directory is down.
    #[default]
    AdminOnly,
    All,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRole {
    pub group: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoConfig {
    #[serde(default)]
    pub enabled: bool,
    /// entra, okta, keycloak, google, other: the button's name.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// The issuer (its `/.well-known/openid-configuration` is read).
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    /// The claim listing the user's groups.
    #[serde(default = "default_groups_claim")]
    pub groups_claim: String,
    #[serde(default)]
    pub groups: Vec<GroupRole>,
    /// The role of someone in no group of the list (none: refused).
    #[serde(default)]
    pub default_role: Option<Role>,
    #[serde(default)]
    pub local_accounts: LocalAccounts,
}

impl Default for SsoConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: default_provider(),
            issuer: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            groups_claim: default_groups_claim(),
            groups: Vec::new(),
            default_role: None,
            local_accounts: LocalAccounts::AdminOnly,
        }
    }
}

fn default_provider() -> String {
    "entra".into()
}
fn default_groups_claim() -> String {
    "groups".into()
}

impl SsoConfig {
    pub fn ready(&self) -> bool {
        self.enabled && !self.issuer.trim().is_empty() && !self.client_id.trim().is_empty()
    }

    /// The button's label.
    pub fn label(&self) -> &'static str {
        match self.provider.as_str() {
            "entra" => "Microsoft",
            "okta" => "Okta",
            "keycloak" => "Keycloak",
            "google" => "Google",
            _ => "SSO",
        }
    }

    /// The role the groups give (the highest), else the default one.
    pub fn role_for(&self, groups: &[String]) -> Option<Role> {
        let norm = |g: &str| g.trim().trim_start_matches('/').to_lowercase();
        let mine: Vec<String> = groups.iter().map(|g| norm(g)).collect();
        self.groups
            .iter()
            .filter(|r| !r.group.trim().is_empty() && mine.contains(&norm(&r.group)))
            .map(|r| r.role)
            .max_by_key(|r| rank(*r))
            .or(self.default_role)
    }

    /// May this account sign in with its local password?
    pub fn local_allowed(&self, role: Role) -> bool {
        !self.ready()
            || match self.local_accounts {
                LocalAccounts::All => true,
                LocalAccounts::AdminOnly => role == Role::Admin,
                LocalAccounts::None => false,
            }
    }
}

fn rank(r: Role) -> u8 {
    match r {
        Role::Viewer => 0,
        Role::Operator => 1,
        Role::Designer => 2,
        Role::Admin => 3,
    }
}

// ── The provider ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .user_agent(concat!("strata-graphics/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn get_json(url: &str) -> Result<Value, String> {
    let mut res = agent().get(url).call().map_err(|e| format!("{url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url}: HTTP {}", res.status()));
    }
    let bytes = res
        .body_mut()
        .with_config()
        .limit(2 << 20)
        .read_to_vec()
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{url}: {e}"))
}

/// (issuer it was read for, its discovery, when).
type Cached<T> = Mutex<Option<(String, T, Instant)>>;
static DISCOVERY: Cached<Discovery> = Mutex::new(None);
static KEYS: Cached<Vec<Value>> = Mutex::new(None);

fn discover(issuer: &str) -> Result<Discovery, String> {
    let issuer = issuer.trim().trim_end_matches('/');
    if let Some((i, d, at)) = DISCOVERY.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if i == issuer && at.elapsed() < Duration::from_secs(3600) {
            return Ok(d.clone());
        }
    }
    let v = get_json(&format!("{issuer}/.well-known/openid-configuration"))?;
    let d: Discovery = serde_json::from_value(v).map_err(|e| format!("discovery: {e}"))?;
    *DISCOVERY.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((issuer.to_string(), d.clone(), Instant::now()));
    Ok(d)
}

/// The provider's signing keys (read again for a key not seen yet, or
/// `fresh`: a key changed under the same id).
fn key(d: &Discovery, kid: Option<&str>, fresh: bool) -> Result<Value, String> {
    let find = |keys: &[Value]| {
        keys.iter()
            .find(|k| kid.is_none_or(|id| k["kid"].as_str() == Some(id)))
            .cloned()
    };
    if !fresh {
        let cached = KEYS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((u, keys, _)) = cached.as_ref() {
            if *u == d.jwks_uri {
                if let Some(k) = find(keys) {
                    return Ok(k);
                }
            }
        }
    }
    let v = get_json(&d.jwks_uri)?;
    let keys = v["keys"].as_array().cloned().unwrap_or_default();
    let k = find(&keys);
    *KEYS.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((d.jwks_uri.clone(), keys, Instant::now()));
    k.ok_or_else(|| "the provider does not have the key of this token".into())
}

/// Checks the signature of a JWT with a JWK (RS256, PS256, ES256).
fn verify_signature(jwt: &str, alg: &str, jwk: &Value) -> Result<(), String> {
    use ring::signature;
    let (signed, sig) = jwt.rsplit_once('.').ok_or("malformed token")?;
    let sig = B64.decode(sig).map_err(|_| "malformed signature")?;
    let b = |k: &str| {
        jwk[k]
            .as_str()
            .and_then(|s| B64.decode(s).ok())
            .ok_or_else(|| format!("key without `{k}`"))
    };
    match alg {
        "RS256" | "PS256" => {
            let key = signature::RsaPublicKeyComponents {
                n: b("n")?,
                e: b("e")?,
            };
            let params: &signature::RsaParameters = if alg == "RS256" {
                &signature::RSA_PKCS1_2048_8192_SHA256
            } else {
                &signature::RSA_PSS_2048_8192_SHA256
            };
            key.verify(params, signed.as_bytes(), &sig)
                .map_err(|_| "bad signature".to_string())
        }
        "ES256" => {
            let mut point = vec![4u8];
            point.extend(b("x")?);
            point.extend(b("y")?);
            signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                .verify(signed.as_bytes(), &sig)
                .map_err(|_| "bad signature".to_string())
        }
        other => Err(format!("token signed with {other}: not accepted")),
    }
}

/// The claims of an ID token, once checked.
fn check_id_token(
    jwt: &str,
    d: &Discovery,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Result<Value, String> {
    let mut parts = jwt.split('.');
    let (Some(h), Some(p), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("malformed token".into());
    };
    let header: Value = serde_json::from_slice(&B64.decode(h).map_err(|_| "malformed token")?)
        .map_err(|_| "malformed token")?;
    let claims: Value = serde_json::from_slice(&B64.decode(p).map_err(|_| "malformed token")?)
        .map_err(|_| "malformed token")?;
    let alg = header["alg"].as_str().unwrap_or("");
    let kid = header["kid"].as_str();
    if verify_signature(jwt, alg, &key(d, kid, false)?).is_err() {
        verify_signature(jwt, alg, &key(d, kid, true)?)?;
    }
    check_claims(&claims, &d.issuer, client_id, nonce, now)?;
    Ok(claims)
}

fn check_claims(
    c: &Value,
    issuer: &str,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Result<(), String> {
    if c["iss"].as_str() != Some(issuer) {
        return Err(format!("token from another issuer ({})", c["iss"]));
    }
    let aud_ok = match &c["aud"] {
        Value::String(a) => a == client_id,
        Value::Array(l) => l.iter().any(|a| a.as_str() == Some(client_id)),
        _ => false,
    };
    if !aud_ok {
        return Err("token for another application".into());
    }
    if c["exp"].as_i64().is_none_or(|exp| exp + 120 < now) {
        return Err("token expired (check the server's clock)".into());
    }
    if c["nonce"].as_str() != Some(nonce) {
        return Err("token not for this sign-in".into());
    }
    Ok(())
}

/// Who the claims say, and their groups.
fn identity(
    c: &Value,
    issuer: &str,
    groups_claim: &str,
) -> Result<(SsoIdentity, Vec<String>), String> {
    let sub = c["sub"].as_str().ok_or("token without subject")?;
    let s = |k: &str| {
        c[k].as_str()
            .map(str::to_string)
            .filter(|v| !v.trim().is_empty())
    };
    let email = s("email").filter(|_| c["email_verified"].as_bool() != Some(false));
    let login = email
        .or_else(|| s("preferred_username"))
        .or_else(|| s("upn"))
        .unwrap_or_else(|| sub.to_string());
    let groups = match &c[groups_claim] {
        Value::Array(l) => l
            .iter()
            .filter_map(|g| g.as_str().map(str::to_string))
            .collect(),
        Value::String(g) => vec![g.clone()],
        _ => Vec::new(),
    };
    if groups.is_empty() && c["_claim_names"][groups_claim].is_string() {
        tracing::warn!("SSO: {login} is in too many groups for the token (Entra: send only the groups assigned to the application)");
    }
    Ok((
        SsoIdentity {
            key: format!("{issuer}|{sub}"),
            login,
            name: s("name").unwrap_or_default(),
        },
        groups,
    ))
}

// ── The sign-in ───────────────────────────────────────────────────────────

struct Pending {
    nonce: String,
    verifier: String,
    redirect_uri: String,
    next: String,
    at: Instant,
}

fn pending() -> std::sync::MutexGuard<'static, HashMap<String, Pending>> {
    static P: std::sync::OnceLock<Mutex<HashMap<String, Pending>>> = std::sync::OnceLock::new();
    P.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn random() -> String {
    let mut b = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut b).expect("random");
    B64.encode(b)
}

/// RFC 3986 unreserved characters kept, the rest %XX.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Where the provider sends the user back: this server, as the browser
/// reached it.
fn callback_url(req: &Request) -> String {
    let scheme = if crate::tls::is_https(req.extensions(), req.headers()) {
        "https"
    } else {
        "http"
    };
    let host = req
        .headers()
        .get("x-forwarded-host")
        .or_else(|| req.headers().get(header::HOST))
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    format!("{scheme}://{host}/api/auth/sso/callback")
}

/// A page of this server to go back to after signing in ("/" otherwise).
fn safe_next(next: &str) -> String {
    if next.starts_with('/') && !next.starts_with("//") && !next.contains('\\') {
        next.to_string()
    } else {
        "/".into()
    }
}

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/auth/sso/start", get(start))
        .route("/api/auth/sso/callback", get(callback))
        .route("/api/security/sso/test", post(test))
}

#[derive(Deserialize)]
struct StartQuery {
    #[serde(default)]
    next: String,
}

async fn start(State(s): State<Shared>, Query(q): Query<StartQuery>, req: Request) -> Response {
    let cfg = s.config.security.sso.clone();
    if !cfg.ready() {
        return (StatusCode::NOT_FOUND, "SSO is off").into_response();
    }
    let issuer = cfg.issuer.clone();
    let d = match tokio::task::spawn_blocking(move || discover(&issuer)).await {
        Ok(Ok(d)) => d,
        Ok(Err(e)) => return back_with_error(&e),
        Err(e) => return back_with_error(&e.to_string()),
    };
    let (state, nonce, verifier) = (random(), random(), random());
    let challenge = B64.encode(ring::digest::digest(
        &ring::digest::SHA256,
        verifier.as_bytes(),
    ));
    let redirect_uri = callback_url(&req);
    let url = format!(
        "{auth}{sep}response_type=code&client_id={cid}&redirect_uri={ru}&scope={scope}&state={state}&nonce={nonce}&code_challenge={challenge}&code_challenge_method=S256",
        auth = d.authorization_endpoint,
        sep = if d.authorization_endpoint.contains('?') { '&' } else { '?' },
        cid = enc(cfg.client_id.trim()),
        ru = enc(&redirect_uri),
        scope = enc("openid profile email"),
    );
    {
        let mut p = pending();
        p.retain(|_, v| v.at.elapsed() < Duration::from_secs(600));
        p.insert(
            state,
            Pending {
                nonce,
                verifier,
                redirect_uri,
                next: safe_next(&q.next),
                at: Instant::now(),
            },
        );
    }
    Redirect::to(&url).into_response()
}

/// Back to the sign-in page, saying why: a reason the page words
/// (`noGroup`, `disabled`, `expired`), or the directory's own message.
fn back_with_error(e: &str) -> Response {
    tracing::warn!("SSO sign-in refused: {e}");
    let code = if e.contains("no group of yours") {
        "noGroup"
    } else if e.contains("disabled") {
        "disabled"
    } else if e.contains("expired: try again") {
        "expired"
    } else {
        "failed"
    };
    Redirect::to(&format!("/?sso_error={code}&sso_detail={}", enc(e))).into_response()
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn callback(
    State(s): State<Shared>,
    Query(q): Query<CallbackQuery>,
    req: Request,
) -> Response {
    if let Some(e) = q.error {
        return back_with_error(q.error_description.as_deref().unwrap_or(&e));
    }
    let (Some(code), Some(state)) = (q.code, q.state) else {
        return back_with_error("incomplete answer from the directory");
    };
    let Some(p) = pending().remove(&state) else {
        return back_with_error("sign-in expired: try again");
    };
    let cfg = s.config.security.sso.clone();
    if !cfg.ready() {
        return back_with_error("SSO is off");
    }
    let secure = crate::tls::is_https(req.extensions(), req.headers());
    let res = tokio::task::spawn_blocking(move || -> Result<(SsoIdentity, Vec<String>), String> {
        let d = discover(&cfg.issuer)?;
        let mut form = format!(
            "grant_type=authorization_code&code={}&redirect_uri={}&code_verifier={}",
            enc(&code),
            enc(&p.redirect_uri),
            enc(&p.verifier)
        );
        let mut req = agent()
            .post(&d.token_endpoint)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json");
        if cfg.client_secret.is_empty() {
            form.push_str(&format!("&client_id={}", enc(cfg.client_id.trim())));
        } else {
            let basic = base64::engine::general_purpose::STANDARD.encode(format!(
                "{}:{}",
                enc(cfg.client_id.trim()),
                enc(&cfg.client_secret)
            ));
            req = req.header("Authorization", &format!("Basic {basic}"));
        }
        let mut res = req.send(form).map_err(|e| e.to_string())?;
        let bytes = res
            .body_mut()
            .with_config()
            .limit(1 << 20)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|e| format!("token: {e}"))?;
        let Some(id_token) = body["id_token"].as_str() else {
            return Err(body["error_description"]
                .as_str()
                .or(body["error"].as_str())
                .unwrap_or("the directory gave no identity")
                .to_string());
        };
        let now = jiff::Timestamp::now().as_second();
        let claims = check_id_token(id_token, &d, cfg.client_id.trim(), &p.nonce, now)?;
        identity(&claims, &d.issuer, cfg.groups_claim.trim())
    })
    .await;
    let (who, groups) = match res {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return back_with_error(&e),
        Err(e) => return back_with_error(&e.to_string()),
    };
    let role = s.config.security.sso.role_for(&groups);
    match s.auth.sso_login(&who, role) {
        Ok((token, user)) => {
            tracing::info!(user = user.username, role = ?user.role, "signed in through SSO");
            let cookie = crate::api::session_cookie(&token, 14 * 24 * 3600, secure);
            ([(header::SET_COOKIE, cookie)], Redirect::to(&p.next)).into_response()
        }
        Err(e) => back_with_error(&format!("{e} ({})", who.login)),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestReply {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    keys: usize,
}

#[derive(Deserialize)]
struct TestInput {
    issuer: String,
}

/// Reads the provider's description and keys (the settings being edited).
async fn test(
    CurrentUser(me): CurrentUser,
    Json(t): Json<TestInput>,
) -> ApiResult<Json<TestReply>> {
    require(me.is_admin())?;
    let r = tokio::task::spawn_blocking(move || -> Result<TestReply, String> {
        let d = discover(&t.issuer)?;
        let keys = get_json(&d.jwks_uri)?["keys"]
            .as_array()
            .map_or(0, Vec::len);
        Ok(TestReply {
            issuer: d.issuer,
            authorization_endpoint: d.authorization_endpoint,
            token_endpoint: d.token_endpoint,
            keys,
        })
    })
    .await
    .map_err(crate::api::internal)?
    .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(r))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg() -> SsoConfig {
        SsoConfig {
            enabled: true,
            issuer: "https://id.example".into(),
            client_id: "strata".into(),
            groups: vec![
                GroupRole {
                    group: "GRP-Regie".into(),
                    role: Role::Operator,
                },
                GroupRole {
                    group: "GRP-Habillage".into(),
                    role: Role::Designer,
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn the_highest_group_role_wins() {
        let c = cfg();
        assert_eq!(
            c.role_for(&["grp-regie".into(), "/GRP-Habillage".into()]),
            Some(Role::Designer)
        );
        assert_eq!(c.role_for(&["other".into()]), None);
        let c = SsoConfig {
            default_role: Some(Role::Viewer),
            ..cfg()
        };
        assert_eq!(c.role_for(&[]), Some(Role::Viewer));
    }

    #[test]
    fn local_passwords_follow_the_setting() {
        let c = cfg();
        assert!(c.local_allowed(Role::Admin));
        assert!(!c.local_allowed(Role::Operator));
        let off = SsoConfig {
            enabled: false,
            ..cfg()
        };
        assert!(off.local_allowed(Role::Operator));
    }

    #[test]
    fn claims_are_checked() {
        let c = json!({"iss": "https://id.example", "aud": ["strata"], "exp": 1000, "nonce": "n", "sub": "42"});
        assert!(check_claims(&c, "https://id.example", "strata", "n", 900).is_ok());
        assert!(check_claims(&c, "https://other", "strata", "n", 900).is_err());
        assert!(check_claims(&c, "https://id.example", "other", "n", 900).is_err());
        assert!(check_claims(&c, "https://id.example", "strata", "x", 900).is_err());
        assert!(check_claims(&c, "https://id.example", "strata", "n", 2000).is_err());
    }

    #[test]
    fn identity_and_groups_come_from_the_claims() {
        let c =
            json!({"sub": "42", "email": "Marie@Redac.fr", "name": "Marie", "groups": ["A", "B"]});
        let (who, groups) = identity(&c, "https://id", "groups").unwrap();
        assert_eq!(who.key, "https://id|42");
        assert_eq!(who.login, "Marie@Redac.fr");
        assert_eq!(groups, vec!["A", "B"]);
        // An e-mail the provider did not verify is not used.
        let c = json!({"sub": "42", "email": "x@y", "email_verified": false, "preferred_username": "marie"});
        assert_eq!(identity(&c, "i", "groups").unwrap().0.login, "marie");
    }

    #[test]
    fn signatures_are_checked() {
        use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let kp = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        let public = kp.public_key().as_ref();
        let jwk =
            json!({"kty": "EC", "x": B64.encode(&public[1..33]), "y": B64.encode(&public[33..65])});
        let signed = format!(
            "{}.{}",
            B64.encode(br#"{"alg":"ES256"}"#),
            B64.encode(br#"{"sub":"1"}"#)
        );
        let sig = kp.sign(&rng, signed.as_bytes()).unwrap();
        let jwt = format!("{signed}.{}", B64.encode(sig.as_ref()));
        assert!(verify_signature(&jwt, "ES256", &jwk).is_ok());
        let forged = format!(
            "{}.{}",
            signed.replace('.', ".e"),
            jwt.rsplit('.').next().unwrap()
        );
        assert!(verify_signature(&forged, "ES256", &jwk).is_err());
        assert!(verify_signature(&jwt, "none", &jwk).is_err());
        assert!(verify_signature(&jwt, "HS256", &jwk).is_err());
    }

    #[test]
    fn only_pages_of_this_server_come_next() {
        assert_eq!(safe_next("/project/x"), "/project/x");
        assert_eq!(safe_next("//evil.example"), "/");
        assert_eq!(safe_next("https://evil.example"), "/");
    }
}
