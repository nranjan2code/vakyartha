use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) fn root(data_dir: &Path) -> PathBuf {
    let name = data_dir.file_name().unwrap_or_default().to_string_lossy();
    data_dir.with_file_name(format!(".{name}-native"))
}

pub(crate) fn ensure_root(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        },
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native data root is not a real directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_root_is_a_hidden_sibling() {
        let data_dir = Path::new("/tmp/vakyartha/data");
        assert_eq!(root(data_dir), Path::new("/tmp/vakyartha/.data-native"));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_root_refuses_symlinks() {
        let unique = format!(
            "vak-private-store-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let parent = std::env::temp_dir().join(unique);
        let target = parent.join("target");
        let link = parent.join("link");
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = ensure_root(&link).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        fs::remove_dir_all(parent).unwrap();
    }
}
