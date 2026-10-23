//! macOS application firewall: it blocks incoming connections to a program it
//! does not know, silently for a service (no one sees the prompt). Each update
//! is a new program to it, the web UI and NDI receivers on other machines then
//! see nothing while everything works on this Mac. Running as the service
//! (root), the server lists itself as allowed at every start.

#[cfg(target_os = "macos")]
pub fn allow_self() {
    use std::process::Command;
    const FW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.canonicalize().unwrap_or(exe);
    let path = exe.to_string_lossy();
    let run = |args: &[&str]| {
        Command::new(FW)
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let Ok(state) = run(&["--getglobalstate"]) else {
        return;
    };
    // "Firewall is disabled. (State = 0)": nothing to do.
    if state.contains("State = 0") {
        return;
    }
    if state.contains("State = 2") {
        tracing::warn!("the macOS firewall blocks all incoming connections: other machines cannot reach this server (System Settings ▸ Network ▸ Firewall)");
    }
    let added = run(&["--add", &path]);
    let unblocked = run(&["--unblockapp", &path]);
    match (added, unblocked) {
        (Ok(_), Ok(_)) => tracing::info!(exe = %path, "allowed through the macOS firewall"),
        (a, b) => {
            tracing::warn!(exe = %path, add = ?a.err(), unblock = ?b.err(), "cannot allow the server through the macOS firewall")
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn allow_self() {}
