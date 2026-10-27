//! The picture library: icons, emojis and flags of the Iconify catalogue,
//! illustrations of unDraw, browsed online by the server (the clients need
//! no Internet) and copied into a project's media when one is used, so that
//! the antenna never needs the Internet.
//!
//! `STRATA_ICONIFY_URL` and `STRATA_UNDRAW_URL` change where they are read.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json_;

use crate::api::{bad, internal, require, visible_project, ApiResult};
use crate::auth::{CurrentUser, Role};
use crate::state::Shared;

/// Pictures per page.
const PAGE: usize = 96;
/// The colour of unDraw's illustrations, replaced by the one chosen.
const UNDRAW_COLOR: &str = "#6c63ff";

pub fn router() -> Router<Shared> {
    Router::new()
        .route("/api/iconlib/search", get(search))
        .route("/api/iconlib/svg", get(svg))
        .route("/api/projects/{id}/iconlib", post(use_picture))
}

fn iconify() -> String {
    std::env::var("STRATA_ICONIFY_URL").unwrap_or_else(|_| "https://api.iconify.design".into())
}
fn undraw() -> String {
    std::env::var("STRATA_UNDRAW_URL").unwrap_or_else(|_| "https://undraw.co".into())
}

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(Some(Duration::from_secs(12)))
        .max_redirects(5)
        .http_status_as_error(false)
        .user_agent(concat!("strata-graphics/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn get_text(url: &str) -> Result<String, String> {
    let mut res = agent().get(url).call().map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{}", res.status()));
    }
    res.body_mut()
        .with_config()
        .limit(20 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())
}

fn post_json(url: &str, body: &Json_) -> Result<String, String> {
    let mut res = agent()
        .post(url)
        .header("content-type", "application/json")
        .send(body.to_string())
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{}", res.status()));
    }
    res.body_mut()
        .with_config()
        .limit(20 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())
}

/// Answers kept a while (lists, searches): the catalogue moves little.
fn cached(key: &str, read: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((at, v)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(key) {
        if at.elapsed() < Duration::from_secs(3600) {
            return Ok(v.clone());
        }
    }
    let v = read()?;
    let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
    if c.len() > 500 {
        c.clear();
    }
    c.insert(key.to_string(), (Instant::now(), v.clone()));
    Ok(v)
}

/// A set name or an icon name of the catalogue (letters, digits, - _).
fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `#rrggbb` (or `#rgb`), else none.
fn valid_color(c: &str) -> bool {
    let h = c.strip_prefix('#').unwrap_or("");
    matches!(h.len(), 3 | 6) && h.chars().all(|x| x.is_ascii_hexdigit())
}

#[derive(Deserialize)]
struct SearchQuery {
    /// An Iconify set (`lucide`, `noto`, `flag`…) or `undraw`.
    set: String,
    #[serde(default)]
    q: String,
    #[serde(default)]
    page: usize,
}

/// A picture of the library.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    /// The icon's name in its set, or the illustration's address.
    name: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Found {
    items: Vec<Item>,
    more: bool,
}

/// Names of a set: every icon of it (`/collection`).
fn collection(set: &str) -> Result<Vec<String>, String> {
    let body = cached(&format!("col:{set}"), || {
        get_text(&format!("{}/collection?prefix={set}", iconify()))
    })?;
    let v: Json_ = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = Vec::new();
    let mut add = |a: &Json_| {
        for n in a
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str())
        {
            names.push(n.to_string());
        }
    };
    if let Some(u) = v.get("uncategorized") {
        add(u);
    }
    if let Some(cats) = v.get("categories").and_then(|c| c.as_object()) {
        for a in cats.values() {
            add(a);
        }
    }
    let mut seen = std::collections::HashSet::new();
    names.retain(|n| seen.insert(n.clone()));
    Ok(names)
}

fn iconify_page(set: &str, q: &str, page: usize) -> Result<Found, String> {
    if q.trim().is_empty() {
        let names = collection(set)?;
        let from = page * PAGE;
        let items = names
            .iter()
            .skip(from)
            .take(PAGE)
            .map(|n| Item {
                name: n.clone(),
                title: n.replace('-', " "),
            })
            .collect();
        return Ok(Found {
            items,
            more: names.len() > from + PAGE,
        });
    }
    let q: String = url_encode(q.trim());
    let body = cached(&format!("s:{set}:{q}:{page}"), || {
        get_text(&format!(
            "{}/search?query={q}&prefix={set}&limit={}&start={}",
            iconify(),
            PAGE,
            page * PAGE
        ))
    })?;
    let v: Json_ = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let items: Vec<Item> = v
        .get("icons")
        .and_then(|a| a.as_array())
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str())
        .filter_map(|id| id.split_once(':'))
        .filter(|(p, _)| *p == set)
        .map(|(_, n)| Item {
            name: n.to_string(),
            title: n.replace('-', " "),
        })
        .collect();
    let total = v.get("total").and_then(|t| t.as_u64()).unwrap_or(0) as usize;
    Ok(Found {
        more: total > (page + 1) * PAGE,
        items,
    })
}

/// The illustrations of an unDraw answer, whatever its shape: every object
/// with an `.svg` address and a title.
fn svg_objects(v: &Json_, out: &mut Vec<Item>) {
    match v {
        Json_::Array(a) => a.iter().for_each(|x| svg_objects(x, out)),
        Json_::Object(o) => {
            let url = o.values().filter_map(|x| x.as_str()).find(|s| {
                (s.starts_with("https://") || s.starts_with("http://"))
                    && s.split('?').next().is_some_and(|p| p.ends_with(".svg"))
            });
            match url {
                Some(u) => out.push(Item {
                    name: u.to_string(),
                    title: ["title", "name", "slug"]
                        .iter()
                        .find_map(|k| o.get(*k).and_then(|x| x.as_str()))
                        .unwrap_or("")
                        .to_string(),
                }),
                None => o.values().for_each(|x| svg_objects(x, out)),
            }
        }
        _ => {}
    }
}

fn undraw_page(q: &str, page: usize) -> Result<Found, String> {
    let body = if q.trim().is_empty() {
        cached(&format!("u:{page}"), || {
            get_text(&format!("{}/api/illustrations?page={}", undraw(), page + 1))
        })?
    } else {
        cached(&format!("us:{q}"), || {
            post_json(
                &format!("{}/api/search", undraw()),
                &serde_json::json!({ "query": q.trim() }),
            )
        })?
    };
    let v: Json_ = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    svg_objects(&v, &mut items);
    let more = q.trim().is_empty()
        && v.get("hasMore")
            .and_then(|m| m.as_bool())
            .unwrap_or(!items.is_empty());
    Ok(Found { items, more })
}

/// Offline, or the catalogue does not answer: said as such (503).
fn offline(e: String) -> (axum::http::StatusCode, String) {
    (axum::http::StatusCode::SERVICE_UNAVAILABLE, e)
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn search(
    CurrentUser(_): CurrentUser,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Found>> {
    if q.set != "undraw" && !valid_name(&q.set) {
        return Err(bad("unknown set"));
    }
    let found = tokio::task::spawn_blocking(move || {
        if q.set == "undraw" {
            undraw_page(&q.q, q.page)
        } else {
            iconify_page(&q.set, &q.q, q.page)
        }
    })
    .await
    .map_err(internal)?
    // Offline, or the catalogue does not answer: said as such (503).
    .map_err(|e| offline(format!("the picture library cannot be reached: {e}")))?;
    Ok(Json(found))
}

#[derive(Deserialize, Clone)]
struct SvgQuery {
    set: String,
    name: String,
    /// `#rrggbb`: monochrome icons drawn in it, illustrations' colour.
    #[serde(default)]
    color: String,
}

/// Where the pictures read are kept (by set, name and colour).
fn cache_dir(s: &Shared) -> PathBuf {
    s.data_dir.join("cache").join("iconlib")
}

/// The SVG of a picture of the library, read once then kept.
fn read_svg(dir: &std::path::Path, q: &SvgQuery) -> Result<String, String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&q.set, &q.name, &q.color).hash(&mut h);
    let file = dir.join(format!("{:016x}.svg", h.finish()));
    if let Ok(s) = std::fs::read_to_string(&file) {
        return Ok(s);
    }
    let color = valid_color(&q.color).then_some(q.color.as_str());
    let svg = if q.set == "undraw" {
        // Only unDraw's own addresses.
        let base = undraw();
        let host_ok = q.name.starts_with("https://cdn.undraw.co/")
            || q.name.starts_with("https://undraw.co/")
            || q.name.starts_with(&format!("{base}/"));
        if !host_ok {
            return Err("not an unDraw picture".into());
        }
        let svg = get_text(&q.name)?;
        match color {
            Some(c) => svg
                .replace(UNDRAW_COLOR, c)
                .replace(&UNDRAW_COLOR.to_uppercase(), c),
            None => svg,
        }
    } else {
        if !valid_name(&q.set) || !valid_name(&q.name) {
            return Err("unknown picture".into());
        }
        let c = color
            .map(|c| format!("?color={}", url_encode(c)))
            .unwrap_or_default();
        get_text(&format!("{}/{}/{}.svg{c}", iconify(), q.set, q.name))?
    };
    if !svg.contains("<svg") {
        return Err("not a picture".into());
    }
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&file, &svg);
    Ok(svg)
}

async fn svg(
    State(s): State<Shared>,
    CurrentUser(_): CurrentUser,
    Query(q): Query<SvgQuery>,
) -> ApiResult<Response> {
    let dir = cache_dir(&s);
    let svg = tokio::task::spawn_blocking(move || read_svg(&dir, &q))
        .await
        .map_err(internal)?
        .map_err(offline)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "max-age=86400"),
        ],
        svg,
    )
        .into_response())
}

#[derive(Deserialize)]
struct UseBody {
    set: String,
    name: String,
    #[serde(default)]
    color: String,
    /// What the file is called in the media.
    #[serde(default)]
    title: String,
}

/// A file name from a title: letters, digits and dashes.
fn file_stem(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        let c = match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').chars().take(60).collect::<String>();
    if out.is_empty() {
        "picture".into()
    } else {
        out
    }
}

/// A picture of the library copied into the project's media: its file.
async fn use_picture(
    State(s): State<Shared>,
    CurrentUser(me): CurrentUser,
    Path(id): Path<String>,
    Json(b): Json<UseBody>,
) -> ApiResult<Json<crate::media::MediaFile>> {
    visible_project(&s, &me, &id).await?;
    require(me.role != Role::Viewer)?;
    let q = SvgQuery {
        set: b.set.clone(),
        name: b.name.clone(),
        color: b.color.clone(),
    };
    let dir = cache_dir(&s);
    let svg = tokio::task::spawn_blocking(move || read_svg(&dir, &q))
        .await
        .map_err(internal)?
        .map_err(offline)?;
    let title = if b.title.trim().is_empty() {
        if b.set == "undraw" {
            "illustration".to_string()
        } else {
            b.name.clone()
        }
    } else {
        b.title.clone()
    };
    let color = b.color.trim_start_matches('#');
    let stem = file_stem(&if valid_color(&b.color) {
        format!("{title}-{color}")
    } else {
        title
    });
    crate::media::put_bytes(&s, &id, &format!("{stem}.svg"), sized(&svg).into_bytes())
        .await
        .map(Json)
}

/// The SVG at a size the renderer draws sharply (its longest side 512 px,
/// from its viewBox): the catalogue's icons are written 1em.
fn sized(svg: &str) -> String {
    let Some(start) = svg.find("<svg") else {
        return svg.to_string();
    };
    let Some(end) = svg[start..].find('>').map(|e| start + e) else {
        return svg.to_string();
    };
    let tag = &svg[start..end];
    let attr = |name: &str| -> Option<(usize, usize, String)> {
        let at = tag.find(&format!(" {name}=\""))?;
        let from = at + name.len() + 3;
        let to = from + tag[from..].find('"')?;
        Some((at, to + 1, tag[from..to].to_string()))
    };
    let Some((_, _, vb)) = attr("viewBox") else {
        return svg.to_string();
    };
    let n: Vec<f64> = vb
        .split([' ', ','])
        .filter_map(|x| x.parse().ok())
        .collect();
    let (w, h) = match n[..] {
        [_, _, w, h] if w > 0.0 && h > 0.0 => (w, h),
        _ => return svg.to_string(),
    };
    let k = 512.0 / w.max(h);
    let mut tag = tag.to_string();
    for name in ["width", "height"] {
        let t = tag.clone();
        let at = t.find(&format!(" {name}=\""));
        if let Some(at) = at {
            let from = at + name.len() + 3;
            if let Some(len) = t[from..].find('"') {
                tag.replace_range(at..from + len + 1, "");
            }
        }
    }
    tag.push_str(&format!(
        " width=\"{}\" height=\"{}\"",
        (w * k).round(),
        (h * k).round()
    ));
    format!("{}{}{}", &svg[..start], tag, &svg[end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn illustrations_are_found_whatever_the_answer() {
        let v: Json_ = serde_json::json!({
            "illos": [
                { "_id": "1", "title": "Weather", "image": "https://cdn.undraw.co/illustrations/weather.svg" },
                { "_id": "2", "title": "No picture" }
            ],
            "hasMore": true
        });
        let mut items = Vec::new();
        svg_objects(&v, &mut items);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Weather");
        assert_eq!(file_stem("Météo · soleil!"), "meteo-soleil");
        assert!(valid_color("#22c55e") && !valid_color("red"));
        assert_eq!(url_encode("a b/é"), "a%20b%2F%C3%A9");
        assert_eq!(
            sized(r#"<svg xmlns="x" width="1em" height="1em" viewBox="0 0 24 12"><g/></svg>"#),
            r#"<svg xmlns="x" viewBox="0 0 24 12" width="512" height="256"><g/></svg>"#
        );
    }
}
