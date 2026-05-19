use std::path::PathBuf;

use clap::Parser;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing_subscriber::EnvFilter;

use statewright_mcp_gateway::config::GatewayConfig;
use statewright_mcp_gateway::gateway::Gateway;
use statewright_mcp_gateway::hooks;
use statewright_mcp_gateway::session::SessionManager;
use statewright_mcp_gateway::upstream::UpstreamManager;

#[derive(Parser)]
#[command(name = "statewright-gateway")]
#[command(about = "MCP proxy server enforcing state machine guardrails")]
struct Args {
    /// Path to gateway configuration file (JSON). Required for stdio/hook modes.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Start the hook HTTP server for agent CLI plugins
    #[arg(long, default_value_t = false)]
    hook_server: bool,

    /// Run hook server only (no MCP stdio transport). For testing and standalone use.
    #[arg(long, default_value_t = false)]
    hook_only: bool,

    /// Run as remote MCP transport (HTTP+SSE). Cloud mode — no config file needed.
    #[arg(long, default_value_t = false)]
    remote: bool,

    /// Listen address for remote transport (default: 0.0.0.0:3001)
    #[arg(long, default_value = "0.0.0.0:3001")]
    remote_addr: String,

    /// PocketBase URL for workflow loading in remote mode
    #[arg(long, default_value = "http://localhost:8090")]
    pb_url: String,

    /// Port file path for the hook server (default: /tmp/statewright-hook-port)
    #[arg(long, default_value = "/tmp/statewright-hook-port")]
    hook_port_file: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();

    // Remote mode: HTTP+SSE transport, no config file needed
    if args.remote {
        tracing::info!(addr = args.remote_addr, pb_url = args.pb_url, "Starting remote MCP transport");
        let addr = statewright_mcp_gateway::remote::start_remote_server(
            statewright_mcp_gateway::remote::RemoteConfig {
                pb_url: args.pb_url,
                listen_addr: args.remote_addr,
                database_url: std::env::var("DATABASE_URL").ok(),
            },
        )
        .await
        .map_err(|e| format!("Failed to start remote server: {}", e))?;
        tracing::info!(%addr, "Remote MCP transport ready");
        tokio::signal::ctrl_c().await?;
        tracing::info!("Shutting down");
        return Ok(());
    }

    let config_path = args.config.ok_or("--config is required for stdio/hook mode")?;
    let config = GatewayConfig::from_file(&config_path)
        .map_err(|e| format!("Config error: {}", e))?;

    // Validate all workflow definitions
    for (name, def) in &config.workflows {
        statewright_engine::validate_definition(def)
            .map_err(|e| format!("Invalid workflow '{}': {}", name, e))?;
    }

    let default_def = config.workflows.get(&config.default)
        .ok_or_else(|| format!("Default workflow '{}' not found", config.default))?;

    tracing::info!(
        default = config.default,
        workflows = config.workflows.len(),
        upstreams = config.upstream_servers.len(),
        "Starting statewright-gateway"
    );

    // Start upstream MCP servers
    let upstream = if config.upstream_servers.is_empty() {
        tracing::warn!("No upstream servers configured — custom tools only");
        UpstreamManager::empty()
    } else {
        UpstreamManager::start(config.upstream_servers).await
            .map_err(|e| format!("Failed to start upstream servers: {}", e))?
    };

    // Resolve plan limit from cloud API. Never from config file.
    // Self-hosted (no api_key) = unlimited. Cloud (api_key) = fetched from API.
    let plan_limit: Option<u64> = if let Some(ref _api_key) = config.api_key {
        let _cloud_url = config.cloud_url.as_deref().unwrap_or("https://mcp.statewright.dev");
        // TODO: GET {cloud_url}/api/gateway/plan-limit with Authorization: Bearer {api_key}
        // Returns { "plan_limit": N, "used": M, "period": "2026-05" }
        tracing::info!("Cloud mode: plan limit will be fetched from API on startup");
        None // placeholder until API endpoint exists
    } else {
        None // self-hosted = unlimited
    };

    // Create session with default workflow
    let session_manager = SessionManager::new();
    let session_id = uuid::Uuid::new_v4().to_string();
    session_manager.create(session_id.clone(), default_def.clone());
    if let Some(limit) = plan_limit {
        session_manager.set_plan_limit(&session_id, limit);
    }

    tracing::info!(
        session_id = session_id,
        workflow = config.default,
        cloud_mode = config.api_key.is_some(),
        "Session created"
    );

    // Start hook server if requested
    if args.hook_server {
        let addr = hooks::start_hook_server(session_manager.clone(), session_id.clone()).await
            .map_err(|e| format!("Failed to start hook server: {}", e))?;

        std::fs::write(&args.hook_port_file, addr.port().to_string())
            .map_err(|e| format!("Failed to write port file: {}", e))?;

        tracing::info!(
            port = addr.port(),
            port_file = %args.hook_port_file.display(),
            "Hook server started"
        );
    }

    // Create gateway with all workflows
    let active_workflow = Some(config.default.clone());
    let mut gateway = Gateway::new(
        session_manager,
        upstream,
        session_id,
        config.workflows,
        active_workflow,
        String::new(), // No owner_id in local/stdio mode
        None,          // No DB pool in local mode
    );

    // Hook-only mode: just wait for shutdown signal
    if args.hook_only {
        tracing::info!("Running in hook-only mode (no MCP stdio transport)");
        tokio::signal::ctrl_c().await?;
        tracing::info!("Shutting down");
        return Ok(());
    }

    // Run stdio transport loop
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).await?;
        if bytes_read == 0 {
            break; // EOF
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: statewright_mcp_gateway::protocol::JsonRpcRequest =
            match serde_json::from_str(trimmed) {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(error = %e, line = trimmed, "Failed to parse request");
                    let error_resp = statewright_mcp_gateway::protocol::JsonRpcResponse::error(
                        None,
                        -32700,
                        format!("Parse error: {}", e),
                    );
                    let resp_line = serde_json::to_string(&error_resp)?;
                    stdout.write_all(resp_line.as_bytes()).await?;
                    stdout.write_all(b"\n").await?;
                    stdout.flush().await?;
                    continue;
                }
            };

        tracing::debug!(method = request.method, "Incoming request");

        if let Some(response) = gateway.handle_message(request).await {
            let resp_line = serde_json::to_string(&response)?;
            stdout.write_all(resp_line.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }

    tracing::info!("Gateway shutting down");
    Ok(())
}
