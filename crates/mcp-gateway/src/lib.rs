pub mod bash_classifier;
pub mod config;
pub mod custom_tools;
pub mod enforcement;
pub mod gateway;
pub mod hooks;
pub mod interceptors;
pub mod protocol;
pub mod remote;
pub mod session;
pub mod upstream;
pub mod usage;

/// Database pool type for step metering.
/// When the `metering` feature is enabled, this is a real Postgres connection pool.
/// When disabled, it's a no-op placeholder (always None).
#[cfg(feature = "metering")]
pub type DbPool = Option<sqlx::PgPool>;
#[cfg(not(feature = "metering"))]
pub type DbPool = Option<()>;
