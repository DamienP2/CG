mod api;
mod config;
mod engine;
mod paths;
mod service;
mod state;
mod web;

use std::future::Future;
use std::io::IsTerminal;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use axum::routing::get;
use clap::{Args, Parser, Subcommand};
use tokio::sync::{broadcast, watch, Notify, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::{AppState, Shared};

#[derive(Parser, Debug)]
#[command(
    name = "cg-server",
    version,
    about = "Pulse CG — broadcast character generator server",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,
    #[command(flatten)]
    run: RunArgs,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Run the server in the foreground (default).
    Run(RunArgs),
    /// Manage the background service (systemd, launchd or Windows service).
    #[command(subcommand)]
    Service(ServiceCmd),
}

#[derive(Args, Debug, Clone)]
pub struct RunArgs {
    /// Address to listen on, overriding the saved settings for this run
    /// (services use the settings page instead).
    #[arg(long, env = "CG_BIND")]
    bind: Option<SocketAddr>,
    /// Address used when the saved settings do not set one (installers).
    #[arg(long, hide = true)]
    default_bind: Option<SocketAddr>,
    /// Directory holding project.json, config.json and assets/
    /// [default: per-user application data directory].
    #[arg(long, env = "CG_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Serve the web app from this folder instead of the embedded copy
    /// (useful while developing the UI).
    #[arg(long, env = "CG_WEB_DIR")]
    web_dir: Option<PathBuf>,
    /// Started by the Windows Service Control Manager.
    #[arg(long, hide = true)]
    service: bool,
}

#[derive(Subcommand, Debug)]
enum ServiceCmd {
    /// Register this executable as a system service and start it.
    Install {
        #[arg(long, default_value = "0.0.0.0:8080")]
        bind: SocketAddr,
        /// [default: /var/lib/pulse-cg, /Library/Application Support/PulseCG
        /// or %ProgramData%\PulseCG]
        #[arg(long)]
        data_dir: Option<PathBuf>,
    },
    /// Stop and remove the service (data is kept).
    Uninstall,
    Start,
    Stop,
    Status,
}

fn init_logging(log_file: Option<PathBuf>) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,tower_http=warn".into());
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    let file = log_file.and_then(|p| {
        std::fs::create_dir_all(p.parent()?).ok()?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .ok()
    });
    match file {
        Some(f) => builder.with_ansi(false).with_writer(Mutex::new(f)).init(),
        None => builder.with_ansi(std::io::stdout().is_terminal()).init(),
    }
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Cmd::Service(cmd)) => {
            let result = match cmd {
                ServiceCmd::Install { bind, data_dir } => {
                    let data_dir = data_dir.unwrap_or_else(paths::system_data_dir);
                    service::install(&service::InstallOptions {
                        bind,
                        data_dir: data_dir.clone(),
                    })
                    .map(|()| {
                        println!("Service `{}` installed and started.", paths::SERVICE_NAME);
                        println!("  Data:  {}", data_dir.display());
                        println!("  Open:  http://localhost:{}/designer", bind.port());
                    })
                }
                ServiceCmd::Uninstall => {
                    service::uninstall().map(|()| println!("Service removed (data kept)."))
                }
                ServiceCmd::Start => service::start(),
                ServiceCmd::Stop => service::stop(),
                ServiceCmd::Status => service::status(),
            };
            if let Err(e) = result {
                eprintln!("error: {e:#}");
                std::process::exit(1);
            }
            Ok(())
        }
        Some(Cmd::Run(args)) => run(args),
        None => run(cli.run),
    }
}

fn run(args: RunArgs) -> anyhow::Result<()> {
    if args.service {
        // Windows services have no console: log next to the data.
        let data = args.data_dir.clone().unwrap_or_else(paths::system_data_dir);
        init_logging(Some(data.join("logs").join("cg-server.log")));
        #[cfg(windows)]
        return service::windows_runtime::run(args);
        #[cfg(not(windows))]
        anyhow::bail!("--service is only meaningful on Windows");
    }
    init_logging(None);
    tokio::runtime::Runtime::new()?.block_on(serve(args, shutdown_signal()))
}

/// Ctrl-C everywhere, plus SIGTERM on Unix (systemd / launchd stop).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await;
}

pub const DEFAULT_BIND: &str = "0.0.0.0:8080";

pub async fn serve(
    args: RunArgs,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let data_dir = args.data_dir.clone().unwrap_or_else(paths::user_data_dir);
    std::fs::create_dir_all(data_dir.join("assets"))?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), data_dir = %data_dir.display(), "starting Pulse CG");

    let (stop_tx, stop_rx) = watch::channel(false);
    tokio::spawn(async move {
        shutdown.await;
        let _ = stop_tx.send(true);
    });
    let started_at = SystemTime::now();
    let fallback: SocketAddr = DEFAULT_BIND.parse()?;

    // Each iteration is one engine "cycle"; settings changes end the cycle
    // and the loop rebuilds everything with the new configuration.
    loop {
        let config = config::ServerConfig::load(&data_dir);
        let wanted = args
            .bind
            .or(config.bind)
            .or(args.default_bind)
            .unwrap_or(fallback);
        let listener = match tokio::net::TcpListener::bind(wanted).await {
            Ok(l) => l,
            // Keep the UI reachable so the setting can be fixed.
            Err(e) if wanted != fallback => {
                tracing::error!("cannot listen on {wanted} ({e}); falling back to {fallback}");
                tokio::net::TcpListener::bind(fallback).await?
            }
            Err(e) => return Err(e.into()),
        };
        let bind = listener.local_addr()?;
        // Lets the desktop app find the server without parsing settings.
        let runtime = serde_json::json!({ "bind": bind, "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() });
        if let Err(e) = std::fs::write(data_dir.join("runtime.json"), runtime.to_string()) {
            tracing::warn!("cannot write runtime.json: {e}");
        }

        let (events, _) = broadcast::channel(256);
        let (closing, _) = watch::channel(false);
        let shared: Shared = Arc::new(AppState {
            data_dir: data_dir.clone(),
            project: RwLock::new(Arc::new(state::load_project(&data_dir))),
            channel: RwLock::new(Default::default()),
            events,
            renderer: Mutex::new(cg_render::Renderer::new(data_dir.join("assets"))),
            config,
            bind,
            started_at,
            restart: Notify::new(),
            closing,
        });
        let engine = tokio::spawn(engine::run(shared.clone()));

        let app = api::router()
            .route("/fonts/{name}", get(web::font))
            .nest_service("/assets", ServeDir::new(data_dir.join("assets")));
        let app = match &args.web_dir {
            Some(dir) => {
                let index = dir.join("index.html");
                app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
            }
            None => app.fallback(web::embedded),
        };
        let app = app
            .layer(CorsLayer::permissive())
            .with_state(shared.clone());

        tracing::info!("listening on http://{bind} — designer: /designer, operator: /operator, settings: /settings, HTML5 output: /output");
        let stop = state::until_true(stop_rx.clone());
        let cycle = shared.clone();
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                tokio::select! {
                    _ = stop => {}
                    _ = cycle.restart.notified() => {}
                }
                let _ = cycle.closing.send(true);
            })
            .await?;
        engine.abort();
        let _ = engine.await;
        if *stop_rx.borrow() {
            break;
        }
        tracing::info!("restarting the engine with the new settings");
    }
    tracing::info!("stopped");
    Ok(())
}
