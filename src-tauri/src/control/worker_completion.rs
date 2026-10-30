//! Only native supervision reads these files. Worker stdout, model text and
//! caller-supplied paths never become execution settlement authority.
use super::{
    AdmissionError, CapacityLedger, ControlError, root_runs::RunStatus, state::RootStatus,
};
use serde::Deserialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerInvocation {
    pub run_id: String,
    pub completion_record: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    version: u8,
    invocation_id: String,
    cleanup_verified: bool,
    exit_code: Option<i32>,
}

fn unavailable() -> ControlError {
    ControlError::Admission(AdmissionError::WorkerCompletionUnavailable)
}

fn path(native: &Path, run_id: &str) -> Result<PathBuf, ControlError> {
    if !super::valid_identity(run_id) {
        return Err(unavailable());
    }
    Ok(native.join("executions").join(format!("{run_id}.json")))
}

pub(super) fn prepare(
    ledger: &CapacityLedger,
    native: &Path,
    run_id: &str,
) -> Result<WorkerInvocation, ControlError> {
    let run = ledger.root_runs.get(run_id).ok_or_else(unavailable)?;
    let root = ledger.roots.get(&run.root_id).ok_or_else(unavailable)?;
    if run.status != RunStatus::Prepared
        || root.status() != RootStatus::Running
        || root.cancellation_epoch() != run.cancellation_epoch
        || root
            .workspace_grant()
            .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
    {
        return Err(unavailable());
    }
    prepare_path(native, run_id)
}

pub(super) fn prepare_path(native: &Path, run_id: &str) -> Result<WorkerInvocation, ControlError> {
    path(native, run_id)?;
    crate::private_store::ensure_root(&native.join("executions")).map_err(|_| unavailable())?;
    super::sync_directory(native).map_err(ControlError::Store)?;
    let completion_record = native
        .join("executions")
        .canonicalize()
        .map_err(|_| unavailable())?
        .join(format!("{run_id}.json"));
    match fs::symlink_metadata(&completion_record) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(unavailable()),
    }
    Ok(WorkerInvocation {
        run_id: run_id.into(),
        completion_record,
    })
}

pub(super) fn exit_receipt(native: &Path, run_id: &str) -> Result<String, ControlError> {
    Ok(verified_exit(native, run_id)?.receipt)
}

pub(super) struct VerifiedExit {
    pub receipt: String,
    pub code: i32,
}

pub(super) fn verified_exit(native: &Path, run_id: &str) -> Result<VerifiedExit, ControlError> {
    let record = path(native, run_id)?;
    // The actor owns the native root. Refuse replacement links and permissive
    // evidence rather than following them into a worker-controlled namespace.
    let directory = record.parent().ok_or_else(unavailable)?;
    let parent = fs::symlink_metadata(directory).map_err(|_| unavailable())?;
    let metadata = fs::symlink_metadata(&record).map_err(|_| unavailable())?;
    if !parent.is_dir()
        || parent.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 2048
    {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if (parent.permissions().mode() | metadata.permissions().mode()) & 0o077 != 0 {
            return Err(unavailable());
        }
    }
    let mut bytes = Vec::new();
    File::open(record)
        .map_err(|_| unavailable())?
        .take(2049)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > 2048 {
        return Err(unavailable());
    }
    let completion: Completion = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if completion.version != 1
        || completion.invocation_id != run_id
        || !completion.cleanup_verified
        || !completion
            .exit_code
            .is_some_and(|code| (0..=255).contains(&code))
    {
        return Err(unavailable());
    }
    Ok(VerifiedExit {
        receipt: format!("worker-exit-{run_id}-{}", super::canonical::digest(&bytes)),
        code: completion.exit_code.expect("verified bounded exit code"),
    })
}
