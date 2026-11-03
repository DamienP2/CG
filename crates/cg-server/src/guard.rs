//! Requests a page of another site makes with the user's cookie (CSRF), and
//! what only the server's own machine may do.
//!
//! The web app (Designer, Operator…) is served by this server, so its calls
//! come from the same origin wherever the browser runs: another PC on the
//! network passes like the server itself. Automation (API keys, Companion,
//! the tray app, curl) sends no `Origin` and is not concerned.

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::state::Shared;

/// `host[:port]` of an origin or a Host header, lower case, without the
/// scheme's default port.
fn authority(s: &str) -> String {
    let s = s.trim().to_ascii_lowercase();
    let (scheme, rest) = match s.split_once("://") {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (String::new(), s),
    };
    let rest = rest.split('/').next().unwrap_or("").to_string();
    match (scheme.as_str(), rest.rsplit_once(':')) {
        ("http", Some((h, "80"))) | ("https", Some((h, "443"))) => h.to_string(),
        _ => rest,
    }
}

fn host_only(a: &str) -> &str {
    if let Some(r) = a.strip_prefix('[') {
        return r.split(']').next().unwrap_or(r);
    }
    a.rsplit_once(':').map(|(h, _)| h).unwrap_or(a)
}

/// Whether the request comes from a page of another site (its `Origin` is
/// neither this server's address, nor the address a reverse proxy forwarded,
/// nor one of `trusted`).
pub fn cross_site(headers: &HeaderMap, trusted: &[String]) -> bool {
    // Browsers on HTTPS or localhost tell it directly.
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site.eq_ignore_ascii_case("cross-site") {
            return !origin_trusted(headers, trusted);
        }
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if origin.trim() == "null" {
        // A sandboxed page or a local file.
        return true;
    }
    let o = authority(origin);
    let scheme = origin
        .split("://")
        .next()
        .unwrap_or("http")
        .to_ascii_lowercase();
    let mine = |v: &str| {
        v.split(',').any(|h| {
            let a = authority(&format!("{scheme}://{}", h.trim()));
            a == o || (host_only(&a) == host_only(&o) && !a.contains(':'))
        })
    };
    let ok = ["host", "x-forwarded-host"].iter().any(|k| {
        headers
            .get(*k)
            .and_then(|v| v.to_str().ok())
            .is_some_and(mine)
    });
    !ok && !origin_trusted(headers, trusted)
}

fn origin_trusted(headers: &HeaderMap, trusted: &[String]) -> bool {
    let Some(o) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let o = authority(o);
    trusted.iter().any(|t| authority(t) == o)
}

/// Whether the request is the server's own machine speaking for itself (the
/// tray app, the first-run page on http://localhost): from the loopback, not
/// sent by a page of another site, and to a local name (a site whose name
/// leads to 127.0.0.1 is not the machine).
pub fn this_machine(peer: &std::net::SocketAddr, headers: &HeaderMap) -> bool {
    if !peer.ip().is_loopback() || cross_site(headers, &[]) {
        return false;
    }
    let local = |v: &str| {
        let h = host_only(&authority(v)).to_string();
        h == "localhost"
            || h == "::1"
            || h.parse::<std::net::Ipv4Addr>()
                .is_ok_and(|ip| ip.is_loopback())
    };
    let host_ok = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_none_or(local);
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_none_or(local);
    host_ok && origin_ok
}

fn changes(req: &Request) -> bool {
    !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        || req
            .headers()
            .get(header::UPGRADE)
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
}

fn with_cookie_only(h: &HeaderMap) -> bool {
    h.get(header::AUTHORIZATION).is_none() && h.contains_key(header::COOKIE)
}

/// Refuses what changes something (and live connections) when a page of
/// another site sends it with the user's cookie. API keys pass.
pub async fn csrf(State(s): State<Shared>, req: Request, next: Next) -> Response {
    if changes(&req)
        && with_cookie_only(req.headers())
        && !req.uri().query().is_some_and(|q| q.contains("key="))
        && cross_site(req.headers(), &s.config.trusted_origins)
    {
        let origin = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("?");
        tracing::warn!(
            "refused {} {} sent by another site ({origin}); add it to trustedOrigins in the settings file if it is yours",
            req.method(),
            req.uri().path()
        );
        return (
            StatusCode::FORBIDDEN,
            "request sent by another site refused",
        )
            .into_response();
    }
    next.run(req).await
}

/// Files people upload, served so that none can run as a page of this site
/// (an HTML or SVG file opened directly gets no access to the session).
pub async fn uploaded_files(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox allow-scripts allow-popups allow-forms"),
    );
    res
}

/// On every answer: no guessing a file's type from its content.
pub async fn every_answer(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.entry(header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(HeaderValue::from_static("nosniff"));
    h.entry(header::REFERRER_POLICY)
        .or_insert(HeaderValue::from_static("same-origin"));
    res
}

/// Failed logins: after a few, each try waits longer (per address and user
/// name together, and more loosely per address), so passwords cannot be
/// guessed in bulk. Nobody else is locked out of their account.
pub struct Logins(std::sync::Mutex<std::collections::HashMap<String, (u32, std::time::Instant)>>);

const FREE_TRIES_USER: u32 = 5;
const FREE_TRIES_ADDR: u32 = 20;
const FORGET: std::time::Duration = std::time::Duration::from_secs(15 * 60);
const LONGEST: std::time::Duration = std::time::Duration::from_secs(5 * 60);

impl Logins {
    pub fn new() -> Self {
        Self(Default::default())
    }

    fn keys(ip: std::net::IpAddr, user: &str) -> [(String, u32); 2] {
        [
            (
                format!("{ip}|{}", user.trim().to_lowercase()),
                FREE_TRIES_USER,
            ),
            (ip.to_string(), FREE_TRIES_ADDR),
        ]
    }

    /// How long before the next try is allowed (`None`: now).
    pub fn wait(&self, ip: std::net::IpAddr, user: &str) -> Option<std::time::Duration> {
        let mut m = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let now = std::time::Instant::now();
        m.retain(|_, (_, last)| now.duration_since(*last) < FORGET);
        Self::keys(ip, user)
            .iter()
            .filter_map(|(k, free)| {
                let (n, last) = *m.get(k)?;
                let over = n.checked_sub(*free)?;
                let wait = (std::time::Duration::from_secs(1) * 2u32.saturating_pow(over.min(9)))
                    .min(LONGEST);
                (now.duration_since(last) < wait).then(|| wait - now.duration_since(last))
            })
            .max()
    }

    pub fn failed(&self, ip: std::net::IpAddr, user: &str) {
        let mut m = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let now = std::time::Instant::now();
        for (k, _) in Self::keys(ip, user) {
            let e = m.entry(k).or_insert((0, now));
            e.0 += 1;
            e.1 = now;
        }
    }

    pub fn succeeded(&self, ip: std::net::IpAddr, user: &str) {
        let mut m = self.0.lock().unwrap_or_else(|p| p.into_inner());
        m.remove(&Self::keys(ip, user)[0].0);
    }
}

impl Default for Logins {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(*k, v.parse().unwrap());
        }
        m
    }

    #[test]
    fn another_pc_of_the_network_is_the_same_site() {
        let x = h(&[
            ("host", "192.168.1.10:8080"),
            ("origin", "http://192.168.1.10:8080"),
        ]);
        assert!(!cross_site(&x, &[]));
        // No Origin at all: automation.
        assert!(!cross_site(&h(&[("host", "10.0.0.2:8080")]), &[]));
        // Behind a reverse proxy that keeps the name.
        let x = h(&[
            ("host", "cg.example.org"),
            ("origin", "https://cg.example.org"),
        ]);
        assert!(!cross_site(&x, &[]));
        let x = h(&[
            ("host", "127.0.0.1:8080"),
            ("x-forwarded-host", "cg.example.org"),
            ("origin", "https://cg.example.org"),
        ]);
        assert!(!cross_site(&x, &[]));
        let x = h(&[
            ("host", "localhost:8080"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert!(!cross_site(&x, &[]));
    }

    #[test]
    fn a_page_of_another_site_is_not() {
        let x = h(&[
            ("host", "192.168.1.10:8080"),
            ("origin", "http://evil.example"),
        ]);
        assert!(cross_site(&x, &[]));
        let x = h(&[
            ("host", "192.168.1.10:8080"),
            ("origin", "http://192.168.1.10:9999"),
        ]);
        assert!(cross_site(&x, &[]));
        let x = h(&[
            ("host", "localhost:8080"),
            ("sec-fetch-site", "cross-site"),
            ("origin", "https://evil.example"),
        ]);
        assert!(cross_site(&x, &[]));
        assert!(cross_site(&h(&[("host", "a:1"), ("origin", "null")]), &[]));
        // Unless trusted.
        assert!(!cross_site(&x, &["https://evil.example".into()]));
    }

    #[test]
    fn guessing_passwords_slows_down() {
        let l = Logins::new();
        let ip: std::net::IpAddr = "10.0.0.9".parse().unwrap();
        let other: std::net::IpAddr = "10.0.0.10".parse().unwrap();
        for _ in 0..FREE_TRIES_USER {
            assert!(l.wait(ip, "admin").is_none());
            l.failed(ip, "admin");
        }
        l.failed(ip, "admin");
        assert!(l.wait(ip, "Admin").is_some());
        // The real user, elsewhere, is not locked out.
        assert!(l.wait(other, "admin").is_none());
        l.succeeded(ip, "admin");
        assert!(l.wait(ip, "admin").is_none());
    }

    #[test]
    fn only_local_names_are_this_machine() {
        let lo: std::net::SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let far: std::net::SocketAddr = "192.168.1.20:5000".parse().unwrap();
        assert!(this_machine(&lo, &h(&[("host", "127.0.0.1:8080")])));
        assert!(this_machine(
            &lo,
            &h(&[
                ("host", "localhost:8080"),
                ("origin", "http://localhost:8080")
            ])
        ));
        assert!(this_machine(&lo, &h(&[("host", "[::1]:8080")])));
        assert!(!this_machine(&far, &h(&[("host", "127.0.0.1:8080")])));
        // DNS rebinding: a site whose name leads to 127.0.0.1.
        assert!(!this_machine(
            &lo,
            &h(&[
                ("host", "evil.example:8080"),
                ("origin", "http://evil.example:8080")
            ])
        ));
        assert!(!this_machine(
            &lo,
            &h(&[
                ("host", "localhost:8080"),
                ("origin", "http://evil.example")
            ])
        ));
    }
}
