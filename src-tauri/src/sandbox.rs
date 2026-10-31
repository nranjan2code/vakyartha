//! Command runs and Realms for the contained worker. The worker names a chat
//! session (or none, for the Sandbox page folder) and the helper arguments; Rust
//! resolves the folder from its own registry, owns the Realm store and runs the
//! helper, so the worker never reads a project or chooses a path.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use crate::control::ControlHandle;
use crate::control::registry::{BindingState, WorkspaceMode};

const MAX_OUTPUT: usize = 256 * 1024;
const FOLDER_STORE: &str = "sandbox-folder.json";
const REALM_OPS: &[&str] = &["list", "status", "snapshot", "read", "exec", "promote", "rollback", "recover", "destroy"];
/// Stands for the session's Realm in worker-built arguments; Rust substitutes the real ID.
const REALM_TOKEN: &str = "{realm}";

pub(crate) struct Context {
    pub helper: PathBuf,
    pub data_dir: PathBuf,
    pub control: Option<ControlHandle>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SandboxRequest {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub session: Option<String>,
    pub op: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(rename = "timeoutSeconds", default)]
    pub timeout_seconds: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The folder a request may touch, and the chat binding it came from.
struct Target {
    root: PathBuf,
    binding: Option<crate::control::registry::WorkspaceBinding>,
}

fn store_root(data_dir: &Path) -> PathBuf { crate::private_store::root(data_dir) }

pub(crate) fn folder(data_dir: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(store_root(data_dir).join(FOLDER_STORE)).ok()?;
    serde_json::from_slice::<Option<PathBuf>>(&bytes).ok().flatten()
}

/// Main window only. Admission refuses system, private and reserved folders.
pub(crate) fn set_folder(data_dir: &Path, path: Option<&Path>) -> Result<Option<PathBuf>, String> {
    let canonical = match path {
        Some(path) => {
            let policy = crate::control::folder::WorkspaceAdmissionPolicy::new(data_dir).map_err(|_| "Folder policy is unavailable".to_owned())?;
            Some(policy.admit(path).map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => "This folder does not exist.".to_owned(),
                std::io::ErrorKind::PermissionDenied => error.to_string(),
                _ => format!("This folder cannot be used: {error}"),
            })?.0)
        }
        None => None,
    };
    let root = store_root(data_dir);
    crate::private_store::ensure_root(&root).map_err(|_| "Folder store is unavailable".to_owned())?;
    let temp = root.join(format!("{FOLDER_STORE}.tmp"));
    std::fs::write(&temp, serde_json::to_vec(&canonical).unwrap()).and_then(|_| std::fs::rename(&temp, root.join(FOLDER_STORE)))
        .map_err(|_| "The folder could not be saved".to_owned())?;
    Ok(canonical)
}

fn relative(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.starts_with('/') && !value.contains('\0') && !value.split(['/', '\\']).any(|part| part == "..")
}

/// Realm arguments come from the worker; paths and stores never do. For exec,
/// only the part before `--` is Realm arguments; the rest is the command line.
fn realm_args_admissible(args: &[String]) -> bool {
    let realm_part = match args.first().map(String::as_str) {
        Some("exec") => match args.iter().position(|a| a == "--") { Some(end) if end + 1 < args.len() => &args[..end], _ => return false },
        _ => args,
    };
    args.first().is_some_and(|op| REALM_OPS.contains(&op.as_str()))
        && args.len() <= 260
        && args.iter().all(|arg| arg.len() <= 4096 && !arg.contains('\0'))
        && realm_part.iter().all(|arg| {
            !arg.starts_with('/')
                && !arg.split(['/', '\\', '=']).any(|part| part == "..")
                && !["--project", "--store", "--workspace"].iter().any(|flag| arg.starts_with(flag))
        })
}

fn valid_realm_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() && !b.is_ascii_uppercase() })
}

impl SandboxRequest {
    fn admissible(&self, protocol: u8) -> bool {
        self.v == protocol && self.kind == "sandbox_request" && self.id.starts_with("sbx-") && self.id.len() <= 64
            && self.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && self.session.as_deref().is_none_or(|s| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
            && self.cwd.as_deref().is_none_or(|cwd| cwd == "." || relative(cwd))
            && self.timeout_seconds.is_none_or(|t| (1..=300).contains(&t))
    }
}

fn target(ctx: &Context, session: Option<&str>) -> Result<Target, String> {
    let Some(session) = session else {
        let root = folder(&ctx.data_dir).ok_or("Choose a project folder in Settings → Sandbox before running commands.")?;
        return Ok(Target { root, binding: None });
    };
    let control = ctx.control.as_ref().ok_or("Folder bindings are unavailable")?;
    let binding = control.get_workspace_binding(session.to_owned()).map_err(|_| "Folder bindings are unavailable".to_owned())?
        .filter(|b| b.state == BindingState::Admitted)
        .ok_or("No folder is admitted for this chat. Select 'Work in folder' to enable command execution.")?;
    let workspace = control.get_workspace(binding.workspace_id.clone()).map_err(|_| "Folder bindings are unavailable".to_owned())?
        .ok_or("This chat's folder is no longer registered.")?;
    Ok(Target { root: workspace.canonical_path, binding: Some(binding) })
}

fn helper(ctx: &Context, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let store = store_root(&ctx.data_dir).join("realms");
    std::fs::create_dir_all(&store).map_err(|_| "Realm store is unavailable".to_owned())?;
    let mut child = Command::new(&ctx.helper)
        .args(args)
        .current_dir(&store)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|_| "Sandbox helper could not be started. Rebuild or reinstall the app.".to_owned())?;
    let collect = |mut pipe: Box<dyn Read + Send>| std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = pipe.by_ref().take(MAX_OUTPUT as u64 + 1).read_to_end(&mut out);
        out
    });
    let stdout = collect(Box::new(child.stdout.take().unwrap()));
    let stderr = collect(Box::new(child.stderr.take().unwrap()));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "Sandbox helper failed".to_owned())? { break status; }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Sandbox operation exceeded its {} second limit. Inspect its status before retrying.", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (stdout, stderr) = (stdout.join().unwrap_or_default(), stderr.join().unwrap_or_default());
    if stdout.len() + stderr.len() > MAX_OUTPUT { return Err("Sandbox output exceeded the 256 KiB limit.".into()); }
    Ok(Output { code: status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&stdout).into_owned(), stderr: String::from_utf8_lossy(&stderr).into_owned() })
}

fn realm(ctx: &Context, args: &[&str], timeout: Duration) -> Result<serde_json::Value, String> {
    let store = store_root(&ctx.data_dir).join("realms");
    let store = store.to_string_lossy();
    let mut full = vec!["--store", &store, "realm"];
    full.extend_from_slice(args);
    let out = helper(ctx, &full, timeout)?;
    if out.code != 0 { return Err(if out.stderr.trim().is_empty() { format!("Realm helper exited with code {}.", out.code) } else { out.stderr.trim().to_owned() }); }
    serde_json::from_str(&out.stdout).map_err(|_| "Realm helper returned an unreadable response".to_owned())
}

fn create_realm(ctx: &Context, target: &Target) -> Result<String, String> {
    let project = format!("--project={}", target.root.to_string_lossy());
    let created = realm(ctx, &["create", &project], Duration::from_secs(120))?;
    let id = created["realm_id"].as_str().filter(|id| valid_realm_id(id)).ok_or("Realm helper returned no Realm ID")?.to_owned();
    if let (Some(binding), Some(control)) = (&target.binding, &ctx.control) {
        control.rebind_workspace(binding.session_id.clone(), binding.revision, binding.workspace_id.clone(), Some(id.clone()), binding.mode)
            .map_err(|_| "This chat's folder binding changed; retry the command".to_owned())?;
    }
    Ok(id)
}

/// A Realm may be used only for the folder this request resolves to.
fn check_realm_project(ctx: &Context, id: &str, target: &Target) -> Result<(), String> {
    let status = realm(ctx, &["status", id], Duration::from_secs(45))?;
    let base = status["realm"]["base_path"].as_str().and_then(|p| std::fs::canonicalize(p).ok());
    if base.as_deref() != Some(target.root.as_path()) { return Err("This Realm belongs to a different project.".into()); }
    Ok(())
}

fn exec_output(value: serde_json::Value) -> Output {
    let result = &value["result"];
    Output {
        code: result["exit_code"].as_i64().unwrap_or(-1) as i32,
        stdout: result["stdout"].as_str().unwrap_or_default().to_owned(),
        stderr: result["stderr"].as_str().unwrap_or_default().to_owned(),
    }
}

/// Runs one admitted request. Blocking: call from a blocking thread.
pub(crate) fn handle(ctx: &Context, request: &SandboxRequest, protocol: u8) -> Result<serde_json::Value, String> {
    if !request.admissible(protocol) { return Err("Invalid sandbox request".into()); }
    if !cfg!(target_os = "macos") && request.op != "binding" { return Err("OS-isolated command execution is currently available only on macOS.".into()); }
    let session = request.session.as_deref();
    match request.op.as_str() {
        // What the model may be told about this chat's folder; no folder means none is admitted.
        "binding" => Ok(match session.map(|s| target(ctx, Some(s))) {
            Some(Ok(Target { root, binding: Some(b) })) => serde_json::json!({
                "folder": root, "mode": if b.mode == WorkspaceMode::Direct { "direct" } else { "copy_review" }, "realmId": b.realm_id,
            }),
            _ => serde_json::Value::Null,
        }),
        "run" => {
            let (command, argv) = request.args.split_first().ok_or("Provide a command.")?;
            if command.is_empty() || command.len() > 256 || command.starts_with('-') || argv.len() > 64 || request.args.iter().map(String::len).sum::<usize>() > 16 * 1024 {
                return Err("Provide a command and at most 64 arguments, no more than 16 KiB total.".into());
            }
            let target = target(ctx, session)?;
            let cwd = request.cwd.clone().unwrap_or_else(|| ".".into());
            let seconds = request.timeout_seconds.unwrap_or(30);
            let timeout = Duration::from_secs(seconds + 15);
            let cwd_flag = format!("--cwd={cwd}");
            let mut exec: Vec<&str> = vec!["exec", "", &cwd_flag, "--"];
            exec.push(command);
            exec.extend(argv.iter().map(String::as_str));
            match target.binding.as_ref().map(|b| b.mode) {
                Some(WorkspaceMode::Direct) => {
                    let root = target.root.to_string_lossy();
                    let work = target.root.join(&cwd);
                    let work = work.to_string_lossy();
                    let seconds = seconds.to_string();
                    let max = MAX_OUTPUT.to_string();
                    let mut run = vec!["run", "--cwd", &work, "--workspace", &root, "--timeout-seconds", &seconds, "--max-output-bytes", &max, "--", command];
                    run.extend(argv.iter().map(String::as_str));
                    serde_json::to_value(helper(ctx, &run, timeout)?).map_err(|e| e.to_string())
                }
                Some(WorkspaceMode::CopyReview) => {
                    let id = match target.binding.as_ref().and_then(|b| b.realm_id.clone()) { Some(id) => id, None => create_realm(ctx, &target)? };
                    exec[1] = &id;
                    serde_json::to_value(exec_output(realm(ctx, &exec, timeout)?)).map_err(|e| e.to_string())
                }
                // The Sandbox page folder: a fresh copy per run, discarded afterwards.
                None => {
                    let id = create_realm(ctx, &target)?;
                    exec[1] = &id;
                    let result = realm(ctx, &exec, timeout);
                    let _ = realm(ctx, &["destroy", &id], Duration::from_secs(60));
                    serde_json::to_value(exec_output(result?)).map_err(|e| e.to_string())
                }
            }
        }
        // App runs and skill rehearsals: a folder the worker staged inside its own data.
        "run_scratch" => {
            let (command, argv) = request.args.split_first().ok_or("Provide a command.")?;
            let worker = std::fs::canonicalize(ctx.data_dir.join("worker")).map_err(|_| "Worker data folder is unavailable".to_owned())?;
            let rel = request.cwd.as_deref().filter(|c| *c != ".").ok_or("Provide the scratch folder.")?;
            let root = std::fs::canonicalize(worker.join(rel)).map_err(|_| "The scratch folder does not exist.".to_owned())?;
            if !root.starts_with(&worker) || root == worker { return Err("Scratch runs must stay inside the worker's data folder.".into()); }
            let root = root.to_string_lossy();
            let seconds = request.timeout_seconds.unwrap_or(30).to_string();
            let max = MAX_OUTPUT.to_string();
            let mut run = vec!["run", "--cwd", &root, "--workspace", &root, "--timeout-seconds", &seconds, "--max-output-bytes", &max, "--", command];
            run.extend(argv.iter().map(String::as_str));
            serde_json::to_value(helper(ctx, &run, Duration::from_secs(request.timeout_seconds.unwrap_or(30) + 15))?).map_err(|e| e.to_string())
        }
        "realm_create" => {
            let target = target(ctx, session)?;
            if target.binding.as_ref().is_some_and(|b| b.mode == WorkspaceMode::Direct) { return Err("This chat edits its folder directly; Realms are not used.".into()); }
            Ok(serde_json::json!({ "realm_id": create_realm(ctx, &target)? }))
        }
        "realm" => {
            if !realm_args_admissible(&request.args) { return Err("Invalid Realm operation".into()); }
            if request.args[0] == "list" { return realm(ctx, &["list"], Duration::from_secs(45)); }
            let target = target(ctx, session)?;
            if target.binding.as_ref().is_some_and(|b| b.mode == WorkspaceMode::Direct) { return Err("This chat edits its folder directly; Realms are not used.".into()); }
            let named = request.args.iter().find(|a| valid_realm_id(a)).cloned();
            let id = if request.args.iter().any(|a| a == REALM_TOKEN) {
                match target.binding.as_ref().and_then(|b| b.realm_id.clone()) { Some(id) => id, None => create_realm(ctx, &target)? }
            } else {
                named.ok_or("Provide a valid Realm ID.")?
            };
            check_realm_project(ctx, &id, &target)?;
            let args: Vec<&str> = request.args.iter().map(|a| if a == REALM_TOKEN { id.as_str() } else { a.as_str() }).collect();
            let timeout = Duration::from_secs(request.timeout_seconds.unwrap_or(45) + 15);
            let result = realm(ctx, &args, timeout)?;
            if request.args[0] == "destroy" && let (Some(binding), Some(control)) = (&target.binding, &ctx.control) && binding.realm_id.as_deref() == Some(id.as_str()) {
                let _ = control.rebind_workspace(binding.session_id.clone(), binding.revision, binding.workspace_id.clone(), None, binding.mode);
            }
            Ok(result)
        }
        _ => Err("Unsupported sandbox operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(op: &str, args: &[&str]) -> SandboxRequest {
        SandboxRequest { v: 2, id: "sbx-1".into(), kind: "sandbox_request".into(), session: None, op: op.into(), args: args.iter().map(|a| a.to_string()).collect(), cwd: None, timeout_seconds: None }
    }

    #[test]
    fn realm_arguments_never_carry_paths_stores_or_create() {
        let ok = |args: &[&str]| realm_args_admissible(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>());
        assert!(ok(&["snapshot", "{realm}", "--offset=0"]));
        assert!(ok(&["promote", "{realm}", "--fingerprint=ab", "--paths=src/a.ts"]));
        assert!(ok(&["read", "--offset=0", "--", "{realm}", "src/a.ts"]));
        assert!(!ok(&["create", "--project=/etc"]));
        assert!(ok(&["exec", "{realm}", "--cwd=src", "--", "/bin/sh", "-c", "ls ../.."]));
        assert!(!ok(&["exec", "{realm}", "--cwd=../up", "--", "ls"]));
        assert!(!ok(&["exec", "{realm}", "--project=/etc", "--", "ls"]));
        assert!(!ok(&["status", "/etc/passwd"]));
        assert!(!ok(&["read", "--", "{realm}", "../outside"]));
        assert!(!ok(&["promote", "{realm}", "--paths=../x"]));
        assert!(!ok(&["list", "--store=/tmp/elsewhere"]));
        assert!(!ok(&[]));
    }

    #[test]
    fn requests_are_bounded_before_any_folder_is_resolved() {
        assert!(request("run", &["ls"]).admissible(2));
        let mut bad = request("run", &["ls"]);
        bad.cwd = Some("../up".into());
        assert!(!bad.admissible(2));
        let mut bad = request("run", &["ls"]);
        bad.session = Some("../s".into());
        assert!(!bad.admissible(2));
        let mut bad = request("run", &["ls"]);
        bad.timeout_seconds = Some(301);
        assert!(!bad.admissible(2));
        assert!(valid_realm_id("0f8e2c1a-1111-4222-8333-944455556666"));
        assert!(!valid_realm_id("{realm}"));
    }

    #[test]
    fn default_folder_is_admitted_and_persisted_natively() {
        let base = std::env::temp_dir().join(format!("vak-sbx-{}", std::process::id()));
        let data = base.join("data");
        let project = base.join("project");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        assert!(folder(&data).is_none());
        let saved = set_folder(&data, Some(&project)).unwrap().unwrap();
        assert_eq!(folder(&data), Some(saved));
        assert!(set_folder(&data, Some(&base.join("missing"))).unwrap_err().contains("does not exist"));
        assert!(set_folder(&data, Some(&data)).is_err());
        assert_eq!(set_folder(&data, None).unwrap(), None);
        assert!(folder(&data).is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Live: `cargo test --lib sandbox_runs_a_command_on_a_fresh_copy -- --ignored`.
    #[test]
    #[ignore = "runs the bundled sandbox helper"]
    fn sandbox_runs_a_command_on_a_fresh_copy() {
        let base = std::env::temp_dir().join(format!("vak-sbx-live-{}", std::process::id()));
        let (data, project) = (base.join("data"), base.join("project"));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("a.txt"), "hello").unwrap();
        set_folder(&data, Some(&project)).unwrap();
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/vaksb-{}", env!("VAK_TARGET_TRIPLE")));
        let ctx = Context { helper, data_dir: data.clone(), control: None };
        let result = handle(&ctx, &request("run", &["/bin/sh", "-c", "cat a.txt; echo changed > a.txt"]), 2).unwrap();
        assert_eq!(result["code"], 0, "{result}");
        assert_eq!(result["stdout"], "hello");
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "hello");
        assert_eq!(handle(&ctx, &request("realm", &["list"]), 2).unwrap()["realms"].as_array().map(Vec::len).unwrap_or(0), 0);
        std::fs::remove_dir_all(base).unwrap();
    }
}
