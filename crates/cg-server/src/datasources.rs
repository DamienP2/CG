//! Data connectors: documents fetched on a schedule (JSON API, CSV or a
//! Google Sheet, RSS / Atom feed, XML) or pushed by automation, kept as JSON
//! values. Template fields bound to a source (see `cg_core::datapath`) are
//! refreshed on air whenever its value changes.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

use crate::state::{now_ms, Event, Shared};

/// Largest document accepted.
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    /// The project it belongs to; none = shared by every project (the Data
    /// page of the main menu).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(flatten)]
    pub kind: Kind,
    /// Seconds between two fetches (fetched sources).
    #[serde(default = "default_interval")]
    pub interval: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn default_interval() -> u32 {
    30
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Kind {
    /// A JSON document over HTTP(S).
    Json {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    /// CSV (or a Google Sheet link): `{columns, rows: [{column: value}]}`.
    Csv {
        url: String,
        /// First line names the columns.
        #[serde(default = "yes")]
        header: bool,
    },
    /// RSS / Atom: `{title, items: [{title, description, link, date}]}`.
    Rss { url: String },
    /// Any XML: elements become keys, repeated ones arrays, attributes `@name`.
    Xml {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    /// Values sent to `PUT /api/data/sources/{id}/value` (JSON, CSV or XML).
    Push {
        #[serde(default)]
        format: PushFormat,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushFormat {
    #[default]
    Json,
    Csv,
    Xml,
}

impl Kind {
    fn url(&self) -> Option<&str> {
        match self {
            Kind::Json { url, .. }
            | Kind::Csv { url, .. }
            | Kind::Rss { url }
            | Kind::Xml { url, .. } => Some(url),
            Kind::Push { .. } => None,
        }
    }
}

/// Latest value of a source, as reported to clients.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(skip)]
    pub value: Option<Json>,
    pub updated_at: Option<i64>,
    pub checked_at: Option<i64>,
    pub error: Option<String>,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    #[serde(flatten)]
    pub source: Source,
    #[serde(flatten)]
    pub status: Status,
}

pub struct Hub {
    dir: PathBuf,
    sources: RwLock<Vec<Source>>,
    status: RwLock<HashMap<String, Status>>,
    pub wake: tokio::sync::Notify,
}

impl Hub {
    /// Sources from `<data>/data/sources.json`, last values from
    /// `<data>/data/values/` (so graphics have data right after a restart).
    pub fn load(data_dir: &Path) -> Self {
        let dir = data_dir.join("data");
        let sources: Vec<Source> = std::fs::read(dir.join("sources.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut status = HashMap::new();
        for s in &sources {
            if let Some(v) = std::fs::read(value_path(&dir, &s.id))
                .ok()
                .and_then(|b| serde_json::from_slice::<Json>(&b).ok())
            {
                let at = std::fs::metadata(value_path(&dir, &s.id))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64);
                status.insert(
                    s.id.clone(),
                    Status {
                        value: Some(v),
                        updated_at: at,
                        ..Default::default()
                    },
                );
            }
        }
        Self {
            dir,
            sources: RwLock::new(sources),
            status: RwLock::new(status),
            wake: tokio::sync::Notify::new(),
        }
    }

    pub fn list(&self) -> Vec<SourceInfo> {
        let status = self.status.read().unwrap_or_else(|e| e.into_inner());
        self.sources
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|s| SourceInfo {
                source: s.clone(),
                status: status.get(&s.id).cloned().unwrap_or_default(),
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Source> {
        self.sources
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|s| s.id == id)
            .cloned()
    }

    pub fn value(&self, id: &str) -> Option<Json> {
        self.status
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .and_then(|s| s.value.clone())
    }

    /// Every source value, for binding.
    pub fn store(&self) -> cg_core::datapath::Store {
        self.status
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|(k, s)| s.value.clone().map(|v| (k.clone(), v)))
            .collect()
    }

    /// Creates or replaces a source.
    pub fn put(&self, source: Source) -> anyhow::Result<()> {
        let mut list = self.sources.write().unwrap_or_else(|e| e.into_inner());
        match list.iter_mut().find(|s| s.id == source.id) {
            Some(s) => *s = source,
            None => list.push(source),
        }
        self.save(&list)?;
        drop(list);
        self.wake.notify_one();
        Ok(())
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<bool> {
        let mut list = self.sources.write().unwrap_or_else(|e| e.into_inner());
        let before = list.len();
        list.retain(|s| s.id != id);
        if list.len() == before {
            return Ok(false);
        }
        self.save(&list)?;
        self.status
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        let _ = std::fs::remove_file(value_path(&self.dir, id));
        Ok(true)
    }

    fn save(&self, list: &[Source]) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join("sources.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
        std::fs::rename(tmp, self.dir.join("sources.json"))?;
        Ok(())
    }

    /// Records a fetch or push. Returns true when the value changed.
    pub fn record(&self, id: &str, result: Result<(Json, usize), String>) -> bool {
        let now = now_ms();
        let mut all = self.status.write().unwrap_or_else(|e| e.into_inner());
        let st = all.entry(id.to_string()).or_default();
        st.checked_at = Some(now);
        match result {
            Ok((v, bytes)) => {
                st.error = None;
                st.bytes = bytes;
                if st.value.as_ref() == Some(&v) {
                    return false;
                }
                if std::fs::create_dir_all(self.dir.join("values")).is_ok() {
                    let _ = std::fs::write(value_path(&self.dir, id), v.to_string());
                }
                st.value = Some(v);
                st.updated_at = Some(now);
                true
            }
            Err(e) => {
                st.error = Some(e);
                false
            }
        }
    }

    fn due(&self) -> Vec<Source> {
        let now = now_ms();
        let status = self.status.read().unwrap_or_else(|e| e.into_inner());
        self.sources
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|s| s.enabled && s.kind.url().is_some())
            .filter(|s| {
                status
                    .get(&s.id)
                    .and_then(|st| st.checked_at)
                    .is_none_or(|t| now - t >= i64::from(s.interval.max(2)) * 1000)
            })
            .cloned()
            .collect()
    }

    /// Forgets when a source was last checked, so it is fetched now.
    pub fn refresh(&self, id: &str) {
        if let Some(st) = self
            .status
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(id)
        {
            st.checked_at = None;
        }
        self.wake.notify_one();
    }
}

fn value_path(dir: &Path, id: &str) -> PathBuf {
    dir.join("values").join(format!("{id}.json"))
}

/// Fetches due sources, forever (one engine cycle).
pub async fn run(shared: Shared) {
    loop {
        for s in shared.data.due() {
            let res = tokio::task::spawn_blocking({
                let s = s.clone();
                move || fetch(&s)
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
            if let Err(e) = &res {
                tracing::debug!(source = %s.id, "data source: {e}");
            }
            let changed = shared.data.record(&s.id, res);
            updated(&shared, &s.id, changed).await;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            _ = shared.data.wake.notified() => {}
        }
    }
}

/// Tells clients, and refreshes the graphics on air bound to the source.
pub async fn updated(shared: &Shared, id: &str, changed: bool) {
    let status = shared
        .data
        .list()
        .into_iter()
        .find(|s| s.source.id == id)
        .map(|s| s.status)
        .unwrap_or_default();
    let _ = shared.events.send(Event::Data {
        source: id.to_string(),
        status,
    });
    if changed {
        shared.rebind(Some(id)).await;
    }
}

// ------------------------------------------------------------------ fetch ---

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(Some(Duration::from_secs(15)))
        .max_redirects(5)
        .http_status_as_error(false)
        .user_agent(concat!("pulse-cg/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

pub fn fetch(s: &Source) -> Result<(Json, usize), String> {
    let url = s.kind.url().ok_or("this source receives pushed values")?;
    let url = google_sheet_csv(url).unwrap_or_else(|| url.to_string());
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("the address must start with http:// or https://".into());
    }
    let mut req = agent().get(&url);
    let headers = match &s.kind {
        Kind::Json { headers, .. } | Kind::Xml { headers, .. } => Some(headers),
        _ => None,
    };
    for (k, v) in headers.into_iter().flatten() {
        req = req.header(k.as_str(), v.as_str());
    }
    let mut res = req
        .call()
        .map_err(|e| format!("cannot reach the address: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("the server answered {status}"));
    }
    let body = res
        .body_mut()
        .with_config()
        .limit(MAX_BYTES)
        .read_to_vec()
        .map_err(|e| format!("cannot read the answer: {e}"))?;
    let n = body.len();
    let text = String::from_utf8_lossy(&body);
    let v = match &s.kind {
        Kind::Json { .. } => serde_json::from_slice(&body).map_err(|e| format!("not JSON: {e}"))?,
        Kind::Csv { header, .. } => csv_json(&text, *header),
        Kind::Rss { .. } => rss_json(&text)?,
        Kind::Xml { .. } => xml_json(&text)?,
        Kind::Push { .. } => unreachable!(),
    };
    Ok((v, n))
}

/// Parses a pushed document.
pub fn parse_push(format: PushFormat, body: &[u8]) -> Result<Json, String> {
    let text = String::from_utf8_lossy(body);
    match format {
        PushFormat::Json => serde_json::from_slice(body).map_err(|e| format!("not JSON: {e}")),
        PushFormat::Csv => Ok(csv_json(&text, true)),
        PushFormat::Xml => xml_json(&text),
    }
}

/// A Google Sheets link (…/spreadsheets/d/<id>/edit#gid=<n>) as its CSV
/// export. The sheet must be shared with "anyone with the link".
fn google_sheet_csv(url: &str) -> Option<String> {
    let rest = url.split("docs.google.com/spreadsheets/d/").nth(1)?;
    let id = rest.split('/').next()?;
    if id == "e" || rest.contains("output=csv") || rest.contains("format=csv") {
        return None;
    }
    let gid = url
        .split("gid=")
        .nth(1)
        .map(|g| {
            g.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
        })
        .filter(|g| !g.is_empty())
        .unwrap_or_else(|| "0".into());
    Some(format!(
        "https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}"
    ))
}

/// CSV → `{columns, rows}`; the separator (`,` `;` or tab) is guessed.
pub fn csv_json(text: &str, header: bool) -> Json {
    let text = text.trim_start_matches('\u{feff}');
    let first = text.lines().next().unwrap_or("");
    let sep = [',', ';', '\t']
        .into_iter()
        .max_by_key(|c| first.matches(*c).count())
        .unwrap_or(',');
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut field = String::new();
    let mut row = Vec::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                c => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            c if c == sep => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut row));
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        records.push(row);
    }
    records.retain(|r| r.iter().any(|f| !f.trim().is_empty()));
    if !header {
        return serde_json::json!({ "rows": records });
    }
    let mut it = records.into_iter();
    let columns: Vec<String> = it
        .next()
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.trim().to_string())
        .collect();
    let rows: Vec<Json> = it
        .map(|r| {
            let mut o = Map::new();
            for (i, c) in columns.iter().enumerate() {
                let key = if c.is_empty() {
                    format!("col{}", i + 1)
                } else {
                    c.clone()
                };
                o.insert(key, Json::String(r.get(i).cloned().unwrap_or_default()));
            }
            Json::Object(o)
        })
        .collect();
    serde_json::json!({ "columns": columns, "rows": rows })
}

/// RSS 2.0 or Atom → `{title, items: [{title, description, link, date}]}`.
pub fn rss_json(text: &str) -> Result<Json, String> {
    let doc = roxmltree::Document::parse(text).map_err(|e| format!("not XML: {e}"))?;
    let root = doc.root_element();
    let child_text = |n: roxmltree::Node, name: &str| {
        n.children()
            .find(|c| c.is_element() && c.tag_name().name() == name)
            .map(|c| {
                if name == "link" {
                    c.attribute("href")
                        .map(str::to_string)
                        .unwrap_or_else(|| c.text().unwrap_or("").trim().to_string())
                } else {
                    c.descendants()
                        .filter(|d| d.is_text())
                        .map(|d| d.text().unwrap_or(""))
                        .collect::<String>()
                        .trim()
                        .to_string()
                }
            })
            .unwrap_or_default()
    };
    let channel = root
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "channel")
        .unwrap_or(root);
    let items: Vec<Json> = root
        .descendants()
        .filter(|n| n.is_element() && matches!(n.tag_name().name(), "item" | "entry"))
        .map(|n| {
            let date = [
                child_text(n, "pubDate"),
                child_text(n, "updated"),
                child_text(n, "published"),
            ]
            .into_iter()
            .find(|d| !d.is_empty())
            .unwrap_or_default();
            let description = [
                child_text(n, "description"),
                child_text(n, "summary"),
                child_text(n, "content"),
            ]
            .into_iter()
            .find(|d| !d.is_empty())
            .unwrap_or_default();
            serde_json::json!({
                "title": child_text(n, "title"),
                "description": strip_tags(&description),
                "link": child_text(n, "link"),
                "date": date,
            })
        })
        .collect();
    if items.is_empty() && !matches!(root.tag_name().name(), "rss" | "feed" | "RDF") {
        return Err("not an RSS or Atom feed".into());
    }
    Ok(serde_json::json!({ "title": child_text(channel, "title"), "items": items }))
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut tag = false;
    for c in s.chars() {
        match c {
            '<' => tag = true,
            '>' => tag = false,
            c if !tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

/// Any XML → JSON: `{root: {child: …}}`; repeated children become arrays,
/// attributes `@name`, text of elements with attributes or children `#text`.
pub fn xml_json(text: &str) -> Result<Json, String> {
    let doc = roxmltree::Document::parse(text).map_err(|e| format!("not XML: {e}"))?;
    fn conv(n: roxmltree::Node) -> Json {
        let mut o = Map::new();
        for a in n.attributes() {
            o.insert(
                format!("@{}", a.name()),
                Json::String(a.value().to_string()),
            );
        }
        let mut kids: Vec<(String, Json)> = Vec::new();
        for c in n.children().filter(|c| c.is_element()) {
            kids.push((c.tag_name().name().to_string(), conv(c)));
        }
        let text: String = n
            .children()
            .filter(|c| c.is_text())
            .map(|c| c.text().unwrap_or(""))
            .collect::<String>()
            .trim()
            .to_string();
        if kids.is_empty() && o.is_empty() {
            return Json::String(text);
        }
        for (k, v) in kids {
            match o.get_mut(&k) {
                Some(Json::Array(a)) => a.push(v),
                Some(prev) => {
                    let p = prev.take();
                    *prev = Json::Array(vec![p, v]);
                }
                None => {
                    o.insert(k, v);
                }
            }
        }
        if !text.is_empty() {
            o.insert("#text".into(), Json::String(text));
        }
        Json::Object(o)
    }
    let root = doc.root_element();
    let mut o = Map::new();
    o.insert(root.tag_name().name().to_string(), conv(root));
    Ok(Json::Object(o))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_core::datapath::lookup;

    #[test]
    fn csv() {
        let v = csv_json(
            "\u{feff}name;role\n\"Doe, Jane\";Host\nJohn \"J\";\"Guest\n(remote)\"\n\n",
            true,
        );
        let d = cg_core::Data::new();
        assert_eq!(lookup(&v, "rows[0].name", &d).as_deref(), Some("Doe, Jane"));
        assert_eq!(
            lookup(&v, "rows[1].role", &d).as_deref(),
            Some("Guest\n(remote)")
        );
        assert_eq!(
            lookup(&v, "rows[name=Doe, Jane].role", &d).as_deref(),
            Some("Host")
        );
        assert_eq!(lookup(&v, "rows.length", &d).as_deref(), Some("2"));
        assert_eq!(
            lookup(&csv_json("a,b\n1,2", false), "rows[1][1]", &d).as_deref(),
            Some("2")
        );
    }

    #[test]
    fn feeds_and_xml() {
        let rss = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
            <item><title>First</title><description><![CDATA[<p>Hello &amp; welcome</p>]]></description><link>https://a</link></item>
            <item><title>Second</title></item></channel></rss>"#;
        let v = rss_json(rss).unwrap();
        let d = cg_core::Data::new();
        assert_eq!(
            lookup(&v, "items[*].title", &d).as_deref(),
            Some("First\nSecond")
        );
        assert_eq!(
            lookup(&v, "items[0].description", &d).as_deref(),
            Some("Hello & welcome")
        );
        let atom = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>E1</title><link href="https://e"/></entry></feed>"#;
        assert_eq!(
            lookup(&rss_json(atom).unwrap(), "items[0].link", &d).as_deref(),
            Some("https://e")
        );

        let xml = r#"<match minute="67"><team side="home"><name>PSG</name><score>2</score></team><team side="away"><name>OM</name><score>1</score></team></match>"#;
        let v = xml_json(xml).unwrap();
        assert_eq!(lookup(&v, "match.@minute", &d).as_deref(), Some("67"));
        assert_eq!(
            lookup(&v, "match.team[@side=away].score", &d).as_deref(),
            Some("1")
        );
        assert_eq!(lookup(&v, "match.team[0].name", &d).as_deref(), Some("PSG"));
    }

    #[test]
    fn google_sheets_links() {
        assert_eq!(
            google_sheet_csv("https://docs.google.com/spreadsheets/d/AbC123/edit#gid=42")
                .as_deref(),
            Some("https://docs.google.com/spreadsheets/d/AbC123/export?format=csv&gid=42")
        );
        assert_eq!(
            google_sheet_csv("https://docs.google.com/spreadsheets/d/e/2PACX/pub?output=csv"),
            None
        );
        assert_eq!(google_sheet_csv("https://example.com/a.csv"), None);
    }
}
