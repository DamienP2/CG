use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Loopback port used only as a single-instance lock.
const INSTANCE_LOCK: &str = "127.0.0.1:47819";
const DEFAULT_PORT: u16 = 8080;

#[derive(Debug, Clone, PartialEq)]
struct Status {
    running: bool,
    name: String,
    port: u16,
}

enum UserEvent {
    Menu(MenuEvent),
    Status(Status),
}

// ------------------------------------------------------------ locations ----

fn data_dir() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("PulseCG")
    } else {
        PathBuf::from("/Library/Application Support/PulseCG")
    }
}

fn server_exe() -> PathBuf {
    if cfg!(windows) {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("cg-server.exe")))
            .unwrap_or_else(|| PathBuf::from("cg-server.exe"))
    } else {
        PathBuf::from("/usr/local/pulse-cg/cg-server")
    }
}

fn port_from(json: &serde_json::Value, key: &str) -> Option<u16> {
    json.get(key)?.as_str()?.rsplit(':').next()?.parse().ok()
}

/// The server publishes its live address in `runtime.json`; the saved
/// settings are the fallback when it is not running.
fn discover_port() -> u16 {
    let read = |f: &str| {
        std::fs::read(data_dir().join(f))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    };
    read("runtime.json")
        .and_then(|j| port_from(&j, "bind"))
        .or_else(|| read("config.json").and_then(|j| port_from(&j, "bind")))
        .unwrap_or(DEFAULT_PORT)
}

fn base_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

// -------------------------------------------------------------- actions ----

fn open_url(url: &str) {
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(url).spawn();
    #[cfg(windows)]
    let r = Command::new("explorer.exe").arg(url).spawn();
    if let Err(e) = r {
        eprintln!("cannot open {url}: {e}");
    }
}

/// Runs `cg-server service <action>` with administrator rights.
fn service(action: &'static str) {
    let exe = server_exe();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        let r = {
            let cmd = format!("'{}' service {action}", exe.display());
            let script = format!(
                "do shell script \"{}\" with administrator privileges",
                cmd.replace('\\', "\\\\").replace('"', "\\\"")
            );
            Command::new("osascript").args(["-e", &script]).status()
        };
        #[cfg(windows)]
        let r = {
            let ps = format!(
                "Start-Process -Verb RunAs -WindowStyle Hidden -Wait -FilePath '{}' -ArgumentList 'service','{action}'",
                exe.display().to_string().replace('\'', "''")
            );
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            Command::new("powershell")
                .args(["-NoProfile", "-Command", &ps])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
        };
        if let Err(e) = r {
            eprintln!("service {action} failed: {e}");
        }
    });
}

fn restart_engine(port: u16) {
    std::thread::spawn(move || {
        let _ = agent()
            .post(format!("{}/api/system/restart", base_url(port)))
            .send_empty();
    });
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(1500)))
        .build()
        .into()
}

fn poll(proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let agent = agent();
        loop {
            let port = discover_port();
            let status = agent
                .get(format!("{}/api/system", base_url(port)))
                .call()
                .ok()
                .and_then(|mut r| r.body_mut().read_to_string().ok())
                .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
                .map(|j| Status {
                    running: true,
                    name: j
                        .pointer("/config/name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("Pulse CG")
                        .to_string(),
                    port: port_from(&j, "bind").unwrap_or(port),
                })
                .unwrap_or(Status {
                    running: false,
                    name: "Pulse CG".into(),
                    port,
                });
            if proxy.send_event(UserEvent::Status(status)).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

// ----------------------------------------------------------------- icon ----

fn icon() -> Icon {
    #[cfg(target_os = "macos")]
    let (rgba, size) = (
        include_bytes!("../../../assets/icons/tray-template-44.rgba").to_vec(),
        44,
    );
    #[cfg(windows)]
    let (rgba, size) = (
        include_bytes!("../../../assets/icons/tray-color-64.rgba").to_vec(),
        64,
    );
    Icon::from_rgba(rgba, size, size).expect("valid tray icon")
}

// ------------------------------------------------------------------ app ----

struct Items {
    status: MenuItem,
    designer: MenuItem,
    operator: MenuItem,
    settings: MenuItem,
    output: MenuItem,
    restart: MenuItem,
    start_stop: MenuItem,
    quit: MenuItem,
}

impl Items {
    fn new() -> (Menu, Self) {
        let items = Self {
            status: MenuItem::new("Pulse CG — checking…", false, None),
            designer: MenuItem::new("Open Designer", false, None),
            operator: MenuItem::new("Open Operator", false, None),
            settings: MenuItem::new("Server Settings…", false, None),
            output: MenuItem::new("Open HTML5 Output", false, None),
            restart: MenuItem::new("Restart Engine", false, None),
            start_stop: MenuItem::new("Start Server", true, None),
            quit: MenuItem::new("Quit Pulse CG", true, None),
        };
        let menu = Menu::new();
        let _ = menu.append_items(&[
            &items.status,
            &PredefinedMenuItem::separator(),
            &items.designer,
            &items.operator,
            &items.settings,
            &items.output,
            &PredefinedMenuItem::separator(),
            &items.restart,
            &items.start_stop,
            &PredefinedMenuItem::separator(),
            &MenuItem::new(format!("Version {VERSION}"), false, None),
            &items.quit,
        ]);
        (menu, items)
    }

    fn apply(&self, s: &Status, tray: Option<&TrayIcon>) {
        let label = if s.running {
            format!("● {} — running on port {}", s.name, s.port)
        } else {
            "○ Pulse CG server is stopped".to_string()
        };
        self.status.set_text(&label);
        for item in [
            &self.designer,
            &self.operator,
            &self.settings,
            &self.output,
            &self.restart,
        ] {
            item.set_enabled(s.running);
        }
        self.start_stop.set_text(if s.running {
            "Stop Server"
        } else {
            "Start Server"
        });
        if let Some(t) = tray {
            let _ = t.set_tooltip(Some(label));
        }
    }
}

pub fn run() {
    let background = std::env::args().any(|a| a == "--background");

    // Second launch (e.g. from the Applications folder while the menu bar
    // app already runs): just bring up the Designer.
    let Ok(_lock) = TcpListener::bind(INSTANCE_LOCK) else {
        open_url(&format!("{}/designer", base_url(discover_port())));
        return;
    };

    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        // Menu bar only: no Dock icon, no app switcher entry.
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let proxy = event_loop.create_proxy();
    let menu_proxy = proxy.clone();
    MenuEvent::set_event_handler(Some(move |e| {
        let _ = menu_proxy.send_event(UserEvent::Menu(e));
    }));

    let (menu, items) = Items::new();
    let mut menu = Some(menu);
    let mut tray: Option<TrayIcon> = None;
    let mut status = Status {
        running: false,
        name: "Pulse CG".into(),
        port: discover_port(),
    };
    let mut first_status = true;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // The tray must be created once the event loop runs (macOS).
            Event::NewEvents(StartCause::Init) => {
                // macOS draws a monochrome template that follows the menu bar theme.
                #[cfg(target_os = "macos")]
                let builder = TrayIconBuilder::new().with_icon_templated(icon());
                #[cfg(windows)]
                let builder = TrayIconBuilder::new().with_icon(icon());
                let mut builder = builder.with_tooltip("Pulse CG");
                if let Some(m) = menu.take() {
                    builder = builder.with_menu(Box::new(m));
                }
                match builder.build() {
                    Ok(t) => tray = Some(t),
                    Err(e) => {
                        eprintln!("cannot create the tray icon: {e}");
                        *control_flow = ControlFlow::Exit;
                    }
                }
                poll(proxy.clone());
            }
            Event::UserEvent(UserEvent::Status(s)) => {
                // Opened by the user (not at login): show the Designer once
                // the server answers.
                if first_status && !background && s.running {
                    open_url(&format!("{}/designer", base_url(s.port)));
                }
                first_status = false;
                if s != status {
                    items.apply(&s, tray.as_ref());
                    status = s;
                } else if tray.is_some() && items.status.text().contains("checking") {
                    items.apply(&s, tray.as_ref());
                }
            }
            Event::UserEvent(UserEvent::Menu(e)) => {
                let url = |path: &str| format!("{}/{path}", base_url(status.port));
                let id = e.id();
                if id == items.designer.id() {
                    open_url(&url("designer"));
                } else if id == items.operator.id() {
                    open_url(&url("operator"));
                } else if id == items.settings.id() {
                    open_url(&url("settings"));
                } else if id == items.output.id() {
                    open_url(&url("output"));
                } else if id == items.restart.id() {
                    restart_engine(status.port);
                } else if id == items.start_stop.id() {
                    service(if status.running { "stop" } else { "start" });
                } else if id == items.quit.id() {
                    tray.take();
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}
