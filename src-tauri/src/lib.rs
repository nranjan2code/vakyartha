// vak desktop shell. The engine is the framework's own TypeScript, run by a
// Node sidecar (apps/desktop/sidecar/main.ts); this side only starts it,
// hands its address and token to the webview, and stops it on quit.
//
// Dev builds run the sidecar source with the `node` on PATH (or VAK_NODE) and
// keep data in <repo>/.vak/desktop. Release builds run the bundled Node binary
// and bundled sidecar, with data in the OS app-data directory.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

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

/// Closing the window hides it while this is set, so the engine and its
/// channels (Telegram, ...) keep running; Quit in the tray menu ends both.
static KEEP_RUNNING: AtomicBool = AtomicBool::new(true);

/// Where the engine listens and the token it requires; the webview asks once at start.
#[tauri::command]
fn backend(state: tauri::State<Sidecar>) -> Result<Backend, String> {
    state.backend.clone()
}

#[tauri::command]
fn set_keep_running(keep: bool) {
    KEEP_RUNNING.store(keep, Ordering::Relaxed);
}

#[tauri::command]
fn autostart(app: AppHandle, enable: Option<bool>) -> Result<bool, String> {
    let launcher = app.autolaunch();
    match enable {
        Some(true) => launcher.enable().map_err(|e| e.to_string())?,
        Some(false) => launcher.disable().map_err(|e| e.to_string())?,
        None => {}
    }
    launcher.is_enabled().map_err(|e| e.to_string())
}

/// A toolbar click exports text to Downloads. Never accept a caller's path or
/// overwrite an existing file, including a symlink, when titles repeat.
#[tauri::command]
fn save_canvas(app: AppHandle, filename: String, content: String) -> Result<(), String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    write_canvas(&dir, &filename, &content)
}

fn write_canvas(dir: &std::path::Path, filename: &str, content: &str) -> Result<(), String> {
    let stem = filename.strip_suffix(".md").ok_or("expected a Markdown filename")?;
    if stem.is_empty() || stem.len() > 240 || !stem.chars().all(|c| c.is_alphanumeric() || " _-".contains(c)) {
        return Err("invalid download filename".into());
    }
    for index in 0..1000 {
        let name = if index == 0 { filename.to_owned() } else { format!("{stem} ({index}).md") };
        let path = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(content.as_bytes()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(e.to_string());
                }
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("too many downloads with this title".into())
}

#[cfg(test)]
mod canvas_tests {
    use super::write_canvas;

    #[test]
    fn exports_cannot_escape_downloads_or_overwrite_files_and_symlinks() {
        let root = std::env::temp_dir().join(format!("vak-export-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let dir = root.join("downloads");
        std::fs::create_dir_all(&dir).unwrap();
        write_canvas(&dir, "Report.md", "first").unwrap();
        write_canvas(&dir, "Report.md", "second").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("Report.md")).unwrap(), "first");
        assert_eq!(std::fs::read_to_string(dir.join("Report (1).md")).unwrap(), "second");
        assert!(write_canvas(&dir, "../escape.md", "bad").is_err());
        assert!(write_canvas(&dir, "wrong.html", "bad").is_err());
        assert!(!root.join("escape.md").exists());
        #[cfg(unix)]
        {
            let target = root.join("keep.txt");
            std::fs::write(&target, "keep").unwrap();
            std::os::unix::fs::symlink(&target, dir.join("Link.md")).unwrap();
            write_canvas(&dir, "Link.md", "new").unwrap();
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
            assert_eq!(std::fs::read_to_string(dir.join("Link (1).md")).unwrap(), "new");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open vak", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New chat", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit vak", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&open, &new_chat, &PredefinedMenuItem::separator(app)?, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("vak")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "new-chat" => {
                show_main(app);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.dispatchEvent(new Event('vak:new-chat'))");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
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
            // Dev keys stay apart from the installed app's.
            .env("VAK_KEYCHAIN_SERVICE", "com.vakprojection.desktop.dev")
            .env("VAK_ENV_FILES", repo.join(".env"));
        Ok(cmd)
    } else {
        // externalBin binaries land next to the app executable, without the target triple.
        let exe = std::env::current_exe().map_err(|e| format!("executable path: {e}"))?;
        let dir = exe.parent().ok_or("executable has no directory")?;
        let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if !node.exists() {
            // `tauri build` without tauri.release.conf.json bundles no engine.
            return Err("this build has no engine bundled: build it with `npm run desktop:build`".into());
        }
        let script = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource dir: {e}"))?
            .join("resources/sidecar.mjs");
        let data = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
        let npm = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource dir: {e}"))?
            .join("resources/npm/bin/npm-cli.js");
        let mut cmd = Command::new(node);
        cmd.arg("--disable-warning=ExperimentalWarning").arg(script).env("VAK_DATA_DIR", data).env("VAK_APP_VERSION", env!("CARGO_PKG_VERSION")).env("VAK_NPM_CLI", npm);
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
        // A second launch focuses the running window: two engines would share
        // one data folder and write the same files.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![backend, set_keep_running, autostart, save_canvas])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if KEEP_RUNNING.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            tray(app)?;
            let (child, stdin, backend) = start(app.handle());
            if let Err(e) = &backend {
                eprintln!("[engine] {e}");
            }
            app.manage(Sidecar { child: Mutex::new(child), stdin: Mutex::new(stdin), backend });
            // Debug builds only: run a script inside the window (UI probes, no screen needed).
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("VAK_DEBUG_JS") {
                if let Ok(js) = std::fs::read_to_string(&path) {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(4));
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.eval(&js);
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the vak desktop app");

    app.run(|handle, event| {
        // Clicking the Dock icon brings back a window hidden by close.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main(handle);
        }
        if let RunEvent::Exit = event {
            let state = handle.state::<Sidecar>();
            // Closing stdin asks the engine to stop its channels and exit;
            // it gets a few seconds before it is killed.
            drop(state.stdin.lock().unwrap().take());
            if let Some(mut child) = state.child.lock().unwrap().take() {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
                while std::time::Instant::now() < deadline {
                    if let Ok(Some(_)) = child.try_wait() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
