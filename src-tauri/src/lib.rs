// Vakyartha desktop shell. The engine is the framework's own TypeScript, run by a
// Node sidecar (sidecar/main.ts); this side only starts it,
// provides private main-window IPC, and stops it on quit.
//
// Dev builds run the sidecar source with the `node` on PATH (or VAK_NODE) and
// keep data in <repo>/.vak/desktop. Release builds run the bundled Node binary
// and bundled sidecar, with data in the OS app-data directory.

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
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

mod engine;
mod policy;
mod vault;
// Transport primitive only; provider-specific authorization and control-actor
// dispatch must be completed before this client is used for product traffic.
#[allow(dead_code)]
mod broker;
// The native control actor and store start with an empty execution profile.
// No workload class is routed through them until its measured profile and
// mediated execution cutover are ready.
#[allow(
    dead_code,
    reason = "typed actor operations are enabled only with the protected workload cutover"
)]
mod control;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use control::{CapacityProfile, ControlActor};
use engine::{Engine as Sidecar, engine_request, engine_ack, engine_cancel};

/// Closing the window hides it while this is set, so the engine and its
/// channels (Telegram, ...) keep running; Quit in the tray menu ends both.
static KEEP_RUNNING: AtomicBool = AtomicBool::new(true);

fn default_service() -> String {
    if cfg!(debug_assertions) {
        "com.nranjan2code.vakyartha.dev".into()
    } else {
        "com.nranjan2code.vakyartha".into()
    }
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        std::env::var_os("VAK_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join(".vak/desktop")
            })
    } else {
        app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn control_data_dir(app: &AppHandle) -> std::io::Result<PathBuf> {
    let path = if cfg!(debug_assertions) {
        std::env::var_os("VAK_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join(".vak/desktop")
            })
    } else {
        app.path().app_data_dir().map_err(std::io::Error::other)?
    };
    std::fs::create_dir_all(&path)?;
    std::fs::canonicalize(path)
}

/// Store a secret into the cross-platform Vault through the trusted engine broker.
#[tauri::command]
fn vault_set(window: tauri::WebviewWindow, service: Option<String>, account: String, value: String) -> Result<(), String> {
    engine::main_window(&window)?;
    let svc = service.unwrap_or_else(default_service);
    let data_dir = app_data_dir(window.app_handle());
    vault::set(&svc, &account, &value, &data_dir)
}

/// Delete a secret from the cross-platform Vault through the trusted engine broker.
#[tauri::command]
fn vault_delete(window: tauri::WebviewWindow, service: Option<String>, account: String) -> Result<(), String> {
    engine::main_window(&window)?;
    let svc = service.unwrap_or_else(default_service);
    let data_dir = app_data_dir(window.app_handle());
    vault::delete(&svc, &account, &data_dir)
}

/// Egress validation gate: checks whether a destination URL is permitted by broker policy.
#[tauri::command]
fn check_egress_endpoint(window: tauri::WebviewWindow, scheme: String, host: String, port: Option<u16>, custom_hosts: Option<Vec<String>>) -> Result<bool, String> {
    engine::main_window(&window)?;
    let extra = custom_hosts.unwrap_or_default();
    match policy::evaluate_egress_with_custom(&scheme, &host, port, &extra) {
        policy::EgressDecision::Allowed => Ok(true),
        policy::EgressDecision::Denied(reason) => Err(reason.into()),
    }
}

/// Native folder picker dialog.
#[tauri::command]
fn pick_folder(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    engine::main_window(&window)?;
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"Select Project Folder\")")
            .output()
            .map_err(|e| format!("failed to launch folder chooser: {e}"))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                let clean = path.strip_suffix('/').unwrap_or(&path).to_string();
                return Ok(Some(clean));
            }
        }
        Ok(None)
    }
    #[cfg(target_os = "linux")]
    {
        let output = Command::new("zenity")
            .arg("--file-selection")
            .arg("--directory")
            .output();
        if let Ok(out) = output
            && out.status.success()
        {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                let clean = path.strip_suffix('/').unwrap_or(&path).to_string();
                return Ok(Some(clean));
            }
        }
        Ok(None)
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell")
            .arg("-NoProfile")
            .arg("-Command")
            .arg("& { Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } }")
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    let clean = path.strip_suffix('/').unwrap_or(&path).to_string();
                    return Ok(Some(clean));
                }
            }
        }
        Ok(None)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Ok(None)
    }
}

/// The private desktop transport identifier; the webview asks once at start.
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

#[tauri::command]
fn show_admin(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("admin") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            &app,
            "admin",
            tauri::WebviewUrl::App("admin.html".into()),
        )
        .title("Vakyartha - Admin & Observability Console")
        .inner_size(1100.0, 720.0)
        .min_inner_size(800.0, 500.0)
        .build();
    }
    Ok(())
}

fn tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open vak", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New chat", true, None::<&str>)?;
    let admin = MenuItem::with_id(app, "admin", "Admin & Observability Console...", true, Some("CmdOrCtrl+Shift+A"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit vak", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&open, &new_chat, &admin, &PredefinedMenuItem::separator(app)?, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Vakyartha")
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
            "admin" => { let _ = show_admin(app.clone()); }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn configure_release_runtime(cmd: &mut Command) {
    // The installed engine chooses its own runtime and settings. Terminal or
    // launch-agent hooks must not preload code or override these boundaries.
    for name in ["NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "VAK_ENV_FILES", "VAK_PORT", "VAK_KEYCHAIN_SERVICE", "VAK_SANDBOX_BIN", "VAK_SANDBOX_ENABLED"] {
        cmd.env_remove(name);
    }
    // This bundle imports only Node built-ins; integrations run in separate processes.
    cmd.arg("--no-addons");
}

#[cfg(test)]
mod runtime_tests {
    use super::configure_release_runtime;
    use std::process::Command;

    #[test]
    fn release_discards_inherited_startup_hooks_and_development_overrides() {
        let mut cmd = Command::new("node");
        cmd.env("NODE_OPTIONS", "--import=untrusted.mjs").env("VAK_ENV_FILES", "/untrusted.env");
        configure_release_runtime(&mut cmd);
        let changes: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        for name in ["NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "VAK_ENV_FILES", "VAK_PORT", "VAK_KEYCHAIN_SERVICE", "VAK_SANDBOX_BIN", "VAK_SANDBOX_ENABLED"] {
            assert_eq!(changes.get(std::ffi::OsStr::new(name)), Some(&None));
        }
        assert!(cmd.get_args().any(|arg| arg == "--no-addons"));
        assert!(!changes.contains_key(std::ffi::OsStr::new("HOME")));
        assert!(!changes.contains_key(std::ffi::OsStr::new("PATH")));
    }
}

fn sidecar_command(app: &tauri::AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let repo = repo.canonicalize().map_err(|e| format!("repo path: {e}"))?;
        let node = std::env::var("VAK_NODE").unwrap_or_else(|_| "node".into());
        let mut cmd = Command::new(node);
        cmd.arg("--disable-warning=ExperimentalWarning")
            .arg(repo.join("sidecar/main.ts"))
            .env("VAK_DATA_DIR", std::env::var_os("VAK_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| repo.join(".vak/desktop")))
            // Dev keys stay apart from the installed app's.
            .env("VAK_KEYCHAIN_SERVICE", std::env::var("VAK_KEYCHAIN_SERVICE").unwrap_or_else(|_| "com.nranjan2code.vakyartha.dev".into()))
            .env("VAK_ENV_FILES", std::env::var_os("VAK_ENV_FILES").unwrap_or_else(|| repo.join(".env").into_os_string()));
        // Dev: point at the sandbox binary if built.
        let dev_vaksb = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("sandbox").join("target").join("release").join("vaksb");
        if dev_vaksb.exists() {
            cmd.env("VAK_SANDBOX_BIN", dev_vaksb);
        }
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
        let vaksb = dir.join(if cfg!(windows) { "vaksb.exe" } else { "vaksb" });
        let mut cmd = Command::new(node);
        configure_release_runtime(&mut cmd);
        cmd.arg("--disable-warning=ExperimentalWarning").arg(script).env("VAK_DATA_DIR", data).env("VAK_APP_VERSION", env!("CARGO_PKG_VERSION")).env("VAK_NPM_CLI", npm);
        if vaksb.exists() {
            cmd.env("VAK_SANDBOX_BIN", vaksb);
        }
        Ok(cmd)
    }
}

fn start(app: &tauri::AppHandle) -> Sidecar {
    match sidecar_command(app) { Ok(cmd) => engine::start(cmd), Err(error) => Sidecar::failed(error) }
}

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
        .invoke_handler(tauri::generate_handler![
            backend,
            engine_request,
            engine_ack,
            engine_cancel,
            set_keep_running,
            autostart,
            save_canvas,
            show_admin,
            vault_set,
            vault_delete,
            check_egress_endpoint,
            pick_folder
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && KEEP_RUNNING.load(Ordering::Relaxed)
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            tray(app)?;
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            {
                let data_dir = control_data_dir(app.handle())?;
                let profile = CapacityProfile::unconfigured().map_err(|error| {
                    std::io::Error::other(format!("control profile: {error:?}"))
                })?;
                let control = ControlActor::open(
                    &data_dir,
                    "unconfigured-v1",
                    profile,
                    32,
                    std::time::Duration::from_secs(1),
                )
                .map_err(|error| {
                    std::io::Error::other(format!("native control startup: {error:?}"))
                })?;
                app.manage(control);
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            eprintln!("[control] unavailable: durable native store is not verified on this platform");
            let sidecar = start(app.handle());
            if let Err(e) = &sidecar.backend {
                eprintln!("[engine] {e}");
            }
            app.manage(sidecar);
            // Debug builds only: run a script inside the window (UI probes, no screen needed).
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("VAK_DEBUG_JS")
                && let Ok(js) = std::fs::read_to_string(&path)
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.eval(&js);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Vakyartha app");

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
            state.close();
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
