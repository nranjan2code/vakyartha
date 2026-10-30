//! The desktop worker gets one writable private directory and read-only runtime
//! resources. Native stores and original project folders are outside its grants.
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) fn command(
    helper: &Path,
    node: &Path,
    resources: &Path,
    data: &Path,
) -> Result<Command, String> {
    command_inner(helper, node, resources, data, None)
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "native task dispatch remains gated until the protected end-to-end path is ready"
    )
)]
pub(crate) fn command_for_invocation(
    helper: &Path,
    node: &Path,
    resources: &Path,
    data: &Path,
    invocation: &crate::control::worker_completion::WorkerInvocation,
) -> Result<Command, String> {
    command_inner(helper, node, resources, data, Some(invocation))
}

fn command_inner(
    helper: &Path,
    node: &Path,
    resources: &Path,
    data: &Path,
    invocation: Option<&crate::control::worker_completion::WorkerInvocation>,
) -> Result<Command, String> {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return Err("Contained desktop execution is unavailable on this platform".into());
    }
    let helper = existing_file(helper)?;
    let node = existing_file(node)?;
    let resources = resources
        .canonicalize()
        .map_err(|_| "Desktop runtime resources are missing")?;
    let script = existing_file(&resources.join("sidecar.mjs"))?;
    if !script.starts_with(&resources) {
        return Err("Desktop runtime script escapes its resource directory".into());
    }
    std::fs::create_dir_all(data).map_err(|_| "Cannot create desktop data directory")?;
    let data = data
        .canonicalize()
        .map_err(|_| "Cannot resolve desktop data directory")?;
    let worker = data.join("worker");
    crate::private_store::ensure_root(&worker).map_err(|_| "Desktop worker directory is unsafe")?;
    let worker = worker
        .canonicalize()
        .map_err(|_| "Cannot resolve desktop worker directory")?;
    let native = crate::private_store::root(&data);
    // The pinned helper also admits fixed OS runtime directories. A custom
    // data root beneath one must not accidentally expose native persistence.
    #[cfg(target_os = "macos")]
    let system_roots = [
        "/usr",
        "/bin",
        "/System",
        "/Library",
        "/opt",
        "/private/etc",
    ];
    #[cfg(not(target_os = "macos"))]
    let system_roots = ["/usr", "/bin", "/lib", "/lib64", "/etc/ld.so.cache"];
    if system_roots.iter().any(|root| {
        Path::new(root)
            .canonicalize()
            .is_ok_and(|root| native.starts_with(root))
    }) || resources.starts_with(&native)
        || native.starts_with(&resources)
    {
        return Err("Native data must be outside all worker runtime read grants".into());
    }
    if resources.starts_with(&worker)
        || worker.starts_with(&resources)
        || node.starts_with(&worker)
        || helper.starts_with(&worker)
    {
        return Err("Desktop code and writable worker data must be separate".into());
    }
    let mut cmd = Command::new(&helper);
    // Clear the helper's environment as well as explicitly selecting the target
    // environment: secrets and runtime preload hooks must reach neither process.
    cmd.env_clear().env("PATH", "/usr/bin:/bin");
    cmd.arg("worker");
    if let Some(invocation) = invocation {
        if !invocation
            .run_id
            .strip_prefix("run-")
            .is_some_and(|id| id.parse::<u64>().is_ok_and(|number| number > 0))
            || invocation.completion_record
                != native
                    .join("executions")
                    .join(format!("{}.json", invocation.run_id))
        {
            return Err("Worker completion must belong to the native run store".into());
        }
        cmd.arg("--completion-record")
            .arg(&invocation.completion_record)
            .arg("--invocation-id")
            .arg(&invocation.run_id);
    }
    cmd.arg("--cwd")
        .arg(&worker)
        .arg("--read")
        .arg(&resources)
        .arg("--read")
        .arg(&helper)
        .arg("--write")
        .arg(&worker);
    for (name, value) in [
        ("PATH", "/usr/bin:/bin".to_owned()),
        // Node must not load host OpenSSL configuration/providers. Linux Node
        // otherwise opens /etc/ssl/openssl.cnf before running the worker code.
        ("OPENSSL_CONF", "/dev/null".to_owned()),
        ("HOME", worker.to_string_lossy().into_owned()),
        ("TMPDIR", worker.to_string_lossy().into_owned()),
        ("VAK_DATA_DIR", worker.to_string_lossy().into_owned()),
        ("VAK_APP_VERSION", env!("CARGO_PKG_VERSION").to_owned()),
        (
            "VAK_NPM_CLI",
            resources
                .join("npm/bin/npm-cli.js")
                .to_string_lossy()
                .into_owned(),
        ),
        ("VAK_SANDBOX_BIN", helper.to_string_lossy().into_owned()),
    ] {
        cmd.arg("--env").arg(format!("{name}={value}"));
    }
    cmd.arg("--command")
        .arg(node)
        .arg("--")
        .arg("--no-addons")
        .arg("--disable-warning=ExperimentalWarning")
        .arg(script);
    Ok(cmd)
}

fn existing_file(path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|_| "Desktop runtime file is missing; rebuild the bundled runtime")?;
    if !path.is_file() {
        return Err("Desktop runtime path must be a regular file".into());
    }
    Ok(path)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "vak-worker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        for name in ["node", "helper", "sidecar.mjs"] {
            std::fs::write(root.join("runtime").join(name), b"fixture").unwrap();
        }
        root
    }

    #[test]
    fn launch_grants_one_worker_write_directory_and_no_inherited_hooks() {
        let root = fixture();
        let runtime = root.join("runtime");
        let cmd = command(
            &runtime.join("helper"),
            &runtime.join("node"),
            &runtime,
            &root.join("data"),
        )
        .unwrap();
        let args: Vec<_> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "worker");
        let writable: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "--write")
            .map(|pair| pair[1].clone())
            .collect();
        assert_eq!(
            writable,
            [root
                .join("data/worker")
                .canonicalize()
                .unwrap()
                .to_string_lossy()]
        );
        assert!(args.iter().any(|arg| arg == "--no-addons"));
        assert!(!args.iter().any(|arg| arg.contains("VAK_ENV_FILES")
            || arg.contains("VAK_KEYCHAIN_SERVICE")
            || arg.contains("NODE_OPTIONS")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn launch_refuses_replaced_worker_directory() {
        let root = fixture();
        std::fs::create_dir(root.join("data")).unwrap();
        std::fs::create_dir(root.join("protected")).unwrap();
        std::os::unix::fs::symlink(root.join("protected"), root.join("data/worker")).unwrap();
        let runtime = root.join("runtime");
        assert!(
            command(
                &runtime.join("helper"),
                &runtime.join("node"),
                &runtime,
                &root.join("data")
            )
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_refuses_runtime_grants_over_native_storage() {
        let root = fixture();
        let native = crate::private_store::root(&root.join("data"));
        std::fs::create_dir_all(&native).unwrap();
        std::fs::write(native.join("sidecar.mjs"), b"fixture").unwrap();
        assert!(
            command(
                &root.join("runtime/helper"),
                &root.join("runtime/node"),
                &native,
                &root.join("data")
            )
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires reviewed helper and current Node paths in VAK_TEST_WORKER_HELPER and VAK_TEST_WORKER_NODE"]
    fn contained_node_cannot_read_native_data_write_outside_or_connect() {
        use std::process::Stdio;
        let root = fixture();
        let protected = root.join("native-secret");
        std::fs::write(&protected, b"synthetic-native-only").unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let script = format!(
            r#"import fs from 'node:fs'; import net from 'node:net';
const protectedFile = {};
for (const operation of [() => fs.readFileSync(protectedFile), () => fs.writeFileSync(protectedFile, 'forged')]) {{
  let denied = false; try {{ operation(); }} catch (error) {{ if (['EPERM', 'EACCES'].includes(error.code)) denied = true; else throw error; }}
  if (!denied) throw Error('native file access escaped containment');
}}
if (process.env.VAK_CANARY_SECRET || process.env.NODE_OPTIONS) throw Error('inherited secret or preload hook');
await new Promise((resolve, reject) => {{ const socket = net.connect({{host:'127.0.0.1',port:{}}});
  const timer = setTimeout(() => {{ socket.destroy(); reject(Error('network denial timed out')); }}, 2000);
  socket.on('connect', () => {{ clearTimeout(timer); socket.destroy(); reject(Error('network escaped containment')); }});
  socket.on('error', error => {{ clearTimeout(timer); if (['EPERM','EACCES'].includes(error.code)) resolve(); else reject(error); }});
}});
fs.writeFileSync(process.env.VAK_DATA_DIR + '/positive', 'worker-write-ok');
fs.writeFileSync(3, 'CONTAINMENT_PASS\n');
"#,
            serde_json::to_string(&protected.to_string_lossy()).unwrap(),
            listener.local_addr().unwrap().port()
        );
        std::fs::write(root.join("runtime/sidecar.mjs"), script).unwrap();
        let mut cmd = command(
            &PathBuf::from(
                std::env::var_os("VAK_TEST_WORKER_HELPER").expect("helper path required"),
            ),
            &PathBuf::from(std::env::var_os("VAK_TEST_WORKER_NODE").expect("Node path required")),
            &root.join("runtime"),
            &root.join("data"),
        )
        .unwrap();
        cmd.env("VAK_CANARY_SECRET", "synthetic-helper-only")
            .env("NODE_OPTIONS", "--require=/must-not-load");
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let owner = child.stdin.take().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("contained worker timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        drop(owner);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"CONTAINMENT_PASS\n");
        assert_eq!(std::fs::read(&protected).unwrap(), b"synthetic-native-only");
        assert_eq!(
            std::fs::read(root.join("data/worker/positive")).unwrap(),
            b"worker-write-ok"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
