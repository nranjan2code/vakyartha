//! Local MCP servers and their installs for the contained worker. The worker
//! names an installed integration's script and the pinned package; Rust checks
//! both against the worker's integration folder, runs npm itself and hosts each
//! server under `vaksb worker` through a descriptor-3 bridge.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
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

pub(crate) type Servers = Arc<Mutex<HashMap<String, Hosted>>>;

/// A running server, its input, and the broker that lives exactly as long as it.
pub(crate) struct Hosted {
    pub child: Child,
    pub stdin: ChildStdin,
    pub _broker: Option<Broker>,
}

/// An HTTPS CONNECT broker on a loopback port for one server. The sandbox lets
/// the server reach only this port; the broker tunnels only to that server's
/// approved hosts at public addresses, and only for the bearer of its token.
pub(crate) struct Broker {
    pub port: u16,
    pub token: String,
    stop: Arc<AtomicBool>,
}

impl Drop for Broker {
    fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).map_err(|_| "No secure randomness for the broker".to_owned())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn broker(data_dir: PathBuf, hosts: &'static [String]) -> Result<Broker, String> {
    let listener = TcpListener::bind("127.0.0.1:0").and_then(|l| l.set_nonblocking(true).map(|_| l)).map_err(|_| "The server's network broker could not start".to_owned())?;
    let port = listener.local_addr().map_err(|_| "The server's network broker could not start".to_owned())?.port();
    let token = random_token()?;
    let expected = crate::reasoner_supervisor::base64(format!("vak:{token}").as_bytes());
    let stop = Arc::new(AtomicBool::new(false));
    let running = stop.clone();
    std::thread::spawn(move || {
        while !running.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((client, _)) => {
                    let (expected, data_dir) = (expected.clone(), data_dir.clone());
                    std::thread::spawn(move || { let _ = tunnel(client, &expected, hosts, &data_dir); });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
                Err(_) => break,
            }
        }
    });
    Ok(Broker { port, token, stop })
}

/// The CONNECT request's host when it names an allowed host on port 443 with the
/// broker's Basic credential (the scheme is case-insensitive, the credential exact).
fn connect_target(head: &str, expected_credential: &str, hosts: &[String]) -> Result<String, &'static str> {
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split(' ');
    let (method, target) = (request.next().unwrap_or_default(), request.next().unwrap_or_default());
    let authorized = lines.filter_map(|l| l.split_once(':')).any(|(name, value)| name.trim().eq_ignore_ascii_case("proxy-authorization")
        && value.trim().split_once(' ').is_some_and(|(scheme, credential)| scheme.eq_ignore_ascii_case("basic") && credential.trim() == expected_credential));
    if !authorized { return Err("407 Proxy Authentication Required"); }
    let host = target.strip_suffix(":443").map(str::to_ascii_lowercase).ok_or("403 Forbidden")?;
    if method != "CONNECT" || !hosts.contains(&host) { return Err("403 Forbidden"); }
    Ok(host)
}

fn tunnel(mut client: TcpStream, expected: &str, hosts: &[String], data_dir: &Path) -> std::io::Result<()> {
    client.set_nonblocking(false)?;
    client.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 || client.read(&mut byte)? == 0 { return Ok(()); }
        head.push(byte[0]);
    }
    let refuse = |client: &mut TcpStream, status: &str| client.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes());
    let host = match connect_target(&String::from_utf8_lossy(&head), expected, hosts) {
        Ok(host) => host,
        Err(status) => return refuse(&mut client, status),
    };
    if !crate::egress::approved(data_dir).contains(&host) { return refuse(&mut client, "403 Forbidden"); }
    let Ok(addrs) = crate::control::broker::resolve_public_addresses(&host) else { return refuse(&mut client, "502 Bad Gateway") };
    let Some(upstream) = addrs.iter().find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(10)).ok()) else { return refuse(&mut client, "502 Bad Gateway") };
    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
    client.set_read_timeout(None)?;
    let (mut client_read, mut upstream_write) = (client.try_clone()?, upstream.try_clone()?);
    let forward = std::thread::spawn(move || { let _ = std::io::copy(&mut client_read, &mut upstream_write); let _ = upstream_write.shutdown(std::net::Shutdown::Write); });
    let (mut upstream_read, mut client_write) = (upstream, client);
    let _ = std::io::copy(&mut upstream_read, &mut client_write);
    let _ = client_write.shutdown(std::net::Shutdown::Write);
    let _ = forward.join();
    Ok(())
}

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
pub(crate) fn start(runtime: &Runtime, service: &str, data_dir: &Path, control: Option<&ControlHandle>, request: &Start, protocol: u8) -> Result<Hosted, String> {
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
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') || name.ends_with("_PROXY") || ["PATH", "HOME", "TMPDIR", "NODE_OPTIONS", "NODE_USE_ENV_PROXY"].contains(&name.as_str()) {
            return Err(format!("{name}: servers cannot set this variable"));
        }
        if value.starts_with('/') && !Path::new(value).starts_with(&dir) { return Err(format!("{name}: paths must stay in the server's own folder")); }
    }
    let integration = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let network = crate::egress::network_server(integration);
    // Declared key variables arrive as the presence marker; only this server's own vault keys replace them.
    let mut env = BTreeMap::new();
    for (name, value) in &request.env {
        if value != "native-vault" { env.insert(name.clone(), value.clone()); continue; }
        if let Some(account) = network.and_then(|n| n.env.get(name))
            && let Some(secret) = crate::vault::get(service, account, data_dir).map_err(|_| "The credential vault is unavailable".to_owned())?.filter(|v| !v.is_empty()) {
            env.insert(name.clone(), secret);
        }
    }
    let broker = network.map(|n| broker(data_dir.to_path_buf(), &n.hosts)).transpose()?;
    if let Some(broker) = &broker {
        let proxy = format!("http://vak:{}@127.0.0.1:{}", broker.token, broker.port);
        env.insert("HTTPS_PROXY".into(), proxy.clone());
        env.insert("HTTP_PROXY".into(), proxy);
        env.insert("NODE_USE_ENV_PROXY".into(), "1".into());
    }
    let mut cmd = Command::new(&runtime.helper);
    cmd.env_clear().env("PATH", "/usr/bin:/bin").arg("worker")
        .arg("--cwd").arg(home)
        .arg("--read").arg(&runtime.resources)
        .arg("--write").arg(&dir);
    for folder in &folders { cmd.arg("--write").arg(folder); }
    if let Some(broker) = &broker { cmd.arg("--allow-localhost-port").arg(broker.port.to_string()); }
    for (name, value) in [("PATH", "/usr/bin:/bin".to_owned()), ("HOME", home.to_string_lossy().into_owned()), ("TMPDIR", home.to_string_lossy().into_owned()), ("OPENSSL_CONF", "/dev/null".to_owned())] {
        cmd.arg("--env").arg(format!("{name}={value}"));
    }
    for (name, value) in &env { cmd.arg("--env").arg(format!("{name}={value}")); }
    cmd.arg("--command").arg(&runtime.node).arg("--")
        .arg("--disable-warning=ExperimentalWarning").arg(runtime.resources.join("mcp-bridge.mjs")).arg(&script).args(&request.args);
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|_| "Sandbox helper could not be started. Rebuild or reinstall the app.".to_owned())?;
    let stdin = child.stdin.take().ok_or("Server input is unavailable")?;
    Ok(Hosted { child, stdin, _broker: broker })
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
        let code = servers.lock().unwrap().remove(&id).and_then(|mut hosted| {
            let _ = hosted.child.kill();
            hosted.child.wait().ok().and_then(|s| s.code())
        });
        send(serde_json::json!({ "v": protocol, "id": id, "type": "server_exit", "code": code }));
    });
}

pub(crate) fn input(servers: &Servers, id: &str, line: &str) -> Result<(), String> {
    if line.len() > MAX_LINE || line.contains('\n') { return Err("Server input line is invalid".into()); }
    let mut map = servers.lock().unwrap();
    let stdin = &mut map.get_mut(id).ok_or("The server is not running")?.stdin;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).map_err(|_| "The server stopped".to_owned())
}

pub(crate) fn stop(servers: &Servers, id: &str) {
    // Dropping stdin ends the helper's owner connection; kill makes it immediate.
    if let Some(mut hosted) = servers.lock().unwrap().remove(id) {
        let _ = hosted.child.kill();
        std::thread::spawn(move || { let _ = hosted.child.wait(); });
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
    fn broker_tunnels_only_authorized_connects_to_listed_hosts() {
        let hosts = vec!["api.notion.com".to_owned()];
        let auth = "dmFrOnRvaw==";
        assert_eq!(connect_target("CONNECT api.notion.com:443 HTTP/1.1\r\nProxy-Authorization: basic dmFrOnRvaw==\r\n\r\n", auth, &hosts), Ok("api.notion.com".into()));
        assert!(connect_target("CONNECT api.notion.com:443 HTTP/1.1\r\n\r\n", auth, &hosts).unwrap_err().starts_with("407"));
        assert!(connect_target("CONNECT api.notion.com:443 HTTP/1.1\r\nProxy-Authorization: Basic DMFRONRVAW==\r\n\r\n", auth, &hosts).unwrap_err().starts_with("407"));
        assert!(connect_target("CONNECT evil.example:443 HTTP/1.1\r\nProxy-Authorization: basic dmFrOnRvaw==\r\n\r\n", auth, &hosts).unwrap_err().starts_with("403"));
        assert!(connect_target("CONNECT api.notion.com:80 HTTP/1.1\r\nProxy-Authorization: basic dmFrOnRvaw==\r\n\r\n", auth, &hosts).is_err());
        assert!(connect_target("GET http://api.notion.com/ HTTP/1.1\r\nProxy-Authorization: basic dmFrOnRvaw==\r\n\r\n", auth, &hosts).is_err());
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
        let (mut child, mut stdin) = start(&runtime, "vak-test", &data, None, &request, 2).map(|h| (h.child, h.stdin)).unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut ask = |msg: &str| { writeln!(stdin, "{msg}").unwrap(); let mut line = String::new(); out.read_line(&mut line).unwrap(); line };
        assert!(ask(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).contains("\"env\""));
        let env = ask(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"env","arguments":{}}}"#);
        assert!(env.contains("ECHO_TOKEN") && !env.contains("OPENAI"), "{env}");
        drop(stdin);
        let _ = child.wait();
        let mut bad = request;
        bad.args = vec![base.join("outside").to_string_lossy().into()];
        assert!(start(&runtime, "vak-test", &data, None, &bad, 2).err().unwrap().contains("Work in folder"));
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Live: `VAK_TEST_HELPER=../sandbox/target/debug/vaksb cargo test --lib network_server_reaches_only_its_host -- --ignored`.
    #[test]
    #[ignore = "contacts api.notion.com through the sandbox and broker"]
    fn network_server_reaches_only_its_host_through_the_broker() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let base = std::env::temp_dir().join(format!("vak-net-live-{}", std::process::id()));
        let (data, resources) = (base.join("data"), base.join("resources"));
        let dir = data.join("worker/integrations/notion");
        std::fs::create_dir_all(dir.join("pkg")).unwrap();
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::copy(manifest.join("../sidecar/mcp-bridge.ts"), resources.join("mcp-bridge.mjs")).unwrap();
        std::fs::write(dir.join("pkg/server.mjs"), r#"
const probe = async (url) => { try { return (await fetch(url)).status; } catch (e) { return String(e.cause ?? e); } };
process.stdout.write(JSON.stringify({ notion: await probe("https://api.notion.com/v1/users/me"), other: await probe("https://example.com/") }) + "\n");
setInterval(() => {}, 1000);
"#).unwrap();
        crate::egress::set_approval(&data, "api.notion.com", true).unwrap();
        let triple = env!("VAK_TARGET_TRIPLE");
        let helper = std::env::var_os("VAK_TEST_HELPER").map(PathBuf::from).unwrap_or_else(|| manifest.join(format!("binaries/vaksb-{triple}")));
        let runtime = Runtime { helper, node: manifest.join(format!("binaries/node-{triple}")), resources };
        let request = Start {
            v: 2, id: "srv-net".into(), kind: "server_start".into(), sandbox_dir: dir.join("home").to_string_lossy().into(),
            script: dir.join("pkg/server.mjs").to_string_lossy().into(), args: vec![], env: BTreeMap::new(),
        };
        let mut hosted = start(&runtime, "vak-test", &data, None, &request, 2).unwrap();
        let mut line = String::new();
        BufReader::new(hosted.child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let result: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
        assert_eq!(result["notion"], 401, "{line}");
        assert_ne!(result["other"], 200, "{line}");
        let _ = hosted.child.kill();
        std::fs::remove_dir_all(base).unwrap();
    }
}
