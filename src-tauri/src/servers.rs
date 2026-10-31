//! Local MCP servers and their installs for the contained worker. The worker
//! names an installed integration's script and the pinned package; Rust checks
//! both against the worker's integration folder, runs npm itself and hosts each
//! server under `vaksb worker` through a descriptor-3 bridge.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use serde::Deserialize;
use crate::control::ControlHandle;

const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_SERVERS: usize = 16;
const PINNED_MIN_AGE_DAYS: u64 = 14;
const REGISTRY: &str = "registry.npmjs.org";

/// Paths of the bundled runtime: the helper, Node and the resources folder.
#[derive(Clone)]
pub(crate) struct Runtime {
    pub helper: PathBuf,
    pub node: PathBuf,
    pub resources: PathBuf,
}

pub(crate) type Servers = Arc<Mutex<HashMap<String, (Child, ChildStdin)>>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Start {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// The framework's private home for the server: `<worker>/integrations/<id>/home`.
    #[serde(rename = "sandboxDir")]
    pub sandbox_dir: String,
    pub script: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Install {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub target: String,
    pub package: String,
    pub version: String,
}

fn valid_frame_id(id: &str, prefix: &str) -> bool {
    id.starts_with(prefix) && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `<worker>/integrations/<id>` for a path the worker named, or an error.
fn integration_dir(data_dir: &Path, named: &Path, leaf: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(data_dir.join("worker").join("integrations")).map_err(|_| "No integrations are installed".to_owned())?;
    let named = std::fs::canonicalize(named).map_err(|_| "The integration folder does not exist".to_owned())?;
    let dir = named.parent().filter(|_| named.file_name().is_some_and(|n| n == leaf)).ok_or("Unexpected integration folder")?;
    let id = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if dir.parent() != Some(root.as_path()) || id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Servers must live in the worker's integrations folder".into());
    }
    Ok(dir.to_path_buf())
}

fn valid_package(name: &str) -> bool {
    let body = match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') { Some((scope, pkg)) if !scope.is_empty() => pkg, _ => return false },
        None => name,
    };
    name.len() <= 214 && !body.is_empty() && !body.contains('/') && !name.starts_with(['.', '-']) && !name.contains("..")
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"@/-._~".contains(&b))
}

fn valid_version(version: &str) -> bool {
    let (core, pre) = version.split_once(['-', '+']).map_or((version, None), |(c, p)| (c, Some(p)));
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|p| !p.is_empty() && p.len() <= 64 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'))
}

/// The date `PINNED_MIN_AGE_DAYS` before now, as YYYY-MM-DD (UTC).
fn before_date(now_secs: u64) -> String {
    let days = (now_secs / 86_400 - PINNED_MIN_AGE_DAYS) as i64;
    // Civil-from-days (Howard Hinnant), valid for the proleptic Gregorian calendar.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Pinned, script-free install of an exact version from the public registry only.
pub(crate) fn install(runtime: &Runtime, data_dir: &Path, request: &Install, protocol: u8) -> Result<(), String> {
    if request.v != protocol || request.kind != "npm_install" || !valid_frame_id(&request.id, "npm-") { return Err("Invalid install request".into()); }
    if !valid_package(&request.package) || !valid_version(&request.version) { return Err(format!("{}: pin an exact version, not \"{}\"", request.package, request.version)); }
    if !crate::egress::approved(data_dir).iter().any(|h| h == REGISTRY) {
        return Err(format!("Network access to {REGISTRY} needs your approval: open this integration in Settings and choose Allow"));
    }
    let target = Path::new(&request.target);
    std::fs::create_dir_all(target).map_err(|_| "The install folder could not be created".to_owned())?;
    integration_dir(data_dir, target, "pkg")?;
    // A project .npmrc planted by the worker could redirect the registry or run scripts.
    let _ = std::fs::remove_file(target.join(".npmrc"));
    let npm_root = crate::private_store::root(data_dir).join("npm");
    let cache = npm_root.join("cache");
    std::fs::create_dir_all(&cache).map_err(|_| "The npm cache is unavailable".to_owned())?;
    // Empty, distinct user and global configs: npm refuses one file for both.
    let (user_config, global_config) = (npm_root.join("user.npmrc"), npm_root.join("global.npmrc"));
    std::fs::write(&user_config, b"").and_then(|_| std::fs::write(&global_config, b"")).map_err(|_| "The npm configuration is unavailable".to_owned())?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let output = Command::new(&runtime.node)
        .arg(runtime.resources.join("npm/bin/npm-cli.js"))
        .args(["install", &format!("{}@{}", request.package, request.version), "--prefix"]).arg(target)
        .args(["--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", &format!("--before={}", before_date(now))])
        .arg(format!("--registry=https://{REGISTRY}/"))
        .arg(format!("--userconfig={}", user_config.display())).arg(format!("--globalconfig={}", global_config.display()))
        .arg(format!("--cache={}", cache.display()))
        .current_dir(target)
        .env_clear().env("PATH", "/usr/bin:/bin").env("HOME", &cache)
        .stdin(Stdio::null()).output()
        .map_err(|_| "npm could not be started".to_owned())?;
    if output.status.success() { return Ok(()); }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr.lines().find(|l| l.contains("ERR!")).unwrap_or(stderr.trim()).chars().take(400).collect())
}

/// Starts one server under `vaksb worker`; returns its stdin and the child.
pub(crate) fn start(runtime: &Runtime, data_dir: &Path, control: Option<&ControlHandle>, request: &Start, protocol: u8) -> Result<(Child, ChildStdin), String> {
    if request.v != protocol || request.kind != "server_start" || !valid_frame_id(&request.id, "srv-") { return Err("Invalid server request".into()); }
    if request.args.len() > 64 || request.env.len() > 32 || request.args.iter().chain(request.env.values()).any(|a| a.len() > 4096 || a.contains('\0')) {
        return Err("Server arguments are too large".into());
    }
    let home = Path::new(&request.sandbox_dir);
    std::fs::create_dir_all(home).map_err(|_| "The server folder could not be created".to_owned())?;
    let dir = integration_dir(data_dir, home, "home")?;
    let pkg = dir.join("pkg");
    let script = std::fs::canonicalize(&request.script).map_err(|_| "The server script is not installed".to_owned())?;
    if !script.starts_with(std::fs::canonicalize(&pkg).map_err(|_| "The server package is not installed".to_owned())?) {
        return Err("Only installed integration packages can run".into());
    }
    // Absolute arguments are folders the server may use; each must be one the user registered.
    let registered: Vec<PathBuf> = control.and_then(|c| c.list_workspaces().ok()).unwrap_or_default().into_iter().map(|w| w.canonical_path).collect();
    let mut folders = Vec::new();
    for arg in request.args.iter().filter(|a| a.starts_with('/')) {
        let folder = std::fs::canonicalize(arg).map_err(|_| format!("{arg}: this folder does not exist"))?;
        if !registered.contains(&folder) { return Err(format!("{arg}: add this folder with 'Work in folder' before giving it to a server")); }
        folders.push(folder);
    }
    for (name, value) in &request.env {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') || ["PATH", "HOME", "TMPDIR", "NODE_OPTIONS"].contains(&name.as_str()) {
            return Err(format!("{name}: servers cannot set this variable"));
        }
        if value.starts_with('/') && !Path::new(value).starts_with(&dir) { return Err(format!("{name}: paths must stay in the server's own folder")); }
    }
    let mut cmd = Command::new(&runtime.helper);
    cmd.env_clear().env("PATH", "/usr/bin:/bin").arg("worker")
        .arg("--cwd").arg(home)
        .arg("--read").arg(&runtime.resources)
        .arg("--write").arg(&dir);
    for folder in &folders { cmd.arg("--write").arg(folder); }
    for (name, value) in [("PATH", "/usr/bin:/bin".to_owned()), ("HOME", home.to_string_lossy().into_owned()), ("TMPDIR", home.to_string_lossy().into_owned()), ("OPENSSL_CONF", "/dev/null".to_owned())] {
        cmd.arg("--env").arg(format!("{name}={value}"));
    }
    for (name, value) in &request.env { cmd.arg("--env").arg(format!("{name}={value}")); }
    cmd.arg("--command").arg(&runtime.node).arg("--")
        .arg("--disable-warning=ExperimentalWarning").arg(runtime.resources.join("mcp-bridge.mjs")).arg(&script).args(&request.args);
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|_| "Sandbox helper could not be started. Rebuild or reinstall the app.".to_owned())?;
    let stdin = child.stdin.take().ok_or("Server input is unavailable")?;
    Ok((child, stdin))
}

/// Relays a started server's output as frames until it exits.
pub(crate) fn relay(servers: Servers, id: String, mut child_out: impl Read + Send + 'static, child_err: impl Read + Send + 'static, send: impl Fn(serde_json::Value) + Send + Sync + 'static, protocol: u8) {
    let send = Arc::new(send);
    let log = send.clone();
    let log_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(child_err).lines().map_while(Result::ok).take(10_000) {
            log(serde_json::json!({ "v": protocol, "id": log_id, "type": "server_log", "line": line.chars().take(2048).collect::<String>() }));
        }
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(&mut child_out);
        loop {
            let mut line = Vec::new();
            match reader.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > MAX_LINE => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(line.strip_suffix(b"\n").unwrap_or(&line)).into_owned();
                    send(serde_json::json!({ "v": protocol, "id": id, "type": "server_line", "line": text }));
                }
            }
        }
        let code = servers.lock().unwrap().remove(&id).and_then(|(mut child, _)| {
            let _ = child.kill();
            child.wait().ok().and_then(|s| s.code())
        });
        send(serde_json::json!({ "v": protocol, "id": id, "type": "server_exit", "code": code }));
    });
}

pub(crate) fn input(servers: &Servers, id: &str, line: &str) -> Result<(), String> {
    if line.len() > MAX_LINE || line.contains('\n') { return Err("Server input line is invalid".into()); }
    let mut map = servers.lock().unwrap();
    let (_, stdin) = map.get_mut(id).ok_or("The server is not running")?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).map_err(|_| "The server stopped".to_owned())
}

pub(crate) fn stop(servers: &Servers, id: &str) {
    // Dropping stdin ends the helper's owner connection; kill makes it immediate.
    if let Some((mut child, _)) = servers.lock().unwrap().remove(id) {
        let _ = child.kill();
        std::thread::spawn(move || { let _ = child.wait(); });
    }
}

pub(crate) fn capacity_left(servers: &Servers) -> bool { servers.lock().unwrap().len() < MAX_SERVERS }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_requests_are_exact_pins_of_well_formed_packages() {
        for ok in ["@modelcontextprotocol/server-filesystem", "left-pad", "@scope/a.b_c-d"] { assert!(valid_package(ok), "{ok}"); }
        for bad in ["", "@scope", "@/x", "../x", "x y", "X", "a/../b", "--registry=evil"] { assert!(!valid_package(bad), "{bad}"); }
        for ok in ["2026.8.31", "1.2.3", "0.1.0-alpha.1"] { assert!(valid_version(ok), "{ok}"); }
        for bad in ["^1.2.3", "latest", "1.2", "1.x.3", "1.2.3-", "~1.0.0"] { assert!(!valid_version(bad), "{bad}"); }
    }

    #[test]
    fn pinned_install_date_is_fourteen_days_back_in_utc() {
        // 2026-10-25T12:00:00Z, as in the framework's own pin test.
        assert_eq!(before_date(1_792_929_600), "2026-10-11");
        assert_eq!(before_date(951_782_400 + 14 * 86_400), "2000-02-29");
    }

    #[test]
    fn servers_must_live_in_the_worker_integrations_folder() {
        let base = std::env::temp_dir().join(format!("vak-srv-{}", std::process::id()));
        let data = base.join("data");
        let home = data.join("worker/integrations/files/home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(base.join("elsewhere/x/home")).unwrap();
        assert!(integration_dir(&data, &home, "home").unwrap().ends_with("integrations/files"));
        assert!(integration_dir(&data, &base.join("elsewhere/x/home"), "home").is_err());
        assert!(integration_dir(&data, &home, "pkg").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Live: `cargo test --lib local_server_runs_under_the_helper_through_the_bridge -- --ignored`.
    #[test]
    #[ignore = "runs the bundled sandbox helper and Node"]
    fn local_server_runs_under_the_helper_through_the_bridge() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let base = std::env::temp_dir().join(format!("vak-srv-live-{}", std::process::id()));
        let (data, resources) = (base.join("data"), base.join("resources"));
        let dir = data.join("worker/integrations/echo");
        std::fs::create_dir_all(dir.join("pkg")).unwrap();
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::copy(manifest.join("../sidecar/mcp-bridge.ts"), resources.join("mcp-bridge.mjs")).unwrap();
        std::fs::copy(manifest.join("../framework/packages/mcp/test/fixtures/echo-server.mjs"), dir.join("pkg/server.mjs")).unwrap();
        std::fs::write(base.join("outside"), "canary").unwrap();
        let triple = env!("VAK_TARGET_TRIPLE");
        let runtime = Runtime { helper: manifest.join(format!("binaries/vaksb-{triple}")), node: manifest.join(format!("binaries/node-{triple}")), resources };
        let request = Start {
            v: 2, id: "srv-live".into(), kind: "server_start".into(), sandbox_dir: dir.join("home").to_string_lossy().into(),
            script: dir.join("pkg/server.mjs").to_string_lossy().into(), args: vec![], env: BTreeMap::from([("ECHO_TOKEN".into(), "t".into())]),
        };
        let (mut child, mut stdin) = start(&runtime, &data, None, &request, 2).unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut ask = |msg: &str| { writeln!(stdin, "{msg}").unwrap(); let mut line = String::new(); out.read_line(&mut line).unwrap(); line };
        assert!(ask(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).contains("\"env\""));
        let env = ask(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"env","arguments":{}}}"#);
        assert!(env.contains("ECHO_TOKEN") && !env.contains("OPENAI"), "{env}");
        drop(stdin);
        let _ = child.wait();
        let mut bad = request;
        bad.args = vec![base.join("outside").to_string_lossy().into()];
        assert!(start(&runtime, &data, None, &bad, 2).unwrap_err().contains("Work in folder"));
        std::fs::remove_dir_all(base).unwrap();
    }
}
