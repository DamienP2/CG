//! Shared helpers of the end-to-end tests: the real `strata-server` binary
//! started on a fresh data folder and a free port, and HTTP clients that act
//! like the web app of one browser (their own cookies, the same headers).

#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Every account of the tests has this password (8+ characters).
pub const PASSWORD: &str = "correct-horse-1";

/// The name a remote browser reaches the server by (another PC of the
/// network): not the server's own machine, so nothing reserved to it.
pub const REMOTE_HOST: &str = "studio.test";

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A fresh folder under the system temp directory (removed on drop).
fn fresh_dir(what: &str) -> PathBuf {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "strata-e2e-{what}-{}-{n}-{nanos}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("free port")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The server process; killed, and its folder removed, on drop.
pub struct Server {
    child: Child,
    pub port: u16,
    root: PathBuf,
    pub data: PathBuf,
    log: PathBuf,
}

impl Server {
    /// Starts the binary on a new data folder and waits until it answers.
    pub fn start() -> Server {
        let root = fresh_dir("srv");
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        // Hermetic: no look for updates, nor for picture libraries online.
        std::fs::create_dir_all(data.join("update")).unwrap();
        std::fs::write(
            data.join("update").join("settings.json"),
            r#"{"autoCheck": false}"#,
        )
        .unwrap();
        std::fs::create_dir_all(data.join("iconlib")).unwrap();
        std::fs::write(
            data.join("iconlib").join("state.json"),
            json!({ "lastCheck": now_ms() }).to_string(),
        )
        .unwrap();
        let log = root.join("server.log");
        let mut last_err = String::new();
        for _ in 0..5 {
            let port = free_port();
            let out = std::fs::File::create(&log).unwrap();
            let child = Command::new(env!("CARGO_BIN_EXE_strata-server"))
                .arg("--data-dir")
                .arg(&data)
                .arg("--bind")
                .arg(format!("127.0.0.1:{port}"))
                .env("RUST_LOG", "warn")
                // Never the internet: the picture libraries' update check
                // finds a closed local port (an answer at once, every run).
                .env("STRATA_NPM_REGISTRY", "http://127.0.0.1:9")
                .env_remove("CG_BIND")
                .env_remove("CG_DATA_DIR")
                .env_remove("CG_WEB_DIR")
                .stdin(Stdio::null())
                .stdout(out.try_clone().unwrap())
                .stderr(out)
                .spawn()
                .expect("start strata-server");
            let mut s = Server {
                child,
                port,
                root: root.clone(),
                data: data.clone(),
                log: log.clone(),
            };
            match s.wait_ready(Duration::from_secs(60)) {
                Ok(()) => return s,
                Err(e) => {
                    last_err = e;
                    let _ = s.child.kill();
                    let _ = s.child.wait();
                    // Not dropped: the folder is kept for the next try.
                    std::mem::forget(s);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        panic!("the server did not start: {last_err}");
    }

    fn wait_ready(&mut self, limit: Duration) -> Result<(), String> {
        let started = Instant::now();
        let probe = self.local();
        loop {
            if let Ok(Some(st)) = self.child.try_wait() {
                return Err(format!("exited with {st}: {}", self.log_tail()));
            }
            if let Some(r) = probe.try_request("GET", "/api/health", None, &[]) {
                if r.status == 200 {
                    return Ok(());
                }
            }
            if started.elapsed() > limit {
                return Err(format!("no answer after {limit:?}: {}", self.log_tail()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn log_tail(&self) -> String {
        let text = std::fs::read_to_string(&self.log).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(40)..].join("\n")
    }

    /// A browser on the server itself (http://127.0.0.1).
    pub fn local(&self) -> Client {
        Client::new(self.port, format!("127.0.0.1:{}", self.port), "local")
    }

    /// A browser on another computer of the network.
    pub fn remote(&self, name: &str) -> Client {
        Client::new(self.port, format!("{REMOTE_HOST}:{}", self.port), name)
    }

    /// A browser reaching the server (from its own machine) by `name`.
    pub fn with_host(&self, name: &str, who: &str) -> Client {
        Client::new(self.port, format!("{name}:{}", self.port), who)
    }

    /// Creates the first admin from the server itself; signed in.
    pub fn setup_admin(&self, username: &str) -> Client {
        let c = self.local();
        let r = c.post(
            "/api/auth/setup",
            json!({ "username": username, "password": PASSWORD }),
        );
        r.expect(200, "first admin");
        c.set_user(username);
        c
    }

    /// The admin, the server set up, signed in from a remote browser.
    pub fn with_admin(&self) -> (Client, Value) {
        self.setup_admin("admin").logout();
        let admin = self.remote("admin");
        let me = admin
            .login("admin", PASSWORD)
            .expect(200, "admin login")
            .json();
        (admin, me["user"].clone())
    }

    /// The folder holding the data (config.json, users.json…).
    pub fn data_dir(&self) -> &Path {
        &self.data
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if std::thread::panicking() {
            eprintln!(
                "---- server log (port {}) ----\n{}",
                self.port,
                self.log_tail()
            );
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// An answer: status, headers and body.
#[derive(Debug, Clone)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// What was asked (for messages).
    pub what: String,
}

impl Resp {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| {
            panic!(
                "{}: not JSON ({e}): {} {}",
                self.what,
                self.status,
                self.text()
            )
        })
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Asserts the status; returns self for chaining.
    #[track_caller]
    pub fn expect(&self, status: u16, why: &str) -> &Self {
        assert_eq!(
            self.status,
            status,
            "{why}: {} answered {} {}",
            self.what,
            self.status,
            self.text()
        );
        self
    }

    #[track_caller]
    pub fn expect_ok(&self, why: &str) -> &Self {
        assert!(
            self.is_success(),
            "{why}: {} answered {} {}",
            self.what,
            self.status,
            self.text()
        );
        self
    }
}

/// One browser (or one automation): its cookies, the web app's headers.
pub struct Client {
    agent: ureq::Agent,
    port: u16,
    host: String,
    /// What the web app sends with each call (`X-Strata-Client`: the
    /// designer tab; empty: not sent, as automation does).
    pub client_id: String,
    cookies: RefCell<BTreeMap<String, String>>,
    bearer: RefCell<Option<String>>,
    /// Who is signed in (for messages).
    user: RefCell<String>,
    origin: RefCell<Option<String>>,
}

impl Client {
    fn new(port: u16, host: String, name: &str) -> Client {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .proxy(None)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(180)))
            .build()
            .into();
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        Client {
            agent,
            port,
            origin: RefCell::new(Some(format!("http://{host}"))),
            host,
            client_id: format!("tab-{name}-{n}"),
            cookies: RefCell::new(BTreeMap::new()),
            bearer: RefCell::new(None),
            user: RefCell::new(name.to_string()),
        }
    }

    /// An automation: no browser headers, an API key.
    pub fn with_key(&self, secret: &str) -> Client {
        let mut c = Client::new(self.port, self.host.clone(), "api-key");
        c.client_id = String::new();
        *c.origin.borrow_mut() = None;
        *c.bearer.borrow_mut() = Some(secret.to_string());
        c
    }

    /// Another tab of this browser: the same cookies, its own tab id.
    pub fn new_tab(&self) -> Client {
        let c = Client::new(self.port, self.host.clone(), &self.user.borrow());
        *c.cookies.borrow_mut() = self.cookies.borrow().clone();
        *c.origin.borrow_mut() = self.origin.borrow().clone();
        c
    }

    pub fn set_user(&self, name: &str) {
        *self.user.borrow_mut() = name.to_string();
    }

    /// The page the requests come from (`None`: not a browser).
    pub fn set_origin(&self, origin: Option<&str>) {
        *self.origin.borrow_mut() = origin.map(str::to_string);
    }

    pub fn cookie(&self, name: &str) -> Option<String> {
        self.cookies.borrow().get(name).cloned()
    }

    pub fn set_cookie(&self, name: &str, value: &str) {
        self.cookies
            .borrow_mut()
            .insert(name.to_string(), value.to_string());
    }

    pub fn forget_cookie(&self, name: &str) {
        self.cookies.borrow_mut().remove(name);
    }

    fn keep_cookies(&self, headers: &[(String, String)]) {
        for (k, v) in headers {
            if !k.eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            let first = v.split(';').next().unwrap_or("");
            let Some((name, value)) = first.trim().split_once('=') else {
                continue;
            };
            let gone = value.is_empty()
                || v.split(';')
                    .any(|a| a.trim().eq_ignore_ascii_case("max-age=0"));
            let mut jar = self.cookies.borrow_mut();
            if gone {
                jar.remove(name);
            } else {
                jar.insert(name.to_string(), value.to_string());
            }
        }
    }

    /// One request; `None` when the server cannot be reached.
    pub fn try_request(
        &self,
        method: &str,
        path: &str,
        body: Option<(&[u8], &str)>,
        extra: &[(&str, &str)],
    ) -> Option<Resp> {
        let url = format!("http://127.0.0.1:{}{path}", self.port);
        let mut b = ureq::http::Request::builder()
            .method(method)
            .uri(&url)
            .header("Host", &self.host)
            .header("Accept", "application/json");
        if !self.client_id.is_empty() {
            b = b.header("X-Strata-Client", &self.client_id);
        }
        if let Some(o) = self.origin.borrow().as_deref() {
            b = b.header("Origin", o);
        }
        let jar = self.cookies.borrow();
        if !jar.is_empty() {
            let c: Vec<String> = jar.iter().map(|(k, v)| format!("{k}={v}")).collect();
            b = b.header("Cookie", c.join("; "));
        }
        drop(jar);
        if let Some(t) = self.bearer.borrow().as_deref() {
            b = b.header("Authorization", format!("Bearer {t}"));
        }
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        let res = match body {
            Some((bytes, kind)) => {
                let req = b.header("Content-Type", kind).body(bytes.to_vec()).ok()?;
                self.agent.run(req)
            }
            None => {
                let req = b.body(()).ok()?;
                self.agent.run(req)
            }
        };
        let mut res = res.ok()?;
        let status = res.status().as_u16();
        let headers: Vec<(String, String)> = res
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let mut body = Vec::new();
        let _ = res
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .reader()
            .read_to_end(&mut body);
        self.keep_cookies(&headers);
        Some(Resp {
            status,
            headers,
            body,
            what: format!("{method} {path} (as {})", self.user.borrow()),
        })
    }

    #[track_caller]
    pub fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Resp {
        let bytes = body.map(|v| serde_json::to_vec(v).unwrap());
        self.try_request(
            method,
            path,
            bytes.as_deref().map(|b| (b, "application/json")),
            &[],
        )
        .unwrap_or_else(|| panic!("{method} {path}: the server did not answer"))
    }

    #[track_caller]
    pub fn raw(&self, method: &str, path: &str, bytes: &[u8], kind: &str) -> Resp {
        self.try_request(method, path, Some((bytes, kind)), &[])
            .unwrap_or_else(|| panic!("{method} {path}: the server did not answer"))
    }

    #[track_caller]
    pub fn get(&self, path: &str) -> Resp {
        self.request("GET", path, None)
    }
    #[track_caller]
    pub fn post(&self, path: &str, body: Value) -> Resp {
        self.request("POST", path, Some(&body))
    }
    #[track_caller]
    pub fn post_empty(&self, path: &str) -> Resp {
        self.request("POST", path, None)
    }
    #[track_caller]
    pub fn put(&self, path: &str, body: Value) -> Resp {
        self.request("PUT", path, Some(&body))
    }
    #[track_caller]
    pub fn patch(&self, path: &str, body: Value) -> Resp {
        self.request("PATCH", path, Some(&body))
    }
    #[track_caller]
    pub fn delete(&self, path: &str) -> Resp {
        self.request("DELETE", path, None)
    }

    /// GET that must succeed, as JSON.
    #[track_caller]
    pub fn get_json(&self, path: &str) -> Value {
        let r = self.get(path);
        r.expect(200, "read");
        r.json()
    }

    #[track_caller]
    pub fn login(&self, username: &str, password: &str) -> Resp {
        let r = self.post(
            "/api/auth/login",
            json!({ "username": username, "password": password }),
        );
        if r.status == 200 {
            self.set_user(username);
        }
        r
    }

    #[track_caller]
    pub fn logout(&self) -> Resp {
        let r = self.post_empty("/api/auth/logout");
        r.expect(204, "logout");
        r
    }

    /// Who the server says is signed in here.
    pub fn whoami(&self) -> Option<String> {
        let st = self.get_json("/api/auth/state");
        st["user"]["username"].as_str().map(str::to_string)
    }
}

/// Creates a user (as an admin) and returns its public record.
#[track_caller]
pub fn create_user(admin: &Client, username: &str, role: &str, extra: Value) -> Value {
    let mut body = json!({ "username": username, "password": PASSWORD, "role": role });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    let r = admin.post("/api/users", body);
    r.expect(200, "create user");
    r.json()
}

/// A remote browser signed in as `username`.
#[track_caller]
pub fn browser(server: &Server, username: &str) -> Client {
    let c = server.remote(username);
    c.login(username, PASSWORD).expect(200, "login");
    c
}

/// Creates a project (as a designer or admin); its id.
#[track_caller]
pub fn create_project(c: &Client, name: &str) -> String {
    let r = c.post("/api/projects", json!({ "name": name }));
    r.expect(200, "create project");
    r.json()["id"].as_str().unwrap().to_string()
}

/// Polls `f` until it returns `Some`, or panics after `limit`.
#[track_caller]
pub fn eventually<T>(limit: Duration, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let started = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        if started.elapsed() > limit {
            panic!("timed out waiting for {what}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The first published template of a project.
pub fn first_template(project: &Value) -> Value {
    project["templates"][0].clone()
}

/// The roles, in the order of the matrices: the refused ones first, so
/// what an allowed role does (a delete…) cannot hide a wrong refusal.
pub const ROLES: [&str; 4] = ["viewer", "operator", "designer", "admin"];

/// A template with something to show: a box and a name field.
pub fn content_template(id: &str, name: &str, zone: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "duration": 50.0,
        "markers": [{ "id": format!("{id}-air"), "frame": 25.0, "name": "On air", "kind": "out" }],
        "fields": [{ "key": "name", "label": "Name", "kind": "text", "default": "Jane Doe" }],
        "zone": zone,
        "layers": [
            {
                "id": format!("{id}-box"), "name": "Box", "parent": null, "type": "rect",
                "visible": true, "locked": false,
                "props": { "x": 100.0, "y": 800.0, "width": 800.0, "height": 120.0, "fill": [1.0, 1.0, 1.0, 1.0] },
                "tracks": {}, "bindings": {}, "clip": false
            },
            {
                "id": format!("{id}-txt"), "name": "Name", "parent": null, "type": "text",
                "visible": true, "locked": false,
                "props": { "x": 120.0, "y": 800.0, "width": 760.0, "height": 120.0, "fill": [0.0, 0.0, 0.0, 1.0], "fontSize": 48.0 },
                "tracks": {}, "bindings": {}, "clip": false,
                "text": "{{name}}", "fontFamily": "Inter", "fontWeight": 700,
                "align": "left", "verticalAlign": "middle", "uppercase": false
            }
        ]
    })
}

/// A show ready to play: a project whose first template has content
/// (published) and a rundown of one graphic in the shared playlist.
pub struct Show {
    pub project: String,
    pub template: String,
    pub zone: String,
    pub item: String,
}

/// Makes a [`Show`] (as a designer or admin).
#[track_caller]
pub fn make_show(c: &Client, name: &str) -> Show {
    let project = create_project(c, name);
    let p = c.get_json(&format!("/api/projects/{project}"));
    let template = p["templates"][0]["id"].as_str().unwrap().to_string();
    let zone = p["zones"][0]["id"].as_str().unwrap().to_string();
    c.put(
        &format!("/api/projects/{project}/templates/{template}?publish=true"),
        content_template(&template, "Lower third", &zone),
    )
    .expect(204, "template with content");
    let item = format!("it{}", NEXT.fetch_add(1, Ordering::Relaxed));
    c.put(
        &format!("/api/projects/{project}/rundown"),
        json!([{ "id": item, "name": "Guest", "templateId": template, "playlist": "main",
                 "data": { "name": "Alice Martin" } }]),
    )
    .expect(204, "rundown");
    Show {
        project,
        template,
        zone,
        item,
    }
}

/// Makes this browser a production station (as an admin): its id and secret.
#[track_caller]
pub fn declare_station(admin: &Client, name: &str) -> (String, String) {
    let r = admin.post("/api/stations", json!({ "name": name }));
    r.expect(200, "declare station");
    let id = r.json()["id"].as_str().unwrap().to_string();
    let secret = admin.cookie("cg_station").expect("station cookie");
    (id, secret)
}

/// The graphics on air of a channel state (zone layer, item).
pub fn on_air(state: &Value) -> Vec<(String, Value)> {
    state["layers"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Everyone of a test: a server, its admin, a user of each other role
/// (each signed in on their own remote browser) and a show.
pub struct World {
    pub server: Server,
    pub admin: Client,
    pub designer: Client,
    pub operator: Client,
    pub viewer: Client,
    /// User ids by role.
    pub ids: BTreeMap<&'static str, String>,
    pub show: Show,
    n: std::cell::Cell<u32>,
}

impl World {
    pub fn new() -> World {
        let server = Server::start();
        let (admin, me) = server.with_admin();
        let mut ids = BTreeMap::new();
        ids.insert("admin", me["id"].as_str().unwrap().to_string());
        for role in ["designer", "operator", "viewer"] {
            let u = create_user(&admin, role, role, json!({}));
            ids.insert(role, u["id"].as_str().unwrap().to_string());
        }
        let designer = browser(&server, "designer");
        let operator = browser(&server, "operator");
        let viewer = browser(&server, "viewer");
        let show = make_show(&admin, "Evening news");
        World {
            server,
            admin,
            designer,
            operator,
            viewer,
            ids,
            show,
            n: std::cell::Cell::new(0),
        }
    }

    pub fn client(&self, role: &str) -> &Client {
        match role {
            "admin" => &self.admin,
            "designer" => &self.designer,
            "operator" => &self.operator,
            "viewer" => &self.viewer,
            _ => panic!("no role {role}"),
        }
    }

    pub fn id(&self, role: &str) -> &str {
        &self.ids[role]
    }

    /// A name never used before in this world.
    pub fn unique(&self, prefix: &str) -> String {
        let n = self.n.get() + 1;
        self.n.set(n);
        format!("{prefix}{n}")
    }
}

/// Runs `f` with this browser on the production station of `secret`.
pub fn at_station<T>(c: &Client, secret: &str, f: impl FnOnce() -> T) -> T {
    let before = c.cookie("cg_station");
    c.set_cookie("cg_station", secret);
    let out = f();
    match before {
        Some(b) => c.set_cookie("cg_station", &b),
        None => c.forget_cookie("cg_station"),
    }
    out
}

/// Runs `f` with this browser off any production station.
pub fn off_station<T>(c: &Client, f: impl FnOnce() -> T) -> T {
    let before = c.cookie("cg_station");
    c.forget_cookie("cg_station");
    let out = f();
    match before {
        Some(b) => c.set_cookie("cg_station", &b),
        None => c.forget_cookie("cg_station"),
    }
    out
}

/// One row of a route × role matrix: who may, and the call as one role
/// (preparing what it needs as the admin first).
pub struct Row {
    pub route: &'static str,
    pub allowed: &'static [&'static str],
    /// The allowed roles are not called (the action would stop the server,
    /// reach the Internet…): only the refusals are checked.
    pub refusals_only: bool,
    pub call: fn(&World, &Client, &str) -> Resp,
}

pub fn row(
    route: &'static str,
    allowed: &'static [&'static str],
    call: fn(&World, &Client, &str) -> Resp,
) -> Row {
    Row {
        route,
        allowed,
        refusals_only: false,
        call,
    }
}

pub fn refusals(
    route: &'static str,
    allowed: &'static [&'static str],
    call: fn(&World, &Client, &str) -> Resp,
) -> Row {
    Row {
        route,
        allowed,
        refusals_only: true,
        call,
    }
}

pub const ADMIN: &[&str] = &["admin"];
pub const DESIGN: &[&str] = &["admin", "designer"];
pub const OPERATE: &[&str] = &["admin", "designer", "operator"];
pub const EVERYONE: &[&str] = &["admin", "designer", "operator", "viewer"];

/// Runs every row as every role: an allowed role gets a 2xx, the others a
/// 403. All the mismatches are reported together, with the whole table.
pub fn run_matrix(w: &World, rows: &[Row]) {
    run_matrix_with(w, rows, |_| {})
}

/// [`run_matrix`], with `before` run ahead of each call.
pub fn run_matrix_with(w: &World, rows: &[Row], before: fn(&World)) {
    let mut table = String::new();
    let mut wrong = Vec::new();
    for r in rows {
        let mut cells = Vec::new();
        for role in ROLES {
            let allowed = r.allowed.contains(&role);
            if allowed && r.refusals_only {
                cells.push(format!("{role}:(skip)"));
                continue;
            }
            before(w);
            let res = (r.call)(w, w.client(role), role);
            let ok = if allowed {
                res.is_success()
            } else {
                res.status == 403
            };
            cells.push(format!("{role}:{}", res.status));
            if !ok {
                wrong.push(format!(
                    "{} as {role}: expected {}, got {} {}",
                    r.route,
                    if allowed { "2xx" } else { "403" },
                    res.status,
                    res.text().chars().take(200).collect::<String>()
                ));
            }
        }
        table.push_str(&format!("{:<58} {}\n", r.route, cells.join(" ")));
    }
    eprintln!("{table}");
    assert!(wrong.is_empty(), "\n{}\n\n{table}", wrong.join("\n"));
}
