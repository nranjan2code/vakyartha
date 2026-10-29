//! Native HTTP transport primitive for the provider broker.
//!
//! This is intentionally not wired to worker requests yet. Provider operation
//! schemas, credential binding, approval and bounded stream receipts must be
//! composed before this client can dispatch product traffic.

use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use std::io::Read;
use std::time::Duration;

const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum BrokerError {
    InvalidEndpoint,
    UnapprovedDestination,
    RequestTooLarge,
    ResponseTooLarge,
    Transport,
}

pub(crate) struct NativeHttpClient {
    client: Client,
}

impl NativeHttpClient {
    pub(crate) fn new() -> Result<Self, BrokerError> {
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|_| BrokerError::Transport)?;
        Ok(Self { client })
    }

    /// POST a JSON body to an approved provider origin. Callers cannot supply
    /// headers or proxy policy. Operation paths and payload semantics still
    /// require a provider-specific contract before product use.
    pub(crate) fn post_provider_json(
        &self,
        endpoint: &str,
        body: &[u8],
    ) -> Result<BrokerResponse, BrokerError> {
        let url = validate_endpoint(endpoint)?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(BrokerError::RequestTooLarge);
        }
        let response = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_vec())
            .send()
            .map_err(|_| BrokerError::Transport)?;
        bounded_response(response)
    }
}

pub(crate) struct BrokerResponse {
    pub(crate) status: StatusCode,
    pub(crate) body: Vec<u8>,
}

fn validate_endpoint(endpoint: &str) -> Result<Url, BrokerError> {
    if endpoint.len() > MAX_ENDPOINT_BYTES {
        return Err(BrokerError::InvalidEndpoint);
    }
    let url = Url::parse(endpoint).map_err(|_| BrokerError::InvalidEndpoint)?;
    let host = url.host_str().ok_or(BrokerError::InvalidEndpoint)?;
    let has_user_info = endpoint
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split(['/', '?', '#']).next())
        .is_some_and(|authority| authority.contains('@'));
    if url.scheme() != "https"
        || has_user_info
        || url.port().is_some_and(|port| port != 443)
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(BrokerError::InvalidEndpoint);
    }
    if !super::policy::MODEL_API_HOSTS.contains(&host) {
        return Err(BrokerError::UnapprovedDestination);
    }
    Ok(url)
}

fn bounded_response(mut response: Response) -> Result<BrokerResponse, BrokerError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(BrokerError::ResponseTooLarge);
    }
    let status = response.status();
    let mut body = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| BrokerError::Transport)?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(BrokerError::ResponseTooLarge);
    }
    Ok(BrokerResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    #[test]
    fn endpoint_validation_rejects_redirectable_or_unapproved_authority() {
        assert!(matches!(
            validate_endpoint("http://api.openai.com/v1/responses"),
            Err(BrokerError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("https://api.openai.com:8443/v1/responses"),
            Err(BrokerError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("https://user@api.openai.com/v1/responses"),
            Err(BrokerError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("https://@api.openai.com/v1/responses"),
            Err(BrokerError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("https://api.openai.com/v1/responses?key=secret"),
            Err(BrokerError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("https://attacker.example/v1/responses"),
            Err(BrokerError::UnapprovedDestination)
        ));
        for non_model_service in ["api.telegram.org", "registry.npmjs.org", "mcp.kite.trade"] {
            assert!(matches!(
                validate_endpoint(&format!("https://{non_model_service}/v1/request")),
                Err(BrokerError::UnapprovedDestination)
            ));
        }
        assert!(validate_endpoint("https://api.openai.com/v1/responses").is_ok());
    }

    #[test]
    fn response_client_does_not_follow_redirects() {
        let first = TcpListener::bind("127.0.0.1:0").unwrap();
        let first_addr = first.local_addr().unwrap();
        let second = TcpListener::bind("127.0.0.1:0").unwrap();
        let second_addr = second.local_addr().unwrap();
        second.set_nonblocking(true).unwrap();
        let redirected = Arc::new(AtomicBool::new(false));
        let observed = redirected.clone();
        let second_thread = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            while std::time::Instant::now() < deadline {
                match second.accept() {
                    Ok(_) => {
                        observed.store(true, Ordering::SeqCst);
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });
        let first_thread = thread::spawn(move || {
            let (mut stream, _) = first.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            use std::io::Write;
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: http://{second_addr}/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let client = NativeHttpClient::new().unwrap();
        let url = Url::parse(&format!("http://{first_addr}/start")).unwrap();
        let response = client.client.post(url).body("{}").send().unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        first_thread.join().unwrap();
        second_thread.join().unwrap();
        assert!(!redirected.load(Ordering::SeqCst));
    }

    #[test]
    fn response_body_limit_is_enforced_when_length_is_not_declared() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            use std::io::Write;
            write!(stream, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n").unwrap();
            let chunk = vec![b'x'; 64 * 1024];
            for _ in 0..129 {
                if stream.write_all(&chunk).is_err() {
                    break;
                }
            }
        });
        let client = NativeHttpClient::new().unwrap();
        let response = client
            .client
            .post(Url::parse(&format!("http://{address}/large")).unwrap())
            .body("{}")
            .send()
            .unwrap();
        assert!(matches!(
            bounded_response(response),
            Err(BrokerError::ResponseTooLarge)
        ));
        server.join().unwrap();
    }
}
