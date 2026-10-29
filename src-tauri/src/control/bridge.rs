use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 2;
pub const MAX_FRAME_BYTES: usize = 4096;

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    kind: String,
    pub operation: Operation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Health,
}

impl Request {
    pub fn decode(frame: &[u8]) -> Result<Self, &'static str> {
        if frame.len() > MAX_FRAME_BYTES {
            return Err("control_frame_too_large");
        }
        let request = serde_json::from_slice::<Self>(frame)
            .map_err(|_| "invalid_control_message")?;
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
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
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ready,
    Unavailable,
    Overloaded,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
pub struct Response<'a> {
    pub v: u8,
    pub id: &'a str,
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub status: Status,
}

impl<'a> Response<'a> {
    pub fn new(id: &'a str, status: Status) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            message_type: "control_response",
            status,
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
        assert_eq!(request.validate(), Ok(()));
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
        assert_eq!(Request::decode(&vec![b' '; MAX_FRAME_BYTES + 1]), Err("control_frame_too_large"));
    }
}
