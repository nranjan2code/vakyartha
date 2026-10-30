//! A reasoning pipe is bound by Rust before any worker frame is read. Parsing a
//! provider proposal grants no dispatch; canonical/session commands do not exist.
use super::root_runs::{RootRun, RunStatus};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

pub const MAX_FRAME: usize = 20 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Frame {
    TaskReady {
        v: u8,
    },
    ProviderRequest {
        v: u8,
        id: String,
        provider: String,
        operation: String,
        body: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        attempt: u32,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
    ProviderAck {
        v: u8,
        id: String,
        seq: u32,
    },
    ProviderCancel {
        v: u8,
        id: String,
    },
    TaskCandidate {
        v: u8,
        #[serde(rename = "runId")]
        run_id: String,
        candidate: Value,
    },
    TaskFailed {
        v: u8,
        code: String,
    },
}

#[derive(Debug)]
pub struct ProviderProposal {
    pub id: String,
    pub operation_id: String,
    pub attempt: u32,
    pub body: String,
}

#[derive(Debug)]
pub enum Event {
    Ready,
    Provider(ProviderProposal),
    Ack { id: String, seq: u32 },
    Cancel { id: String },
    Candidate(Value),
    Failed(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolError;
#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Starting,
    Ready,
    Executing,
    Stopped,
}

pub struct TaskChannel {
    run_id: String,
    session_id: String,
    model: String,
    phase: Phase,
    active: Option<String>,
    seen: BTreeSet<String>,
    operations: BTreeSet<(String, u32)>,
}

impl TaskChannel {
    pub fn new(run: &RootRun, model: String) -> Result<Self, ProtocolError> {
        let session_id = run.session_id.as_ref().ok_or(ProtocolError)?;
        if !matches!(run.status, RunStatus::Prepared | RunStatus::Running)
            || !super::valid_identity(&run.id)
            || !super::valid_identity(session_id)
            || model.trim().is_empty()
            || model.len() > 240
            || model.chars().any(char::is_control)
        {
            return Err(ProtocolError);
        }
        Ok(Self {
            run_id: run.id.clone(),
            session_id: session_id.clone(),
            model,
            phase: Phase::Starting,
            active: None,
            seen: BTreeSet::new(),
            operations: BTreeSet::new(),
        })
    }

    /// Called by the trusted driver before it sends the admitted context. A
    /// worker cannot select another run/session or start itself with a frame.
    pub fn start(&mut self) -> Result<(), ProtocolError> {
        if self.phase != Phase::Ready {
            return Err(ProtocolError);
        }
        self.phase = Phase::Executing;
        Ok(())
    }

    pub fn finish_provider(&mut self, id: &str) -> Result<(), ProtocolError> {
        if self.active.as_deref() != Some(id) {
            return Err(ProtocolError);
        }
        self.active = None;
        Ok(())
    }

    pub fn receive(&mut self, bytes: &[u8]) -> Result<Event, ProtocolError> {
        let result = self.decode(bytes);
        if result.is_err() {
            self.phase = Phase::Stopped;
        }
        result
    }

    fn decode(&mut self, bytes: &[u8]) -> Result<Event, ProtocolError> {
        if bytes.len() > MAX_FRAME || self.phase == Phase::Stopped {
            return Err(ProtocolError);
        }
        let frame: Frame = serde_json::from_slice(bytes).map_err(|_| ProtocolError)?;
        match frame {
            Frame::TaskReady { v: 2 } if self.phase == Phase::Starting => {
                self.phase = Phase::Ready;
                Ok(Event::Ready)
            }
            Frame::ProviderRequest {
                v: 2,
                id,
                provider,
                operation,
                body,
                operation_id,
                attempt,
                session_id,
                run_id,
            } if self.phase == Phase::Executing => {
                if self.active.is_some()
                    || self.seen.len() >= 256
                    || !id.starts_with("gen-")
                    || id.len() > 64
                    || !super::valid_identity(&id)
                    || !super::valid_identity(&operation_id)
                    || attempt > 16
                    || session_id != self.session_id
                    || run_id != self.run_id
                    || provider != "ollama"
                    || operation != "ollama_chat"
                    || body.len() > 8 * 1024 * 1024
                    || self.seen.contains(&id)
                    || self.operations.contains(&(operation_id.clone(), attempt))
                {
                    return Err(ProtocolError);
                }
                let payload: Value = serde_json::from_str(&body).map_err(|_| ProtocolError)?;
                if payload.get("model").and_then(Value::as_str) != Some(self.model.as_str()) {
                    return Err(ProtocolError);
                }
                self.seen.insert(id.clone());
                self.operations.insert((operation_id.clone(), attempt));
                self.active = Some(id.clone());
                Ok(Event::Provider(ProviderProposal {
                    id,
                    operation_id,
                    attempt,
                    body,
                }))
            }
            Frame::ProviderAck { v: 2, id, seq }
                if self.phase == Phase::Executing && self.active.as_ref() == Some(&id) =>
            {
                Ok(Event::Ack { id, seq })
            }
            Frame::ProviderCancel { v: 2, id }
                if self.phase == Phase::Executing && self.seen.contains(&id) =>
            {
                Ok(Event::Cancel { id })
            }
            Frame::TaskCandidate {
                v: 2,
                run_id,
                candidate,
            } if self.phase == Phase::Executing && self.active.is_none() => {
                let valid = candidate.as_object().is_some_and(|object| {
                    let fields = [
                        "candidateId",
                        "session",
                        "provider",
                        "model",
                        "result",
                        "reply",
                        "baseVersions",
                        "surfaces",
                    ];
                    object.len() == fields.len()
                        && fields.iter().all(|field| object.contains_key(*field))
                });
                if run_id != self.run_id
                    || !valid
                    || candidate["session"].as_str() != Some(self.session_id.as_str())
                    || candidate["provider"] != "ollama"
                    || candidate["model"].as_str() != Some(self.model.as_str())
                    || !candidate["candidateId"]
                        .as_str()
                        .is_some_and(super::valid_identity)
                    || !candidate["result"].is_object()
                    || !candidate["reply"].is_string()
                    || !candidate["baseVersions"]
                        .as_array()
                        .is_some_and(|items| items.len() <= 16)
                    || !candidate["surfaces"]
                        .as_array()
                        .is_some_and(|items| items.len() <= 16)
                    || serde_json::to_vec(&candidate)
                        .map_or(true, |data| data.len() > 8 * 1024 * 1024)
                {
                    return Err(ProtocolError);
                }
                self.phase = Phase::Stopped;
                Ok(Event::Candidate(candidate))
            }
            Frame::TaskFailed { v: 2, code }
                if matches!(
                    code.as_str(),
                    "protocol_error"
                        | "generation_error"
                        | "cancelled"
                        | "bootstrap_timeout"
                        | "active_time_limit"
                        | "consent_time_limit"
                ) =>
            {
                self.phase = Phase::Stopped;
                Ok(Event::Failed(code))
            }
            _ => Err(ProtocolError),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn channel() -> TaskChannel {
        TaskChannel::new(
            &RootRun {
                id: "run-1".into(),
                request_id: "start".into(),
                root_id: "root".into(),
                session_id: Some("session".into()),
                lease_id: 1,
                admission_revision: 1,
                cancellation_epoch: 1,
                status: RunStatus::Prepared,
                supervisor_receipt: None,
                exit_receipt: None,
                worker_lease_id: None,
                worker_exit_receipt: None,
                worker_exit_code: None,
            },
            "local-model".into(),
        )
        .unwrap()
    }
    fn send(channel: &mut TaskChannel, value: Value) -> Result<Event, ProtocolError> {
        channel.receive(&serde_json::to_vec(&value).unwrap())
    }
    fn proposal() -> Value {
        json!({"v":2,"type":"provider_request","id":"gen-1","provider":"ollama","operation":"ollama_chat","body":"{\"model\":\"local-model\"}","operationId":"operation-1","attempt":0,"sessionId":"session","runId":"run-1"})
    }

    fn executing() -> TaskChannel {
        let mut channel = channel();
        send(&mut channel, json!({"v":2,"type":"task_ready"})).unwrap();
        channel.start().unwrap();
        channel
    }

    fn refused(value: Value) {
        let mut channel = executing();
        assert!(send(&mut channel, value).is_err());
        assert!(
            send(&mut channel, proposal()).is_err(),
            "invalid worker frames permanently fence the channel"
        );
    }

    #[test]
    fn task_pipe_rejects_session_authority_cross_run_and_replayed_proposals() {
        let mut unstarted = channel();
        assert!(send(&mut unstarted, proposal()).is_err());
        assert!(send(&mut unstarted, json!({"v":2,"type":"task_ready"})).is_err());
        for field in ["runId", "sessionId", "provider", "operation"] {
            let mut bad = proposal();
            bad[field] = json!("other");
            refused(bad);
        }
        let mut bad = proposal();
        bad["body"] = json!("{\"model\":\"changed-model\"}");
        refused(bad);
        refused(json!({"v":2,"type":"control_request","id":"ctl-1","operation":"session_list"}));
        refused(json!({"v":2,"type":"provider_ack","id":"gen-other","seq":0}));
        let mut duplicate = executing();
        assert!(matches!(
            send(&mut duplicate, proposal()),
            Ok(Event::Provider(_))
        ));
        assert!(send(&mut duplicate, proposal()).is_err());
        let mut channel = executing();
        send(&mut channel, proposal()).unwrap();
        assert!(channel.finish_provider("gen-other").is_err());
        channel.finish_provider("gen-1").unwrap();
        let mut replay = proposal();
        replay["id"] = json!("gen-2");
        assert!(send(&mut channel, replay).is_err());
        let mut channel = executing();
        assert!(matches!(
            send(
                &mut channel,
                json!({"v":2,"type":"task_failed","code":"cancelled"})
            ),
            Ok(Event::Failed(_))
        ));
        assert!(send(&mut channel, proposal()).is_err());
    }

    #[test]
    fn returned_candidate_is_only_an_opaque_bound_proposal() {
        let candidate = json!({"candidateId":"candidate-1","session":"session","provider":"ollama","model":"local-model","result":{"stop":"max_steps"},"reply":"Incomplete","baseVersions":[],"surfaces":[]});
        let mut bad = candidate.clone();
        bad["session"] = json!("other");
        refused(json!({"v":2,"type":"task_candidate","runId":"run-1","candidate":bad}));
        let mut channel = executing();
        assert!(
            matches!(send(&mut channel, json!({"v":2,"type":"task_candidate","runId":"run-1","candidate":candidate})), Ok(Event::Candidate(value)) if value["result"]["stop"] == "max_steps")
        );
        assert!(channel.start().is_err());
    }
}
