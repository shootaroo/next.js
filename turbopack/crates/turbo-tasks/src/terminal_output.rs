use std::{
    fmt,
    io::{self, Write},
    sync::Arc,
};

use anyhow::Result;
use tokio::task_local;

/// An embedder-owned terminal destination. It accepts bytes without waiting for
/// the terminal to display them, and never becomes part of a cached task input.
pub type TerminalOutput = Arc<dyn Fn(u8, Vec<u8>) -> Result<()> + Send + Sync>;

task_local! {
    static INITIAL_OUTPUT: Option<TerminalOutput>;
}

pub fn current_terminal_output() -> Option<TerminalOutput> {
    INITIAL_OUTPUT
        .try_with(Clone::clone)
        .ok()
        .flatten()
        .or_else(|| crate::manager::try_turbo_tasks().and_then(|tasks| tasks.terminal_output()))
}

/// Initialization runs before an engine exists. Scope its diagnostics to the
/// same destination that subsequent engine tasks will inherit.
pub fn with_terminal_output<T>(output: Option<TerminalOutput>, f: impl FnOnce() -> T) -> T {
    INITIAL_OUTPUT.sync_scope(output, f)
}

pub fn write_terminal_output(fd: u8, bytes: &[u8]) -> Result<()> {
    if let Some(output) = current_terminal_output() {
        return output(fd, bytes.to_vec());
    }
    match fd {
        1 => io::stdout().lock().write_all(bytes)?,
        2 => io::stderr().lock().write_all(bytes)?,
        _ => anyhow::bail!("Invalid terminal stream {fd}"),
    }
    Ok(())
}

/// Preserve print macro semantics for diagnostic sites that cannot return an
/// output error. Never silently drop an embedder failure.
pub fn print_terminal_output(fd: u8, args: fmt::Arguments<'_>) {
    let text = format!("{args}\n");
    if let Err(error) = write_terminal_output(fd, text.as_bytes()) {
        eprintln!("Failed to deliver terminal output: {error}\n{text}");
    }
}
