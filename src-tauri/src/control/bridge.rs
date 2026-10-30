use serde::{Deserialize, Serialize};
use super::canonical::{CandidateCommitReceipt, CandidateCommitRequest};
use super::state::ExecutionFence;
use super::canonical;

pub const PROTOCOL_VERSION: u8 = 2;
pub const MAX_HEALTH_FRAME_BYTES: usize = 4096;
pub const MAX_CANDIDATE_FRAME_BYTES: usize = 9 * 1024 * 1024;
pub const MAX_CANDIDATE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CandidateCommit {
    pub session_id: String,
    pub commit_id: String,
    pub fence: ExecutionFence,
    pub expected_canonical_revision: u64,
    pub candidate: serde_json::Value,
}

impl CandidateCommit {
    pub fn into_request(self) -> Result<CandidateCommitRequest, &'static str> {
        if !canonical::validate_identity(&self.session_id)
            || !canonical::validate_identity(&self.commit_id)
            || !canonical::validate_identity(self.fence.root_id())
        {
            return Err("invalid_candidate_identity");
        }
        let candidate_bytes = serde_json::to_vec(&self.candidate)
            .map_err(|_| "invalid_candidate")?;
        if !self.candidate.is_object() || candidate_bytes.len() > MAX_CANDIDATE_BYTES {
            return Err("candidate_too_large_or_invalid");
        }
        Ok(CandidateCommitRequest {
            session_id: self.session_id,
            commit_id: self.commit_id,
            fence: self.fence,
            expected_canonical_revision: self.expected_canonical_revision,
            candidate_bytes,
        })
    }
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    kind: String,
    pub operation: Operation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Health,
    CandidateCommit(CandidateCommit),
}

impl Request {
    pub fn decode(frame: &[u8]) -> Result<Self, &'static str> {
        if frame.len() > MAX_CANDIDATE_FRAME_BYTES {
            return Err("control_frame_too_large");
        }
        let request = serde_json::from_slice::<Self>(frame)
            .map_err(|_| "invalid_control_message")?;
        request.validate(frame.len())?;
        Ok(request)
    }

    pub fn decode_value(value: serde_json::Value, frame_len: usize) -> Result<Self, &'static str> {
        if frame_len > MAX_CANDIDATE_FRAME_BYTES {
            return Err("control_frame_too_large");
        }
        let request = serde_json::from_value::<Self>(value)
            .map_err(|_| "invalid_control_message")?;
        request.validate(frame_len)?;
        Ok(request)
    }

    pub fn validate(&self, frame_len: usize) -> Result<(), &'static str> {
        if self.v != PROTOCOL_VERSION {
            return Err("incompatible_protocol");
        }
        if self.kind != "control_request" {
            return Err("invalid_control_message");
        }
        if !self.id.starts_with("ctl-")
            || self.id.len() == 4
            || self.id.len() > 64
            || !self.id[4..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("invalid_control_identity");
        }
        match &self.operation {
            Operation::Health if frame_len <= MAX_HEALTH_FRAME_BYTES => Ok(()),
            Operation::Health => Err("control_frame_too_large"),
            Operation::CandidateCommit(candidate) => {
                candidate.clone().into_request().map(|_| ())
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ready,
    Unavailable,
    Overloaded,
    Committed,
    Refused,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
pub struct Response<'a> {
    pub v: u8,
    pub id: &'a str,
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<CandidateCommitReceipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'a str>,
}

impl<'a> Response<'a> {
    pub fn new(id: &'a str, status: Status) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            message_type: "control_response",
            status,
            receipt: None,
            error: None,
        }
    }

    pub fn candidate(id: &'a str, status: Status, receipt: Option<CandidateCommitReceipt>, error: Option<&'a str>) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            message_type: "control_response",
            status,
            receipt,
            error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_versioned_bounded_health_requests() {
        let request = Request::decode(
            br#"{"v":2,"id":"ctl-123abc","type":"control_request","operation":"health"}"#,
        )
        .unwrap();
        assert_eq!(request.validate(MAX_HEALTH_FRAME_BYTES), Ok(()));
        assert_eq!(request.operation, Operation::Health);
        let response = serde_json::to_value(Response::new(&request.id, Status::Ready)).unwrap();
        assert_eq!(response["type"], "control_response");
        assert_eq!(response["status"], "ready");
    }

    #[test]
    fn rejects_old_versions_unknown_fields_and_non_control_identities() {
        for frame in [
            r#"{"v":1,"id":"ctl-1","type":"control_request","operation":"health"}"#,
            r#"{"v":2,"id":"request-1","type":"control_request","operation":"health"}"#,
            r#"{"v":2,"id":"ctl-1","type":"control_request","operation":"health","root_id":"root"}"#,
            r#"{"v":2,"id":"ctl-1","type":"control_request","operation":"execute"}"#,
        ] {
            assert!(Request::decode(frame.as_bytes()).is_err());
        }
    }

    #[test]
    fn rejects_oversized_control_frame_before_json_parsing() {
        assert_eq!(
            Request::decode(&vec![b' '; MAX_CANDIDATE_FRAME_BYTES + 1]),
            Err("control_frame_too_large")
        );
        assert_eq!(
            Request::decode(&vec![b' '; MAX_HEALTH_FRAME_BYTES + 1]),
            Err("invalid_control_message")
        );
    }

    #[test]
    fn candidate_frames_are_typed_bounded_and_fence_complete() {
        let fence: ExecutionFence = serde_json::from_value(serde_json::json!({
            "root_id": "root-1",
            "root_revision": 7,
            "contract_revision": 2,
            "cancellation_epoch": 4,
        })).unwrap();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "v": PROTOCOL_VERSION,
            "id": "ctl-candidate-1",
            "type": "control_request",
            "operation": {"candidate_commit": {
                "session_id": "session-1",
                "commit_id": "commit-1",
                "fence": fence,
                "expected_canonical_revision": 3,
                "candidate": {"surfaces": []}
            }}
        })).unwrap();
        let decoded = Request::decode(&bytes).unwrap();
        assert!(matches!(
            decoded.operation,
            Operation::CandidateCommit(CandidateCommit { expected_canonical_revision: 3, .. })
        ));
        let oversized = serde_json::json!({
            "v": 2,
            "id": "ctl-large",
            "type": "control_request",
            "operation": {"candidate_commit": {
                "session_id": "session-1",
                "commit_id": "commit-1",
                "fence": {"root_id":"root-1","root_revision":1,"contract_revision":1,"cancellation_epoch":0},
                "expected_canonical_revision": 0,
                "candidate": {"large": "x".repeat(MAX_CANDIDATE_BYTES + 1)}
            }}
        });
        let oversized = serde_json::to_vec(&oversized).unwrap();
        assert_eq!(
            Request::decode(&oversized),
            Err("candidate_too_large_or_invalid")
        );
    }
}
