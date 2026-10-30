//! Only native supervision reads these files. Worker stdout, model text and
//! caller-supplied paths never become execution settlement authority.
use super::{
    AdmissionError, CapacityLedger, ControlError, root_runs::RunStatus, state::RootStatus,
};
use serde::Deserialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Eq, PartialEq)]
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
    ledger: &mut CapacityLedger,
    profile: &super::CapacityProfile,
    native: &Path,
    run_id: &str,
) -> Result<WorkerInvocation, ControlError> {
    let run = ledger.root_runs.get(run_id).ok_or_else(unavailable)?;
    let root = ledger.roots.get(&run.root_id).ok_or_else(unavailable)?;
    if run.worker_lease_id.is_some()
        || run.status != RunStatus::Prepared
        || root.status() != RootStatus::Running
        || root.cancellation_epoch() != run.cancellation_epoch
        || root
            .workspace_grant()
            .is_some_and(|grant| !ledger.workspace_grant_is_current(grant))
    {
        return Err(unavailable());
    }
    let root_id = run.root_id.clone();
    let invocation = prepare_path(native, run_id)?;
    let lease = ledger
        .reserve(
            profile,
            &format!("reasoner-{run_id}"),
            &root_id,
            std::collections::BTreeMap::from([(super::Resource::ContainedProcess, 1)]),
        )
        .map_err(ControlError::Admission)?;
    ledger
        .root_runs
        .get_mut(run_id)
        .expect("checked invocation")
        .worker_lease_id = Some(lease.id());
    Ok(invocation)
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

/// Protected cleanup returns process capacity while the root orchestration slot
/// remains charged through canonical verification and publication.
pub(super) fn finish(
    ledger: &mut CapacityLedger,
    native: &Path,
    id: &str,
) -> Result<super::root_runs::RootRun, ControlError> {
    let exit = verified_exit(native, id)?;
    release(ledger, id, exit.receipt, Some(exit.code))
}
pub(super) fn abandon_before_spawn(
    ledger: &mut CapacityLedger,
    id: &str,
) -> Result<super::root_runs::RootRun, ControlError> {
    if ledger
        .root_runs
        .get(id)
        .is_none_or(|run| run.status != RunStatus::Prepared)
    {
        return Err(unavailable());
    }
    let run = release(ledger, id, format!("reasoner-not-launched-{id}"), None)?;
    super::root_runs::settle(
        ledger,
        id,
        run.worker_exit_receipt
            .as_deref()
            .expect("native no-spawn receipt"),
    )
}
fn release(
    ledger: &mut CapacityLedger,
    id: &str,
    receipt: String,
    code: Option<i32>,
) -> Result<super::root_runs::RootRun, ControlError> {
    let run = ledger.root_runs.get(id).ok_or_else(unavailable)?;
    if let Some(prior) = &run.worker_exit_receipt {
        return if *prior == receipt && run.worker_exit_code == code {
            Ok(run.clone())
        } else {
            Err(ControlError::Admission(
                AdmissionError::ConflictingRequestIdentity,
            ))
        };
    }
    let lease = ledger
        .active_lease(run.worker_lease_id.ok_or_else(unavailable)?)
        .ok_or_else(unavailable)?;
    ledger.release(&lease).map_err(ControlError::Admission)?;
    let run = ledger.root_runs.get_mut(id).expect("checked invocation");
    run.worker_exit_receipt = Some(receipt);
    run.worker_exit_code = code;
    Ok(run.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{
        CapacityProfile, ControlActor, Lease, Resource, RootMutation, state::Requirement,
    };
    use std::{collections::BTreeMap, io::Write, sync::atomic::Ordering, thread, time::Duration};

    #[test]
    fn process_admission_is_one_shot_and_unknown_cleanup_blocks_other_jobs_after_restart() {
        let data = std::env::temp_dir().join(format!(
            "vak-reasoner-capacity-{}-{}",
            std::process::id(),
            super::super::TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&data).unwrap();
        let profile = CapacityProfile::new(
            BTreeMap::from([(Resource::Generation, 2), (Resource::ContainedProcess, 1)]),
            BTreeMap::from([(Resource::Generation, 1), (Resource::ContainedProcess, 1)]),
            64,
        )
        .unwrap();
        let actor = ControlActor::open(
            &data,
            "process-test",
            profile.clone(),
            16,
            Duration::from_secs(2),
        )
        .unwrap();
        let handle = actor.handle();
        let start = |id: &str| {
            handle
                .create_root(
                    id.into(),
                    "Bound work".into(),
                    "Original result checks".into(),
                    2,
                    vec![Requirement::new("check".into(), true).unwrap()],
                )
                .unwrap();
            handle
                .mutate_root(
                    id.into(),
                    1,
                    RootMutation::StartAttempt {
                        request_id: format!("start-{id}"),
                    },
                )
                .unwrap();
            handle
                .read_root_run_for_start(format!("start-{id}"))
                .unwrap()
                .id
        };
        let first = start("first");
        let second = start("second");
        let calls: Vec<_> = (0..4)
            .map(|_| {
                let handle = handle.clone();
                let first = first.clone();
                thread::spawn(move || handle.prepare_worker_completion(first))
            })
            .collect();
        let mut results: Vec<_> = calls
            .into_iter()
            .filter_map(|call| call.join().unwrap().ok())
            .collect();
        assert_eq!(
            results.len(),
            1,
            "one durable launch object despite concurrent requests"
        );
        let invocation = results.pop().unwrap();
        let refused_process = handle.prepare_worker_completion(second.clone());
        assert!(matches!(
            refused_process,
            Err(ControlError::Admission(
                AdmissionError::CapacityUnavailable(Resource::ContainedProcess)
            ))
        ));
        let run = handle.read_root_run(first.clone()).unwrap();
        assert!(
            handle
                .release(Lease {
                    id: run.worker_lease_id.unwrap(),
                    request_id: format!("reasoner-{first}"),
                    root_id: "first".into(),
                    amounts: BTreeMap::from([(Resource::ContainedProcess, 1)])
                })
                .is_err(),
            "generic release cannot settle native process ownership"
        );
        assert!(
            handle
                .settle_root_exit(first.clone(), "forged-exit".into())
                .is_err()
        );
        handle
            .confirm_root_started(first.clone(), "first-supervisor".into())
            .unwrap();
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut evidence = options.open(&invocation.completion_record).unwrap();
        evidence.write_all(&serde_json::to_vec(&serde_json::json!({"version":1,"invocation_id":first,"cleanup_verified":true,"exit_code":0})).unwrap()).unwrap();
        evidence.sync_all().unwrap();
        let cleaned = handle.finish_reasoner(first.clone()).unwrap();
        assert_eq!(
            cleaned.status,
            RunStatus::Running,
            "process cleanup does not release orchestration"
        );
        assert_eq!(cleaned.worker_exit_code, Some(0));
        assert!(handle.prepare_worker_completion(first.clone()).is_err());
        let second_invocation = handle.prepare_worker_completion(second.clone()).unwrap();
        drop(handle);
        drop(actor);
        let actor =
            ControlActor::open(&data, "process-test", profile, 16, Duration::from_secs(2)).unwrap();
        let handle = actor.handle();
        assert_eq!(
            handle.read_root_run(second.clone()).unwrap().status,
            RunStatus::Interrupted
        );
        assert!(handle.finish_reasoner(second.clone()).is_err());
        assert!(
            handle.abandon_reasoner_before_spawn(second).is_err(),
            "restart cannot infer that a prepared worker was never spawned"
        );
        handle.settle_worker_completion(first).unwrap();
        handle
            .create_root(
                "third".into(),
                "Other job".into(),
                "Original checks".into(),
                2,
                vec![Requirement::new("check".into(), true).unwrap()],
            )
            .unwrap();
        handle
            .mutate_root(
                "third".into(),
                1,
                RootMutation::StartAttempt {
                    request_id: "start-third".into(),
                },
            )
            .unwrap();
        let third = handle
            .read_root_run_for_start("start-third".into())
            .unwrap();
        assert!(
            handle.prepare_worker_completion(third.id).is_err(),
            "unknown process ownership retains the global hold"
        );
        assert!(!second_invocation.completion_record.exists());
        drop(handle);
        drop(actor);
        fs::remove_dir_all(crate::private_store::root(&data)).unwrap();
        fs::remove_dir_all(data).unwrap();
    }
}
