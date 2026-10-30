pub mod bash_classifier;
pub mod config;
pub mod custom_tools;
pub mod docs_search;
pub mod enforcement;
#[cfg(feature = "metering")]
pub mod event_delivery;
pub mod events;
pub mod gateway;
pub mod hooks;
pub mod interceptors;
pub mod protocol;
#[cfg(feature = "metering")]
pub(crate) mod quota;
pub mod remote;
pub mod risk_assessment;
pub mod session;
pub mod shell_ast_shadow;
pub mod tool_intent;
pub mod upstream;
pub mod usage;
pub mod web_protocol;

/// Database pool type for step metering.
/// When the `metering` feature is enabled, this is a real Postgres connection pool.
/// When disabled, it's a no-op placeholder (always None).
#[cfg(feature = "metering")]
pub type DbPool = Option<sqlx::PgPool>;
#[cfg(not(feature = "metering"))]
pub type DbPool = Option<()>;
