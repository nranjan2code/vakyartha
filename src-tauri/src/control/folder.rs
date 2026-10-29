//! Native physical-folder identity primitives for workspace admission.
//!
//! The identity is a stale-grant detector. It does not pin an open directory
//! handle or make a later path lookup race-free; execution must still pass the
//! captured grant into the sandbox and have that boundary validate its target.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FolderIdentity {
    device: u64,
    object: u64,
    created_seconds: u64,
    created_nanos: u32,
}

impl FolderIdentity {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if self.device == 0 || self.object == 0 || self.created_nanos >= 1_000_000_000 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid persisted workspace identity",
            ));
        }
        Ok(())
    }

    /// Capture a canonical directory and its filesystem identity.
    ///
    /// Creation time is required because device/object numbers can be reused
    /// after deletion. Filesystems that do not expose creation time fail closed.
    pub fn capture(path: &Path) -> io::Result<(PathBuf, Self)> {
        let canonical = fs::canonicalize(path)?;
        let metadata = fs::metadata(&canonical)?;
        if !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Workspace path must be a directory",
            ));
        }
        let created = metadata.created()?;
        let (created_seconds, created_nanos) = system_time_parts(created)?;
        let (device, object) = platform_object_identity(&metadata)?;
        if device == 0 || object == 0 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Filesystem did not provide a stable workspace identity",
            ));
        }
        Ok((
            canonical,
            Self {
                device,
                object,
                created_seconds,
                created_nanos,
            },
        ))
    }

    /// Compare a current path lookup to the identity admitted by the user.
    pub fn still_names(&self, path: &Path) -> io::Result<bool> {
        let (_, current) = Self::capture(path)?;
        Ok(self == &current)
    }
}

/// Trusted folder selection policy initialized from the native app-data root.
#[derive(Clone, Debug)]
pub struct WorkspaceAdmissionPolicy {
    data_root: PathBuf,
    denied_roots: Vec<PathBuf>,
}

impl WorkspaceAdmissionPolicy {
    pub fn new(data_root: &Path) -> io::Result<Self> {
        let data_root = fs::canonicalize(data_root)?;
        let mut denied_roots = Vec::new();
        for path in [
            "/",
            "/System",
            "/Library",
            "/Applications",
            "/usr",
            "/bin",
            "/sbin",
            "/etc",
            "/var",
            "/tmp",
            "/private",
            "/private/etc",
            "/private/var",
            "/private/tmp",
            "/Users",
            "/home",
            "/dev",
            "/proc",
            "/sys",
        ] {
            if let Ok(canonical) = fs::canonicalize(path) {
                if !denied_roots.contains(&canonical) {
                    denied_roots.push(canonical);
                }
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            if let Ok(canonical) = fs::canonicalize(home) {
                if !denied_roots.contains(&canonical) {
                    denied_roots.push(canonical);
                }
            }
        }
        Ok(Self {
            data_root,
            denied_roots,
        })
    }

    pub fn admit(&self, path: &Path) -> io::Result<(PathBuf, FolderIdentity)> {
        let (canonical, identity) = FolderIdentity::capture(path)?;
        if self.denied_roots.contains(&canonical)
            || canonical.starts_with(&self.data_root)
            || self.data_root.starts_with(&canonical)
            || canonical.components().any(is_reserved_component)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "System, private or reserved folders cannot be workspaces",
            ));
        }
        Ok((canonical, identity))
    }
}

fn is_reserved_component(component: Component<'_>) -> bool {
    let name = component.as_os_str().to_string_lossy();
    [".vak", ".git", ".ssh", ".aws", ".azure", ".kube", ".docker"]
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

fn system_time_parts(value: SystemTime) -> io::Result<(u64, u32)> {
    let duration = value.duration_since(SystemTime::UNIX_EPOCH).map_err(|_| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "Filesystem returned an invalid workspace creation time",
        )
    })?;
    Ok((duration.as_secs(), duration.subsec_nanos()))
}

#[cfg(unix)]
fn platform_object_identity(metadata: &fs::Metadata) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn platform_object_identity(_: &fs::Metadata) -> io::Result<(u64, u64)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Stable workspace identity is unavailable on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "vakyartha-folder-identity-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("temporary directory can be created");
        path
    }

    #[test]
    fn captures_canonical_physical_directory_identity() {
        let path = temp_dir();
        let alias = path.join("..").join(path.file_name().expect("name"));
        let (canonical, identity) = FolderIdentity::capture(&alias).expect("identity");
        assert_eq!(canonical, path.canonicalize().expect("canonical path"));
        assert!(identity.still_names(&path).expect("same directory"));
        fs::remove_dir_all(path).expect("temporary directory can be removed");
    }

    #[test]
    fn refuses_non_directories_and_missing_creation_identity() {
        let path = temp_dir();
        let file = path.join("file");
        fs::write(&file, "data").expect("file can be written");
        assert_eq!(
            FolderIdentity::capture(&file)
                .expect_err("file is not a workspace")
                .kind(),
            io::ErrorKind::InvalidInput
        );
        fs::remove_dir_all(path).expect("temporary directory can be removed");
    }

    #[test]
    fn admission_rejects_private_roots_and_reserved_path_components() {
        let base = temp_dir();
        let data = base.join("private-data");
        let work = base.join("work");
        let reserved = work.join(".git").join("nested");
        fs::create_dir(&data).expect("private directory can be created");
        fs::create_dir_all(&reserved).expect("reserved path can be created");
        let policy = WorkspaceAdmissionPolicy::new(&data).expect("admission policy");
        assert!(policy.admit(&base).is_err());
        assert!(policy.admit(&data).is_err());
        assert!(policy.admit(&reserved).is_err());
        assert_eq!(
            policy
                .admit(Path::new("/"))
                .expect_err("system root denied")
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        fs::remove_dir_all(base).expect("temporary tree can be removed");
    }
}
