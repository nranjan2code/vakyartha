// Vakyartha desktop shell. The engine is the framework's own TypeScript, run by a
// Node sidecar (sidecar/main.ts); this side only starts it,
// provides private main-window IPC, and stops it on quit.
//
// Both development and release launch a bundled Node worker through the
// reviewed sandbox helper. Worker data lives below the app-data worker directory;
// native control, canonical storage and credentials remain outside its grants.

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
mod worker;
mod canonical_supervisor;
#[allow(dead_code, reason = "product dispatch remains gated on the context and lifecycle adapters")]
mod reasoner_supervisor;
mod policy;
mod private_store;
mod vault;
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
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use control::ControlActor;
use control::registry::{WorkspaceBinding, WorkspaceGrant, WorkspaceMode, WorkspaceRecord};
use control::state::{RootCreate, RootTask};
use control::canonical::CandidateCommitReceipt;
use control::host_sessions::{SessionMigrationPlan, SessionMigrationReceipt, SessionSummary};
use engine::{Engine as Sidecar, engine_request, engine_ack, engine_cancel};

/// Closing the window hides it while this is set, so the engine and its
/// channels (Telegram, ...) keep running; Quit in the tray menu ends both.
static KEEP_RUNNING: AtomicBool = AtomicBool::new(true);

fn default_service(app: &AppHandle) -> String {
    if cfg!(debug_assertions) {
        format!("{}.dev", app.config().identifier)
    } else {
        app.config().identifier.clone()
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
fn vault_set(window: tauri::WebviewWindow, account: String, value: String) -> Result<(), String> {
    engine::main_window(&window)?;
    let svc = default_service(window.app_handle());
    let data_dir = app_data_dir(window.app_handle());
    vault::set(&svc, &account, &value, &data_dir)
}

/// Delete a secret from the cross-platform Vault through the trusted engine broker.
#[tauri::command]
fn vault_delete(window: tauri::WebviewWindow, account: String) -> Result<(), String> {
    engine::main_window(&window)?;
    let svc = default_service(window.app_handle());
    let data_dir = app_data_dir(window.app_handle());
    vault::delete(&svc, &account, &data_dir)
}

/// Only presence crosses into trusted Settings UI, never stored credential bytes.
#[tauri::command]
async fn vault_presence(window: tauri::WebviewWindow, accounts: Vec<String>) -> Result<std::collections::BTreeMap<String, bool>, String> {
    engine::main_window(&window)?;
    if accounts.len() > 64 || accounts.iter().any(|name| name.is_empty() || name.len() > 128 || !name.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')) {
        return Err("Invalid credential presence request".into());
    }
    let data = app_data_dir(window.app_handle());
    let service = default_service(window.app_handle());
    tauri::async_runtime::spawn_blocking(move || {
        accounts.into_iter().map(|name| {
            vault::get(&service, &name, &data)
                .map(|value| (name, value.is_some_and(|value| !value.is_empty())))
                .map_err(|_| "Credential presence is unavailable".to_owned())
        }).collect()
    }).await.map_err(|_| "Credential presence is unavailable".to_owned())?
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

/// Creates a native task from a trusted app-window request. The reasoning
/// sidecar has no command that can create or mutate authoritative task state.
#[tauri::command]
fn control_create_root(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: RootCreate,
) -> Result<RootTask, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .create_root_with_budget(request)
        .map_err(|_| "Native task request was refused".to_owned())
}

/// Permission UI reads only actor-issued disclosures. It cannot submit a model
/// payload or receive a native dispatch object through this command family.
#[tauri::command]
async fn control_provider_consents(window: tauri::WebviewWindow, app: AppHandle) -> Result<Vec<control::generation::ConsentView>, String> {
    engine::main_window(&window)?;
    let handle = app.try_state::<ControlActor>().ok_or("Native permissions are unavailable")?.handle();
    tauri::async_runtime::spawn_blocking(move || handle.list_provider_consents().map_err(|_| "Permission requests are unavailable".to_owned())).await.map_err(|_| "Permission requests are unavailable".to_owned())?
}
#[tauri::command]
async fn control_provider_consent_request(window: tauri::WebviewWindow, app: AppHandle, ticket_id: String, fingerprint: String, offset: usize) -> Result<control::generation::RequestSlice, String> {
    engine::main_window(&window)?;
    if ticket_id.len() > 120 || fingerprint.len() != 64 || offset > 8_388_608 { return Err("Invalid permission request".into()); }
    let handle = app.try_state::<ControlActor>().ok_or("Native permissions are unavailable")?.handle();
    tauri::async_runtime::spawn_blocking(move || handle.read_provider_consent(ticket_id, fingerprint, offset).map_err(|_| "This request changed or ended; refresh permissions".to_owned())).await.map_err(|_| "Permission request is unavailable".to_owned())?
}
#[tauri::command]
async fn control_provider_consent_decide(window: tauri::WebviewWindow, app: AppHandle, ticket_id: String, fingerprint: String, decision: String) -> Result<control::generation::ConsentReceipt, String> {
    engine::main_window(&window)?;
    if ticket_id.len() > 120 || fingerprint.len() != 64 { return Err("Invalid permission decision".into()); }
    let decision = match decision.as_str() { "allow_once" => control::generation::Decision::AllowOnce, "deny" => control::generation::Decision::Deny, _ => return Err("Choose Allow once or Deny".into()) };
    let handle = app.try_state::<ControlActor>().ok_or("Native permissions are unavailable")?.handle();
    tauri::async_runtime::spawn_blocking(move || handle.decide_provider_consent(ticket_id, fingerprint, decision).map_err(|_| "The decision could not be confirmed; refresh permissions before continuing".to_owned())).await.map_err(|_| "Permission decision is unavailable".to_owned())?
}

/// Product task mutations originate in trusted application controls, never in
/// the reasoning worker's general HTTP/proposal channel.
#[tauri::command]
async fn control_task(window: tauri::WebviewWindow, app: AppHandle, command: control::tasks::TaskCommand) -> Result<serde_json::Value, String> {
    engine::main_window(&window)?;
    if serde_json::to_vec(&command).map_or(true, |bytes| bytes.len() > 256_000) {
        return Err("Task request exceeds the supported size".into());
    }
    let handle = app.try_state::<ControlActor>().ok_or("Native task control is unavailable")?.handle();
    tauri::async_runtime::spawn_blocking(move || handle.product_task(command).map_err(|error| match error {
        control::ControlError::Admission(control::AdmissionError::InvalidTask) => "Task definition is invalid; review the goal, model, inputs and limits".to_owned(),
        control::ControlError::Admission(control::AdmissionError::TaskCapabilityUnavailable) => "This task operation is unavailable until protected execution is connected".to_owned(),
        control::ControlError::Admission(control::AdmissionError::RootNotFound) => "Task was not found".to_owned(),
        control::ControlError::Admission(control::AdmissionError::DuplicateRoot) => "Task identity already belongs to a different request".to_owned(),
        control::ControlError::TaskState(control::state::StateError::RevisionConflict) => "Task changed; refresh before applying this action".to_owned(),
        _ => "Native task control could not complete this request".to_owned(),
    })).await.map_err(|_| "Native task control is unavailable".to_owned())?
}

/// Reads one task by its opaque identity through the trusted app window.
#[tauri::command]
fn control_read_root(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
) -> Result<RootTask, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .read_root(id)
        .map_err(|_| "Native task was not found or could not be read".to_owned())
}

/// Reads an exact durable commit receipt through the trusted main/admin window.
#[tauri::command]
fn control_read_candidate_receipt(
    window: tauri::WebviewWindow,
    app: AppHandle,
    commit_id: String,
) -> Result<Option<CandidateCommitReceipt>, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .read_candidate_receipt(commit_id)
        .map_err(|_| "Native commit receipt is unavailable".to_owned())
}

/// Admits the selected chat ID from a trusted UI window for native snapshot access.
#[tauri::command]
fn control_admit_host_session(
    window: tauri::WebviewWindow,
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    engine::main_window(&window)?;
    let actor = app.try_state::<ControlActor>().ok_or_else(|| "Native session storage is unavailable".to_owned())?;
    actor.handle().admit_host_session(session_id).map_err(|_| "Native chat admission was refused".to_owned())
}

/// Releases a newly admitted ID when the trusted UI's operation failed before persistence.
#[tauri::command]
fn control_release_host_session_admission(
    window: tauri::WebviewWindow,
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    engine::main_window(&window)?;
    let actor = app.try_state::<ControlActor>().ok_or_else(|| "Native session storage is unavailable".to_owned())?;
    actor.handle().release_host_session_admission(session_id).map_err(|_| "Native chat admission could not be released safely".to_owned())
}

#[tauri::command]
fn control_list_host_sessions(window: tauri::WebviewWindow, app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    engine::main_window(&window)?;
    let actor = app.try_state::<ControlActor>().ok_or_else(|| "Native session storage is unavailable".to_owned())?;
    actor.handle().list_host_sessions().map_err(|_| "Native chat summaries are unavailable".to_owned())
}

#[tauri::command]
fn control_plan_host_session_migration(window: tauri::WebviewWindow, app: AppHandle) -> Result<SessionMigrationPlan, String> {
    engine::main_window(&window)?;
    let actor = app.try_state::<ControlActor>().ok_or_else(|| "Native session storage is unavailable".to_owned())?;
    actor.handle().plan_host_session_migration().map_err(|_| "Saved chats could not be safely inspected".to_owned())
}

#[tauri::command]
fn control_migrate_host_sessions(window: tauri::WebviewWindow, app: AppHandle, expected_digest: String) -> Result<SessionMigrationReceipt, String> {
    engine::main_window(&window)?;
    let actor = app.try_state::<ControlActor>().ok_or_else(|| "Native session storage is unavailable".to_owned())?;
    actor.handle().migrate_host_sessions(expected_digest).map_err(|_| "Saved chats changed during migration or could not be copied safely".to_owned())
}

/// Registers a folder selected by the trusted app window in the native registry.
#[tauri::command]
fn control_register_workspace(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
    path: String,
) -> Result<WorkspaceRecord, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .register_workspace(id, PathBuf::from(path))
        .map_err(|_| "Workspace folder was refused".to_owned())
}

/// Binds a session to an admitted native workspace and returns its revision.
#[tauri::command]
fn control_bind_workspace(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
    session_id: String,
    workspace_id: String,
    realm_id: Option<String>,
    mode: WorkspaceMode,
) -> Result<WorkspaceBinding, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .bind_workspace(id, session_id, workspace_id, realm_id, mode)
        .map_err(|_| "Workspace binding was refused".to_owned())
}

/// Rebinds a session only when its current revision matches the caller's view.
#[tauri::command]
fn control_rebind_workspace(
    window: tauri::WebviewWindow,
    app: AppHandle,
    session_id: String,
    expected_revision: u64,
    workspace_id: String,
    realm_id: Option<String>,
    mode: WorkspaceMode,
) -> Result<WorkspaceBinding, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .rebind_workspace(
            session_id,
            expected_revision,
            workspace_id,
            realm_id,
            mode,
        )
        .map_err(|_| "Workspace rebind was refused".to_owned())
}

/// Revokes a session's workspace grant at its expected revision.
#[tauri::command]
fn control_revoke_workspace(
    window: tauri::WebviewWindow,
    app: AppHandle,
    session_id: String,
    expected_revision: u64,
) -> Result<WorkspaceBinding, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .revoke_workspace(session_id, expected_revision)
        .map_err(|_| "Workspace revocation was refused".to_owned())
}

/// Creates a task with the actor's current grant for the named binding revision.
#[tauri::command]
fn control_create_root_in_workspace(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: RootCreate,
    session_id: String,
    binding_revision: u64,
) -> Result<RootTask, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .create_root_in_workspace(request, session_id, binding_revision)
        .map_err(|_| "Workspace task request was refused".to_owned())
}

/// Reads the actor-validated grant for a session at its expected binding revision.
#[tauri::command]
fn control_read_workspace_grant(
    window: tauri::WebviewWindow,
    app: AppHandle,
    session_id: String,
    expected_revision: u64,
) -> Result<WorkspaceGrant, String> {
    engine::main_window(&window)?;
    let actor = app
        .try_state::<ControlActor>()
        .ok_or_else(|| "Native task control is unavailable".to_owned())?;
    actor
        .handle()
        .read_workspace_grant(session_id, expected_revision)
        .map_err(|_| "Workspace grant is stale or unavailable".to_owned())
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

fn sidecar_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let data = app_data_dir(app);
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let triple = env!("VAK_TARGET_TRIPLE");
        worker::command(
            &root.join(format!("binaries/vaksb-{triple}{suffix}")),
            &root.join(format!("binaries/node-{triple}{suffix}")),
            &root.join("resources"),
            &data,
        )
    } else {
        let exe = std::env::current_exe().map_err(|_| "Cannot resolve desktop executable")?;
        let dir = exe.parent().ok_or("Desktop executable has no directory")?;
        let resources = app.path().resource_dir().map_err(|_| "Cannot resolve desktop resources")?.join("resources");
        worker::command(
            &dir.join(if cfg!(windows) { "vaksb.exe" } else { "vaksb" }),
            &dir.join(if cfg!(windows) { "node.exe" } else { "node" }),
            &resources,
            &data,
        )
    }
}

fn start(app: &tauri::AppHandle) -> Sidecar {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let control = app.try_state::<ControlActor>().map(|actor| actor.handle());
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let control = None;
    match sidecar_command(app) { Ok(cmd) => engine::start(cmd, control), Err(error) => Sidecar::failed(error) }
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
            control_task,
            control_provider_consents,
            control_provider_consent_request,
            control_provider_consent_decide,
            control_create_root,
            control_read_root,
            control_read_candidate_receipt,
            control_admit_host_session,
            control_release_host_session_admission,
            control_list_host_sessions,
            control_plan_host_session_migration,
            control_migrate_host_sessions,
            control_register_workspace,
            control_bind_workspace,
            control_rebind_workspace,
            control_revoke_workspace,
            control_create_root_in_workspace,
            control_read_workspace_grant,
            engine_request,
            engine_ack,
            engine_cancel,
            set_keep_running,
            autostart,
            save_canvas,
            show_admin,
            vault_presence,
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
