//! Bounded one-shot canonical execution. Only this native driver owns the
//! canonical pipe; the reasoner cannot submit its response or cleanup proof.
use crate::control::{
    AdmissionError, ControlError, ControlHandle,
    canonical_runs::{CanonicalRun, Invocation},
};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) struct Runtime<'a> {
    pub helper: &'a Path,
    pub node: &'a Path,
    pub resources: &'a Path,
    pub data: &'a Path,
}
fn unavailable() -> ControlError {
    ControlError::Admission(AdmissionError::WorkerCompletionUnavailable)
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "product execution remains disabled until native consent and broker dispatch are connected"
    )
)]
pub(crate) fn run(
    control: &ControlHandle,
    runtime: Runtime<'_>,
    commit_id: String,
    cancel: &AtomicBool,
) -> Result<CanonicalRun, ControlError> {
    let invocation = control.admit_canonical(commit_id)?;
    execute(control, runtime, invocation, cancel)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn execute(
    control: &ControlHandle,
    runtime: Runtime<'_>,
    invocation: Invocation,
    cancel: &AtomicBool,
) -> Result<CanonicalRun, ControlError> {
    use std::{
        io::{BufRead, Read, Write},
        os::{fd::OwnedFd, unix::net::UnixStream},
        process::{Child, Stdio},
        sync::mpsc::{Receiver, sync_channel},
        thread,
        time::{Duration, Instant},
    };
    const FRAME: u64 = 8 * 1024 * 1024 + 4096;
    fn receive<T>(rx: &Receiver<T>, cancel: &AtomicBool, deadline: Instant) -> Option<T> {
        loop {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                return None;
            }
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(value) => return Some(value),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
                Err(_) => {}
            }
        }
    }
    fn wait(child: &mut Child, until: Instant) -> bool {
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }
    let id = invocation.id().to_owned();
    let setup = (|| {
        if cancel.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let command = crate::worker::command_for_canonical(
            runtime.helper,
            runtime.node,
            runtime.resources,
            runtime.data,
            &invocation,
        )
        .map_err(|_| unavailable())?;
        let pair = UnixStream::pair().map_err(|_| unavailable())?;
        pair.0.set_nonblocking(true).map_err(|_| unavailable())?;
        Ok((command, pair))
    })();
    let (mut command, (mut owner, input)) = match setup {
        Ok(value) => value,
        Err(error) => {
            control.abandon_canonical_before_spawn(id)?;
            return Err(error);
        }
    };
    let mut child = match command
        .stdin(Stdio::from(OwnedFd::from(input)))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            control.abandon_canonical_before_spawn(id)?;
            return Err(unavailable());
        }
    };
    let stdout = child.stdout.take().expect("canonical pipe");
    let (ready_tx, ready_rx) = sync_channel(1);
    let (result_tx, result_rx) = sync_channel(1);
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut ready = Vec::new();
        if !matches!(reader.by_ref().take(513).read_until(b'\n', &mut ready), Ok(n) if n > 0 && n <= 512 && ready.ends_with(b"\n"))
        {
            return;
        }
        if ready_tx.send(ready).is_err() {
            return;
        }
        let mut result = Vec::new();
        if !matches!(reader.by_ref().take(FRAME+1).read_until(b'\n', &mut result), Ok(n) if n > 0 && n as u64 <= FRAME && result.ends_with(b"\n"))
        {
            return;
        }
        let mut extra = [0];
        if matches!(reader.read(&mut extra), Ok(0)) {
            let _ = result_tx.send(result);
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let ready = receive(&ready_rx, cancel, Instant::now() + Duration::from_secs(10));
    let valid_ready = ready
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|frame| frame == serde_json::json!({"v":2,"type":"canonical_ready"}));
    let started = valid_ready
        && control
            .confirm_canonical_started(id.clone(), format!("canonical-supervisor-{id}"))
            .is_ok();
    let response = if started && !cancel.load(Ordering::Acquire) {
        let frame = serde_json::to_vec(&invocation.frame()).map_err(|_| unavailable());
        match frame {
            Ok(mut bytes) => {
                bytes.push(b'\n');
                let mut written = 0;
                while written < bytes.len()
                    && Instant::now() < deadline
                    && !cancel.load(Ordering::Acquire)
                {
                    match owner.write(&bytes[written..]) {
                        Ok(0) => break,
                        Ok(count) => written += count,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => break,
                    }
                }
                if written == bytes.len() {
                    receive(&result_rx, cancel, deadline)
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    } else {
        None
    };
    // EOF is the helper's protected graceful-cancellation signal. Never trust
    // stdout to establish process cleanup or return capacity.
    let _ = owner.shutdown(std::net::Shutdown::Write);
    if !wait(&mut child, Instant::now() + Duration::from_secs(5)) {
        let _ = child.kill();
        let _ = wait(&mut child, Instant::now() + Duration::from_secs(5));
    }
    let proposal = if cancel.load(Ordering::Acquire) {
        None
    } else {
        response.and_then(|bytes| invocation.response(&bytes).ok())
    };
    control.finish_canonical(id, proposal)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn execute(
    control: &ControlHandle,
    _runtime: Runtime<'_>,
    invocation: Invocation,
    _cancel: &AtomicBool,
) -> Result<CanonicalRun, ControlError> {
    control.abandon_canonical_before_spawn(invocation.id().into())?;
    Err(unavailable())
}
