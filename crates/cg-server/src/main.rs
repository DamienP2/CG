mod api;
mod engine;
mod state;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use clap::Parser;
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::{AppState, Shared};

#[derive(Parser, Debug)]
#[command(name = "cg-server", about = "Broadcast character generator server")]
struct Args {
    /// Address to listen on.
    #[arg(long, env = "CG_BIND", default_value = "0.0.0.0:8080")]
    bind: SocketAddr,
    /// Directory holding project.json, outputs.json and assets/.
    #[arg(long, env = "CG_DATA_DIR", default_value = "data")]
    data_dir: PathBuf,
    /// Built web app (web/dist).
    #[arg(long, env = "CG_WEB_DIR", default_value = "web/dist")]
    web_dir: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();
    let args = Args::parse();
    std::fs::create_dir_all(args.data_dir.join("assets"))?;

    let project = state::load_project(&args.data_dir);
    let outputs = state::load_outputs(&args.data_dir);
    let (events, _) = broadcast::channel(256);
    let renderer = cg_render::Renderer::new(args.data_dir.join("assets"));
    let shared: Shared = Arc::new(AppState {
        data_dir: args.data_dir.clone(),
        project: RwLock::new(Arc::new(project)),
        channel: RwLock::new(Default::default()),
        events,
        renderer: Mutex::new(renderer),
        outputs,
    });

    tokio::spawn(engine::run(shared.clone()));

    let index = args.web_dir.join("index.html");
    let app = api::router()
        .nest_service("/assets", ServeDir::new(args.data_dir.join("assets")))
        .fallback_service(ServeDir::new(&args.web_dir).fallback(ServeFile::new(index)))
        .layer(CorsLayer::permissive())
        .with_state(shared);

    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    tracing::info!("CG server listening on http://{}", args.bind);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
