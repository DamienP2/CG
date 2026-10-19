//! Web app and fonts served from inside the binary (single-file install).

use axum::extract::Path;
use axum::http::{header, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct WebApp;

const NOT_BUILT: &str = "<!doctype html><meta charset=utf-8><title>Strata</title>\
<body style=\"font:15px system-ui;background:#0b0c12;color:#e6e8f2;padding:40px\">\
<h2>Web app not built</h2><p>Run <code>cd web &amp;&amp; npm install &amp;&amp; npm run build</code> \
then rebuild the server, or start it with <code>--web-dir web/dist</code>.</p>";

/// Serves embedded files, falling back to `index.html` for client routes.
pub async fn embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(file) = WebApp::get(path).filter(|_| !path.is_empty()) {
        // Vite fingerprints everything under static/.
        let cache = if path.starts_with("static/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (header::CONTENT_TYPE, file.metadata.mimetype().to_string()),
                (header::CACHE_CONTROL, cache.to_string()),
            ],
            file.data,
        )
            .into_response();
    }
    match WebApp::get("index.html") {
        Some(index) => ([(header::CACHE_CONTROL, "no-cache")], Html(index.data)).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, Html(NOT_BUILT)).into_response(),
    }
}

pub async fn font(Path(name): Path<String>) -> Response {
    match cg_render::BUNDLED_FONTS.iter().find(|(n, _)| *n == name) {
        Some((_, data)) => (
            [
                (header::CONTENT_TYPE, "font/otf"),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            *data,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
