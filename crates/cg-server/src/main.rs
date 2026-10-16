mod api;
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

use axum::routing::get;
use clap::{Args, Parser, Subcommand};
use tokio::sync::{broadcast, RwLock};
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
    /// Address to listen on.
    #[arg(long, env = "CG_BIND", default_value = "0.0.0.0:8080")]
    bind: SocketAddr,
    /// Directory holding project.json, outputs.json and assets/
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

pub async fn serve(
    args: RunArgs,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let data_dir = args.data_dir.unwrap_or_else(paths::user_data_dir);
    std::fs::create_dir_all(data_dir.join("assets"))?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), data_dir = %data_dir.display(), "starting Pulse CG");

    let project = state::load_project(&data_dir);
    let outputs = state::load_outputs(&data_dir);
    let (events, _) = broadcast::channel(256);
    let renderer = cg_render::Renderer::new(data_dir.join("assets"));
    let shared: Shared = Arc::new(AppState {
        data_dir: data_dir.clone(),
        project: RwLock::new(Arc::new(project)),
        channel: RwLock::new(Default::default()),
        events,
        renderer: Mutex::new(renderer),
        outputs,
    });

    tokio::spawn(engine::run(shared.clone()));

    let app = api::router()
        .route("/fonts/{name}", get(web::font))
        .nest_service("/assets", ServeDir::new(data_dir.join("assets")));
    let app = match args.web_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
        }
        None => app.fallback(web::embedded),
    };
    let app = app.layer(CorsLayer::permissive()).with_state(shared);

    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    tracing::info!(
        "listening on http://{} — designer: /designer, operator: /operator, HTML5 output: /output",
        args.bind
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    tracing::info!("stopped");
    Ok(())
}
