// vak desktop shell. The engine is the framework's own TypeScript, run by a
// Node sidecar (apps/desktop/sidecar/main.ts); this side only starts it,
// hands its address and token to the webview, and stops it on quit.
//
// Dev builds run the sidecar source with the `node` on PATH (or VAK_NODE) and
// keep data in <repo>/.vak/desktop. Release builds run the bundled Node binary
// and bundled sidecar, with data in the OS app-data directory.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, RunEvent};

#[derive(Clone, Serialize, Deserialize)]
struct Backend {
    url: String,
    token: String,
}

#[derive(Deserialize)]
struct Ready {
    port: u16,
    token: String,
}

struct Sidecar {
    child: Mutex<Option<Child>>,
    /// Kept open: the sidecar exits when its stdin closes, so it never outlives the app.
    stdin: Mutex<Option<ChildStdin>>,
    backend: Result<Backend, String>,
}

/// Where the engine listens and the token it requires; the webview asks once at start.
#[tauri::command]
fn backend(state: tauri::State<Sidecar>) -> Result<Backend, String> {
    state.backend.clone()
}

fn sidecar_command(app: &tauri::AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let repo = repo.canonicalize().map_err(|e| format!("repo path: {e}"))?;
        let node = std::env::var("VAK_NODE").unwrap_or_else(|_| "node".into());
        let mut cmd = Command::new(node);
        cmd.arg("--disable-warning=ExperimentalWarning")
            .arg(repo.join("apps/desktop/sidecar/main.ts"))
            .env("VAK_DATA_DIR", repo.join(".vak/desktop"))
            .env("VAK_ENV_FILES", repo.join(".env"));
        Ok(cmd)
    } else {
        // externalBin binaries land next to the app executable, without the target triple.
        let exe = std::env::current_exe().map_err(|e| format!("executable path: {e}"))?;
        let dir = exe.parent().ok_or("executable has no directory")?;
        let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        let script = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource dir: {e}"))?
            .join("resources/sidecar.mjs");
        let data = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
        let mut cmd = Command::new(node);
        cmd.arg("--disable-warning=ExperimentalWarning").arg(script).env("VAK_DATA_DIR", data);
        Ok(cmd)
    }
}

/// Start the sidecar and wait for its ready line.
fn start(app: &tauri::AppHandle) -> (Option<Child>, Option<ChildStdin>, Result<Backend, String>) {
    let mut cmd = match sidecar_command(app) {
        Ok(c) => c,
        Err(e) => return (None, None, Err(e)),
    };
    let mut child = match cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
        Ok(c) => c,
        Err(e) => return (None, None, Err(format!("could not start the engine (is Node 24+ installed?): {e}"))),
    };
    let stdin = child.stdin.take();
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut line = String::new();
    let backend = loop {
        line.clear();
        match lines.read_line(&mut line) {
            Ok(0) => break Err("the engine exited before it was ready".to_string()),
            Ok(_) => {
                if let Some(json) = line.trim().strip_prefix("VAK_READY ") {
                    break serde_json::from_str::<Ready>(json)
                        .map(|r| Backend { url: format!("http://127.0.0.1:{}", r.port), token: r.token })
                        .map_err(|e| format!("bad ready line: {e}"));
                }
                eprint!("[engine] {line}");
            }
            Err(e) => break Err(format!("reading the engine: {e}")),
        }
    };
    // Keep draining stdout so the sidecar never blocks on a full pipe.
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = lines.read_to_end(&mut sink);
    });
    (Some(child), stdin, backend)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend])
        .setup(|app| {
            let (child, stdin, backend) = start(app.handle());
            if let Err(e) = &backend {
                eprintln!("[engine] {e}");
            }
            app.manage(Sidecar { child: Mutex::new(child), stdin: Mutex::new(stdin), backend });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the vak desktop app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<Sidecar>();
            drop(state.stdin.lock().unwrap().take());
            if let Some(mut child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
