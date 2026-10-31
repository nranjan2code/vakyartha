// The shell owns one child and its anonymous pipes. Requests never become
// network listeners; only the main webview may use the bounded IPC contract.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex, atomic::{AtomicUsize, Ordering}, mpsc::{SyncSender, TrySendError, sync_channel}};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use super::Backend;
use super::control::{AdmissionError, ControlError, ControlHandle, StoreError, bridge::{self, Operation as ControlOperation, Request as ControlRequest, Status as ControlStatus}, state::StateError};
use crate::reasoner_supervisor::base64;

const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_QUEUE: usize = 48 * 1024 * 1024;
const MAX_PROVIDER_BODY: usize = 8 * 1024 * 1024;
const MAX_BRIDGE_FRAME: usize = 48 * 1024 * 1024;
const PROTOCOL_VERSION: u8 = bridge::PROTOCOL_VERSION;
type Pending = Arc<Mutex<HashMap<String, Channel<Frame>>>>;
type Input = Arc<Mutex<Option<SyncSender<Vec<u8>>>>>;

#[derive(Clone, Serialize, Deserialize)]
pub struct Frame {
    v: u8,
    id: String,
    #[serde(flatten)]
    event: Output,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Output {
    Headers { status: u16, headers: BTreeMap<String, String> },
    Data { data: String },
    End,
    Error { message: String },
}

fn default_protocol_version() -> u8 {
    PROTOCOL_VERSION
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderRequest {
    #[serde(default = "default_protocol_version")]
    v: u8,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    provider: String,
    operation: String,
    #[serde(rename = "routeModel", default)]
    route_model: Option<String>,
    #[serde(default)]
    body: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    attempt: u32,
    #[serde(rename = "sessionId", default)]
    session_id: Option<String>,
    #[serde(rename = "runId", default)]
    run_id: Option<String>,
}

impl ProviderRequest {
    fn validate(&self) -> bool {
        let valid_model = self.route_model.as_deref().is_some_and(|model| {
            !model.is_empty()
                && model.len() <= 128
                && model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        });
        let operation_matches_provider = match self.provider.as_str() {
            "openai" => {
                (matches!(self.operation.as_str(), "responses" | "chat_completions") && self.route_model.is_none())
                    || (self.operation == "models" && (self.route_model.is_none() || valid_model))
            }
            "anthropic" => {
                (self.operation == "messages" && self.route_model.is_none())
                    || (self.operation == "models" && (self.route_model.is_none() || valid_model))
            }
            "gemini" => {
                (self.operation == "stream_generate_content" && valid_model)
                    || (self.operation == "models" && (self.route_model.is_none() || valid_model))
            }
            "ollama" => {
                matches!(
                    self.operation.as_str(),
                    "ollama_chat" | "ollama_tags" | "ollama_show"
                ) && self.route_model.is_none()
            }
            "lmstudio" => {
                matches!(self.operation.as_str(), "models" | "chat_completions")
                    && self.route_model.is_none()
            }
            "mistral" | "xai" | "deepseek" | "groq" | "cerebras" | "openrouter"
            | "together" | "fireworks" | "moonshot" | "dashscope" | "qwen" | "typesafe" => {
                matches!(self.operation.as_str(), "chat_completions" | "models")
                    && self.route_model.is_none()
            }
            _ => false,
        };
        self.v == PROTOCOL_VERSION
            && self.kind == "provider_request"
            && self.id.starts_with("gen-")
            && valid_id(&self.id)
            && operation_matches_provider
            && self.body.len() <= MAX_PROVIDER_BODY
            && self.operation_id.len() <= 128
            && !self.operation_id.is_empty()
            && self.operation_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            && self.attempt <= 16
            && self.session_id.as_deref().map_or(true, valid_execution_id)
            && self.run_id.as_deref().map_or(true, valid_execution_id)
    }
}

fn valid_execution_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn provider_refusal(id: &str) -> serde_json::Value {
    serde_json::json!({
        "v": PROTOCOL_VERSION,
        "id": id,
        "type": "provider_error",
        "message": "Native provider dispatch is not enabled",
    })
}

async fn dispatch_provider_request(
    request: ProviderRequest,
    sender: Input,
    queued: Arc<AtomicUsize>,
    dispatch_context: Option<(String, PathBuf)>,
) {
    let (service, data_dir) = match dispatch_context {
        Some(ctx) => ctx,
        None => {
            send_provider_error(&sender, &queued, &request.id, "Native provider dispatch is not enabled");
            return;
        }
    };

    let (client, method, url, auth_header, body_payload) = match resolve_provider_request(&request, &service, &data_dir).await {
        Ok(resolved) => resolved,
        Err(err_msg) => {
            send_provider_error(&sender, &queued, &request.id, &err_msg);
            return;
        }
    };

    let mut builder = client.request(method, &url);
    if let Some((header_name, header_val)) = auth_header {
        builder = builder.header(header_name, header_val);
        if request.provider == "anthropic" {
            builder = builder.header("anthropic-version", "2023-06-01");
        }
    }
    if let Some(body) = body_payload {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }

    let response = match builder.send().await {
        Ok(res) => res,
        Err(err) => {
            send_provider_error(&sender, &queued, &request.id, &format!("Provider HTTP request failed: {err}"));
            return;
        }
    };

    relay_response(response, &request.id, &sender, &queued, &["content-type", "retry-after"]).await;
}

/// Streams one upstream response over the shared provider frame family.
async fn relay_response(mut response: reqwest::Response, id: &str, sender: &Input, queued: &Arc<AtomicUsize>, forwarded: &[&str]) {
    let status = response.status().as_u16();
    let mut headers_map = serde_json::Map::new();
    for name in forwarded {
        if let Some(value) = response.headers().get(*name).and_then(|v| v.to_str().ok()).filter(|v| v.len() <= 256) {
            headers_map.insert((*name).to_string(), serde_json::Value::String(value.to_string()));
        }
    }
    send_frame(sender, queued, serde_json::json!({ "v": PROTOCOL_VERSION, "id": id, "type": "provider_headers", "status": status, "headers": headers_map }));
    let mut seq: u32 = 0;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                for slice in chunk.chunks(64 * 1024) {
                    send_frame(sender, queued, serde_json::json!({ "v": PROTOCOL_VERSION, "id": id, "type": "provider_data", "seq": seq, "data": base64(slice) }));
                    seq += 1;
                }
            }
            Ok(None) => break,
            Err(err) => {
                send_provider_error(sender, queued, id, &format!("Streaming error: {err}"));
                return;
            }
        }
    }
    send_frame(sender, queued, serde_json::json!({ "v": PROTOCOL_VERSION, "id": id, "type": "provider_end" }));
}

async fn dispatch_egress_request(request: crate::egress::EgressRequest, sender: Input, queued: Arc<AtomicUsize>, service: String, data_dir: PathBuf) {
    let admitted = match request.admit(PROTOCOL_VERSION) {
        Ok(admitted) => admitted,
        Err(message) => return send_provider_error(&sender, &queued, &request.id, message),
    };
    if !crate::egress::approved(&data_dir).contains(&admitted.host) {
        let message = format!("Network access to {} needs your approval: open this integration in Settings and choose Allow", admitted.host);
        return send_provider_error(&sender, &queued, &request.id, &message);
    }
    let client = match cached_resolve_public_addresses(&admitted.host).and_then(|addrs| get_or_create_client(Some(&admitted.host), Some(&addrs))) {
        Ok(client) => client,
        Err(message) => return send_provider_error(&sender, &queued, &request.id, &message),
    };
    let mut builder = client.request(admitted.method, admitted.url);
    for (name, value) in admitted.headers { builder = builder.header(name, value); }
    if let Some(credential) = crate::egress::credential(&admitted.host) {
        match cached_vault_get(&service, &credential.account, &data_dir) {
            Ok(Some(value)) if !value.is_empty() => builder = builder.header(credential.header.as_str(), credential.format.replace("{value}", &value)),
            Ok(_) => {}
            Err(message) => return send_provider_error(&sender, &queued, &request.id, &message),
        }
    }
    if let Some(body) = admitted.body { builder = builder.body(body); }
    match builder.send().await {
        Ok(response) => relay_response(response, &request.id, &sender, &queued, crate::egress::RESPONSE_HEADERS).await,
        Err(err) => send_provider_error(&sender, &queued, &request.id, &format!("{} could not be reached: {err}", admitted.host)),
    }
}

static DNS_CACHE: LazyLock<Mutex<HashMap<String, (Vec<SocketAddr>, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static CRED_CACHE: LazyLock<Mutex<HashMap<String, (String, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static CLIENT_CACHE: LazyLock<Mutex<HashMap<String, reqwest::Client>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached_resolve_public_addresses(host: &str) -> Result<Vec<SocketAddr>, String> {
    const TTL: Duration = Duration::from_secs(300);
    let now = Instant::now();
    if let Ok(cache) = DNS_CACHE.lock() {
        if let Some((addrs, timestamp)) = cache.get(host) {
            if now.duration_since(*timestamp) < TTL {
                return Ok(addrs.clone());
            }
        }
    }
    let addrs = crate::control::broker::resolve_public_addresses(host)
        .map_err(|e| format!("Failed to resolve provider addresses for {host}: {e:?}"))?;
    if let Ok(mut cache) = DNS_CACHE.lock() {
        cache.insert(host.to_string(), (addrs.clone(), now));
    }
    Ok(addrs)
}

fn cached_vault_get(service: &str, account: &str, data_dir: &std::path::Path) -> Result<Option<String>, String> {
    const TTL: Duration = Duration::from_secs(30);
    let cache_key = format!("{service}::{account}");
    let now = Instant::now();
    if let Ok(cache) = CRED_CACHE.lock() {
        if let Some((cred, timestamp)) = cache.get(&cache_key) {
            if now.duration_since(*timestamp) < TTL {
                return Ok(Some(cred.clone()));
            }
        }
    }
    let cred = crate::vault::get(service, account, data_dir)
        .map_err(|e| format!("Credential vault error: {e}"))?;
    if let Some(ref val) = cred {
        if !val.is_empty() {
            if let Ok(mut cache) = CRED_CACHE.lock() {
                cache.insert(cache_key, (val.clone(), now));
            }
        }
    }
    Ok(cred)
}

fn get_or_create_client(host: Option<&str>, addrs: Option<&[SocketAddr]>) -> Result<reqwest::Client, String> {
    let key = host.unwrap_or("local").to_string();
    if let Ok(cache) = CLIENT_CACHE.lock() {
        if let Some(client) = cache.get(&key) {
            return Ok(client.clone());
        }
    }
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .pool_max_idle_per_host(4)
        .pool_idle_timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120));
    if let (Some(h), Some(a)) = (host, addrs) {
        if a.is_empty() {
            return Err("Unapproved destination address".to_string());
        }
        builder = builder.resolve_to_addrs(h, a);
    }
    let client = builder.build().map_err(|e| format!("Client build error: {e}"))?;
    if let Ok(mut cache) = CLIENT_CACHE.lock() {
        cache.insert(key, client.clone());
    }
    Ok(client)
}

async fn resolve_provider_request(
    request: &ProviderRequest,
    service: &str,
    data_dir: &std::path::Path,
) -> Result<
    (
        reqwest::Client,
        reqwest::Method,
        String,
        Option<(&'static str, String)>,
        Option<String>,
    ),
    String,
> {
    if request.provider == "ollama" {
        let (method, url, body) = match request.operation.as_str() {
            "ollama_tags" => (
                reqwest::Method::GET,
                "http://127.0.0.1:11434/api/tags".to_string(),
                None,
            ),
            "ollama_show" => (
                reqwest::Method::POST,
                "http://127.0.0.1:11434/api/show".to_string(),
                Some(request.body.clone()),
            ),
            "ollama_chat" => (
                reqwest::Method::POST,
                "http://127.0.0.1:11434/api/chat".to_string(),
                Some(request.body.clone()),
            ),
            _ => return Err("Unsupported local model operation".to_string()),
        };
        let client = get_or_create_client(None, None)
            .map_err(|e| format!("Failed to create local provider client: {e:?}"))?;
        return Ok((client, method, url, None, body));
    }

    if request.provider == "lmstudio" {
        let (method, url, body) = match request.operation.as_str() {
            "models" => (
                reqwest::Method::GET,
                "http://127.0.0.1:1234/v1/models".to_string(),
                None,
            ),
            "chat_completions" => (
                reqwest::Method::POST,
                "http://127.0.0.1:1234/v1/chat/completions".to_string(),
                Some(request.body.clone()),
            ),
            _ => return Err("Unsupported local model operation".to_string()),
        };
        let client = get_or_create_client(None, None)
            .map_err(|e| format!("Failed to create local provider client: {e:?}"))?;
        return Ok((client, method, url, None, body));
    }

    let account = match request.provider.as_str() {
        "openai" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        "mistral" => "MISTRAL_API_KEY",
        "xai" => "XAI_API_KEY",
        "deepseek" => "DEEPSEEK_API_KEY",
        "groq" => "GROQ_API_KEY",
        "cerebras" => "CEREBRAS_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        "together" => "TOGETHER_API_KEY",
        "fireworks" => "FIREWORKS_API_KEY",
        "moonshot" => "MOONSHOT_API_KEY",
        "dashscope" | "qwen" => "DASHSCOPE_API_KEY",
        "typesafe" => "TYPESAFE_API_KEY",
        _ => return Err("Unsupported native provider".to_string()),
    };

    let cred = cached_vault_get(service, account, data_dir)?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Credential unavailable for provider {}", request.provider))?;

    let (host, method, url, body) = match request.provider.as_str() {
        "openai" => {
            let host = "api.openai.com";
            match request.operation.as_str() {
                "models" => {
                    let url = if let Some(ref m) = request.route_model {
                        format!("https://api.openai.com/v1/models/{m}")
                    } else {
                        "https://api.openai.com/v1/models".to_string()
                    };
                    (host, reqwest::Method::GET, url, None)
                }
                "chat_completions" => (host, reqwest::Method::POST, "https://api.openai.com/v1/chat/completions".to_string(), Some(request.body.clone())),
                "responses" => (host, reqwest::Method::POST, "https://api.openai.com/v1/responses".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported OpenAI operation".to_string()),
            }
        }
        "anthropic" => {
            let host = "api.anthropic.com";
            match request.operation.as_str() {
                "models" => {
                    let url = if let Some(ref m) = request.route_model {
                        format!("https://api.anthropic.com/v1/models/{m}")
                    } else {
                        "https://api.anthropic.com/v1/models?limit=100".to_string()
                    };
                    (host, reqwest::Method::GET, url, None)
                }
                "messages" => (host, reqwest::Method::POST, "https://api.anthropic.com/v1/messages".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported Anthropic operation".to_string()),
            }
        }
        "gemini" => {
            let host = "generativelanguage.googleapis.com";
            match request.operation.as_str() {
                "models" => {
                    let url = if let Some(ref m) = request.route_model {
                        format!("https://generativelanguage.googleapis.com/v1beta/models/{m}")
                    } else {
                        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200".to_string()
                    };
                    (host, reqwest::Method::GET, url, None)
                }
                "stream_generate_content" => {
                    let m = request.route_model.as_ref().ok_or("Missing Gemini route model")?;
                    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{m}:streamGenerateContent?alt=sse");
                    (host, reqwest::Method::POST, url, Some(request.body.clone()))
                }
                _ => return Err("Unsupported Gemini operation".to_string()),
            }
        }
        "mistral" => {
            let host = "api.mistral.ai";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.mistral.ai/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.mistral.ai/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "xai" => {
            let host = "api.x.ai";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.x.ai/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.x.ai/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "deepseek" => {
            let host = "api.deepseek.com";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.deepseek.com/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.deepseek.com/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "groq" => {
            let host = "api.groq.com";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.groq.com/openai/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.groq.com/openai/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "cerebras" => {
            let host = "api.cerebras.ai";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.cerebras.ai/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.cerebras.ai/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "openrouter" => {
            let host = "openrouter.ai";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://openrouter.ai/api/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://openrouter.ai/api/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "together" => {
            let host = "api.together.xyz";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.together.xyz/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.together.xyz/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "fireworks" => {
            let host = "api.fireworks.ai";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.fireworks.ai/inference/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.fireworks.ai/inference/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "moonshot" => {
            let host = "api.moonshot.ai";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.moonshot.ai/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.moonshot.ai/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "dashscope" | "qwen" => {
            let host = "dashscope-intl.aliyuncs.com";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        "typesafe" => {
            let host = "api.typesafe.ai";
            match request.operation.as_str() {
                "models" => (host, reqwest::Method::GET, "https://api.typesafe.ai/v1/models".to_string(), None),
                "chat_completions" => (host, reqwest::Method::POST, "https://api.typesafe.ai/v1/chat/completions".to_string(), Some(request.body.clone())),
                _ => return Err("Unsupported operation".to_string()),
            }
        }
        _ => return Err("Unknown provider".to_string()),
    };

    if !crate::policy::MODEL_API_HOSTS.contains(&host) {
        return Err(format!("Unapproved provider destination: {host}"));
    }

    let resolved = cached_resolve_public_addresses(host)?;
    let client = get_or_create_client(Some(host), Some(&resolved))?;

    let auth_header = match request.provider.as_str() {
        "anthropic" => ("x-api-key", cred),
        "gemini" => ("x-goog-api-key", cred),
        _ => ("authorization", format!("Bearer {cred}")),
    };

    Ok((client, method, url, Some(auth_header), body))
}

fn send_provider_error(sender: &Input, queued: &Arc<AtomicUsize>, id: &str, message: &str) {
    let error_frame = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "id": id,
        "type": "provider_error",
        "message": if message.len() > 512 { &message[..512] } else { message },
    });
    send_frame(sender, queued, error_frame);
}

fn send_frame(sender: &Input, queued: &Arc<AtomicUsize>, message: serde_json::Value) {
    if let Some(input) = sender.lock().unwrap().as_ref() {
        let _ = queue_input(input, queued, message);
    }
}

pub struct Engine {
    pub child: Mutex<Option<Child>>,
    input: Input,
    queued: Arc<AtomicUsize>,
    pending: Pending,
    pub backend: Result<Backend, String>,
}

fn control_error_status(error: &ControlError) -> ControlStatus {
    match error {
        ControlError::QueueFull | ControlError::TimedOut => ControlStatus::Overloaded,
        ControlError::Admission(
            AdmissionError::CandidateIdentityConflict
            | AdmissionError::CandidateSessionMismatch
            | AdmissionError::CanonicalRevisionConflict
            | AdmissionError::CanonicalSessionOwned
            | AdmissionError::InvalidCandidate
            | AdmissionError::InvalidIdentity
            | AdmissionError::CapacityUnavailable(_)
            | AdmissionError::UnconfiguredResource(_)
            | AdmissionError::ReservedForControl(_)
            | AdmissionError::RootLimit(_)
            | AdmissionError::UnknownLease,
        )
        | ControlError::Store(StoreError::SessionRevisionConflict | StoreError::TooLarge)
        | ControlError::Admission(AdmissionError::TaskCapabilityUnavailable)
        | ControlError::TaskState(
            StateError::ExecutionFenceStale | StateError::WorkspaceGrantStale,
        ) => ControlStatus::Refused,
        _ => ControlStatus::Unavailable,
    }
}

fn control_error_code(error: &ControlError) -> &'static str {
    match error {
        ControlError::QueueFull => "native_control_overloaded",
        ControlError::TimedOut => "native_control_timeout",
        ControlError::Admission(AdmissionError::RootNotFound) => "root_not_found",
        ControlError::Admission(AdmissionError::CanonicalRevisionConflict) => {
            "canonical_revision_conflict"
        }
        ControlError::Admission(AdmissionError::CandidateIdentityConflict) => {
            "candidate_identity_conflict"
        }
        ControlError::Admission(AdmissionError::CandidateSessionMismatch) => {
            "candidate_session_mismatch"
        }
        ControlError::Admission(AdmissionError::CanonicalSessionOwned) => {
            "canonical_session_owned"
        }
        ControlError::TaskState(StateError::ExecutionFenceStale) => "execution_fence_stale",
        ControlError::TaskState(StateError::WorkspaceGrantStale) => "workspace_grant_stale",
        ControlError::TaskState(StateError::InvalidTransition(_)) => "root_not_running",
        ControlError::Admission(AdmissionError::TaskCapabilityUnavailable) => "task_runtime_owned",
        ControlError::Admission(AdmissionError::InvalidCandidate) => "invalid_candidate",
        ControlError::Store(StoreError::TooLarge) => "candidate_too_large",
        ControlError::Store(StoreError::SessionRevisionConflict) => "session_revision_conflict",
        ControlError::Admission(AdmissionError::InvalidIdentity) => "invalid_session_identity",
        ControlError::Store(StoreError::UnsupportedDurability) => "durability_unavailable",
        ControlError::Admission(AdmissionError::CapacityUnavailable(_)) => "capacity_unavailable",
        ControlError::Admission(AdmissionError::UnconfiguredResource(_)) => "unconfigured_resource",
        ControlError::Admission(AdmissionError::ReservedForControl(_)) => "reserved_for_control",
        ControlError::Admission(AdmissionError::RootLimit(_)) => "root_limit_exceeded",
        ControlError::Admission(AdmissionError::UnknownLease) => "unknown_lease",
        _ => "native_control_unavailable",
    }
}
impl Engine {
    pub fn failed(error: String) -> Self {
        Self { child: Mutex::new(None), input: Arc::new(Mutex::new(None)), queued: Arc::new(AtomicUsize::new(0)), pending: Arc::new(Mutex::new(HashMap::new())), backend: Err(error) }
    }
    fn send(&self, message: serde_json::Value) -> Result<(), String> {
        let input = self.input.lock().unwrap().clone().ok_or("Engine connection closed")?;
        queue_input(&input, &self.queued, message)
    }
    pub fn close(&self) { self.input.lock().unwrap().take(); }
}

fn queue_input(input: &SyncSender<Vec<u8>>, queued: &AtomicUsize, message: serde_json::Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let size = bytes.len();
    queued.try_update(Ordering::AcqRel, Ordering::Relaxed, |n| n.checked_add(size).filter(|sum| *sum <= MAX_QUEUE)).map_err(|_| "Engine input queue is full")?;
    let result = input.try_send(bytes).map_err(|_| "Engine input queue is full or closed".to_owned());
    if result.is_err() { queued.fetch_sub(size, Ordering::AcqRel); }
    result
}

fn fail_pending(pending: &Pending) {
    for (id, channel) in pending.lock().unwrap().drain() {
        let _ = channel.send(Frame { v: PROTOCOL_VERSION, id, event: Output::Error { message: "Engine connection closed".into() } });
    }
}

#[cfg(test)]
pub fn start(cmd: Command, control: Option<ControlHandle>) -> Engine {
    start_with_dispatch(cmd, control, None, None)
}

pub fn start_with_dispatch(
    mut cmd: Command,
    control: Option<ControlHandle>,
    dispatch_context: Option<(String, PathBuf)>,
    helper: Option<PathBuf>,
) -> Engine {
    let mut child = match cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
        Ok(child) => child,
        Err(e) => return Engine::failed(format!("Could not start the engine: {e}")),
    };
    let mut input = child.stdin.take().expect("piped stdin");
    let mut reader = BufReader::new(child.stdout.take().expect("piped stdout"));
    let (ready_tx, ready_rx) = sync_channel(1);
    std::thread::spawn(move || {
        let mut ready = String::new();
        let result = reader.by_ref().take(4096).read_line(&mut ready);
        let valid = result.is_ok() && ready.strip_prefix("VAK_READY ").and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()).is_some_and(|v| v["version"] == PROTOCOL_VERSION && v["transport"] == "stdio");
        let _ = ready_tx.send((valid, reader));
    });
    let result = ready_rx.recv_timeout(std::time::Duration::from_secs(10));
    let mut reader = match result {
        Ok((true, reader)) => reader,
        _ => {
        let _ = child.kill(); let _ = child.wait();
        return Engine::failed("Engine did not complete the private protocol handshake".into());
        }
    };
    let (tx, rx) = sync_channel::<Vec<u8>>(512);
    let sender = Arc::new(Mutex::new(Some(tx)));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let queued = Arc::new(AtomicUsize::new(0));
    let queue_size = queued.clone();
    let writer_pending = pending.clone();
    std::thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            let result = input.write_all(&bytes);
            queue_size.fetch_sub(bytes.len(), Ordering::AcqRel);
            if result.is_err() { fail_pending(&writer_pending); break; }
        }
        // Dropping the only stdin writer terminates the child even after a crash.
    });
    let sandbox_control = control.clone();
    let (control_tx, control_rx) = sync_channel::<ControlRequest>(2);
    let control_writer = sender.clone();
    let control_queue_size = queued.clone();
    std::thread::spawn(move || {
        while let Ok(request) = control_rx.recv() {
            let response = match request.operation {
                ControlOperation::Health => {
                    let status = match control.as_ref() {
                        Some(actor) if actor.ping().is_ok() => ControlStatus::Ready,
                        _ => ControlStatus::Unavailable,
                    };
                    bridge::Response::new(&request.id, status)
                }
                ControlOperation::CandidateCommit(candidate) => {
                    match candidate.into_request() {
                        Ok(candidate) => match control.as_ref() {
                            Some(actor) => match actor.commit_app_candidate(candidate) {
                                Ok(receipt) => bridge::Response::candidate(
                                    &request.id,
                                    ControlStatus::Committed,
                                    Some(receipt),
                                    None,
                                ),
                                Err(error) => {
                                    let code = control_error_code(&error);
                                    bridge::Response::candidate(
                                        &request.id,
                                        control_error_status(&error),
                                        None,
                                        Some(code),
                                    )
                                }
                            },
                            None => bridge::Response::candidate(
                                &request.id,
                                ControlStatus::Unavailable,
                                None,
                                Some("native_control_unavailable"),
                            ),
                        },
                        Err(code) => bridge::Response::candidate(
                            &request.id,
                            ControlStatus::Refused,
                            None,
                            Some(code),
                        ),
                    }
                }
                ControlOperation::SessionLoad { session_id } => match control.as_ref() {
                    Some(actor) => match actor.load_host_session(session_id) {
                        Ok(Some((revision, snapshot))) => bridge::Response::session_snapshot(
                            &request.id, ControlStatus::Loaded, Some(revision), Some(snapshot), None),
                        Ok(None) => bridge::Response::session_snapshot(&request.id, ControlStatus::Refused, None, None, Some("session_not_found")),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::SessionSave { session_id, expected_revision, snapshot } => match control.as_ref() {
                    Some(actor) => match actor.save_host_session(session_id, expected_revision, snapshot) {
                        Ok(revision) => bridge::Response::session_snapshot(&request.id, ControlStatus::Saved, Some(revision), None, None),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::SessionList {} => match control.as_ref() {
                    Some(actor) => match actor.list_host_sessions() {
                        Ok(sessions) => bridge::Response::sessions(&request.id, sessions),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::SessionRemove { session_id, expected_revision } => match control.as_ref() {
                    Some(actor) => match actor.remove_host_session(session_id, expected_revision) {
                        Ok(()) => bridge::Response::session_snapshot(&request.id, ControlStatus::Removed, None, None, None),
                        Err(error) => bridge::Response::session_snapshot(&request.id, control_error_status(&error), None, None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::session_snapshot(&request.id, ControlStatus::Unavailable, None, None, Some("native_control_unavailable")),
                },
                ControlOperation::CapacityReserve { request_id, root_id, amounts } => match control.as_ref() {
                    Some(actor) => match actor.reserve(request_id, root_id, amounts) {
                        Ok(lease) => bridge::Response::capacity_reserve(&request.id, ControlStatus::Reserved, Some(lease), None),
                        Err(error) => bridge::Response::capacity_reserve(&request.id, control_error_status(&error), None, Some(control_error_code(&error))),
                    },
                    None => bridge::Response::capacity_reserve(&request.id, ControlStatus::Unavailable, None, Some("native_control_unavailable")),
                },
                ControlOperation::CapacityRelease { lease } => match control.as_ref() {
                    Some(actor) => match actor.release(lease) {
                        Ok(()) => bridge::Response::capacity_release(&request.id, ControlStatus::Released, None),
                        Err(error) => bridge::Response::capacity_release(&request.id, control_error_status(&error), Some(control_error_code(&error))),
                    },
                    None => bridge::Response::capacity_release(&request.id, ControlStatus::Unavailable, Some("native_control_unavailable")),
                },
            };
            let response = serde_json::to_value(response).unwrap();
            let writer = control_writer.lock().unwrap().clone();
            if let Some(writer) = writer {
                let _ = queue_input(&writer, &control_queue_size, response);
            }
        }
    });
    let responses = pending.clone();
    let connection = sender.clone();
    let response_queue = queued.clone();
    let control_requests = control_tx;
    std::thread::spawn(move || {
        loop {
            let mut line = Vec::new();
            let result = reader.by_ref().take(MAX_BRIDGE_FRAME as u64 + 1).read_until(b'\n', &mut line);
            if !matches!(result, Ok(n) if n > 0 && n <= MAX_BRIDGE_FRAME) || !line.ends_with(b"\n") { break; }
            let value = match serde_json::from_slice::<serde_json::Value>(&line) { Ok(value) => value, Err(_) => break };
            if value.get("type").and_then(serde_json::Value::as_str) == Some("control_request") {
                let request = match ControlRequest::decode_value(value, line.len()) { Ok(request) => request, Err(_) => break };
                match control_requests.try_send(request) {
                    Ok(()) => continue,
                    Err(TrySendError::Full(request)) => {
                        let response = match request.operation {
                            ControlOperation::Health => bridge::Response::new(&request.id, ControlStatus::Overloaded),
                            ControlOperation::CandidateCommit(_) => bridge::Response::candidate(
                                &request.id,
                                ControlStatus::Overloaded,
                                None,
                                Some("native_control_queue_full"),
                            ),
                            _ => bridge::Response::candidate(
                                &request.id,
                                ControlStatus::Overloaded,
                                None,
                                Some("native_control_queue_full"),
                            ),
                        };
                        let response = serde_json::to_value(response).unwrap();
                        let input = connection.lock().unwrap().clone();
                        let Some(input) = input else { break; };
                        if queue_input(&input, &response_queue, response).is_err() { break; }
                        continue;
                    }
                    Err(TrySendError::Disconnected(_)) => break,
                }
            }
            if let Some(msg_type) = value.get("type").and_then(serde_json::Value::as_str) {
                if msg_type == "provider_ack" || msg_type == "provider_cancel" {
                    continue;
                }
            }
            if value.get("type").and_then(serde_json::Value::as_str) == Some("sandbox_request") {
                let Some(id) = value.get("id").and_then(serde_json::Value::as_str).filter(|id| id.starts_with("sbx-") && valid_id(id)).map(str::to_owned) else { continue; };
                let (sender, queued) = (connection.clone(), response_queue.clone());
                let context = match (&dispatch_context, &helper) {
                    (Some((_, data_dir)), Some(helper)) => Some(crate::sandbox::Context { helper: helper.clone(), data_dir: data_dir.clone(), control: sandbox_control.clone() }),
                    _ => None,
                };
                tauri::async_runtime::spawn_blocking(move || {
                    let outcome = match (context, serde_json::from_value::<crate::sandbox::SandboxRequest>(value)) {
                        (Some(context), Ok(request)) => crate::sandbox::handle(&context, &request, PROTOCOL_VERSION),
                        (None, _) => Err("Native sandbox is not enabled".into()),
                        (_, Err(_)) => Err("Malformed sandbox request".into()),
                    };
                    let frame = match outcome {
                        Ok(result) => serde_json::json!({ "v": PROTOCOL_VERSION, "id": id, "type": "sandbox_result", "result": result }),
                        Err(message) => serde_json::json!({ "v": PROTOCOL_VERSION, "id": id, "type": "sandbox_error", "message": message.chars().take(2048).collect::<String>() }),
                    };
                    send_frame(&sender, &queued, frame);
                });
                continue;
            }
            if value.get("type").and_then(serde_json::Value::as_str) == Some("egress_request") {
                let Some(id) = value.get("id").and_then(serde_json::Value::as_str).filter(|id| id.starts_with("egr-") && valid_id(id)).map(str::to_owned) else { continue; };
                let Some((service, data_dir)) = dispatch_context.clone() else {
                    send_provider_error(&connection, &response_queue, &id, "Native egress is not enabled");
                    continue;
                };
                match serde_json::from_value::<crate::egress::EgressRequest>(value) {
                    Ok(request) => {
                        let (sender, queued) = (connection.clone(), response_queue.clone());
                        tauri::async_runtime::spawn(dispatch_egress_request(request, sender, queued, service, data_dir));
                    }
                    Err(_) => send_provider_error(&connection, &response_queue, &id, "Malformed egress request"),
                }
                continue;
            }
            if value.get("type").and_then(serde_json::Value::as_str) == Some("provider_request") {
                let request = match serde_json::from_value::<ProviderRequest>(value.clone()) {
                    Ok(request) if request.validate() => request,
                    Ok(request) => {
                        send_provider_error(&connection, &response_queue, &request.id, "Invalid provider request");
                        continue;
                    }
                    Err(err) => {
                        if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
                            send_provider_error(&connection, &response_queue, id, &format!("Malformed provider request: {err}"));
                        }
                        continue;
                    }
                };
                if dispatch_context.is_none() {
                    let input = connection.lock().unwrap().clone();
                    let Some(input) = input else { break; };
                    if queue_input(&input, &response_queue, provider_refusal(&request.id)).is_err() { break; }
                    continue;
                }
                let sender = connection.clone();
                let queued = response_queue.clone();
                let d_ctx = dispatch_context.clone();
                tauri::async_runtime::spawn(async move {
                    dispatch_provider_request(request, sender, queued, d_ctx).await;
                });
                continue;
            }
            let frame = match serde_json::from_value::<Frame>(value) { Ok(frame) if frame.v == PROTOCOL_VERSION => frame, _ => break };
            let terminal = matches!(frame.event, Output::End | Output::Error { .. });
            let channel = { let mut map = responses.lock().unwrap(); if terminal { map.remove(&frame.id) } else { map.get(&frame.id).cloned() } };
            if let Some(channel) = channel {
                let id = frame.id.clone();
                if channel.send(frame).is_err() {
                    responses.lock().unwrap().remove(&id);
                    let cancel = serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"cancel"});
                    if let Some(input) = connection.lock().unwrap().as_ref() { let _ = queue_input(input, &response_queue, cancel); }
                }
            }
        }
        connection.lock().unwrap().take();
        fail_pending(&responses);
    });
    Engine { child: Mutex::new(Some(child)), input: sender, queued, pending, backend: Ok(Backend { url: "vak://localhost".into(), token: String::new() }) }
}

fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }
pub fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost")) || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"));
    let dev = cfg!(debug_assertions) && url.scheme() == "http" && [Some("localhost"), Some("127.0.0.1")].contains(&url.host_str()) && url.port() == Some(1420);
    if (window.label() != "main" && window.label() != "admin") || !(local || dev) { return Err("Engine IPC is restricted to app windows".into()); }
    Ok(())
}

#[tauri::command]
#[expect(clippy::too_many_arguments, reason = "Tauri maps this flat named IPC schema to command parameters")]
pub async fn engine_request(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String, method: String, path: String, headers: BTreeMap<String, String>, body: Option<String>, channel: Channel<Frame>) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) || !["GET", "POST", "PUT", "DELETE"].contains(&method.as_str()) || !path.starts_with("/api/") || path.len() > 8192 || path.contains(['\r', '\n', '#']) || body.as_ref().is_some_and(|b| b.len() > MAX_BODY || method == "GET") || headers.len() > 2 || headers.iter().any(|(k,v)| !["content-type", "range"].contains(&k.as_str()) || v.len() > 256 || v.contains(['\r', '\n'])) { return Err("Invalid engine request".into()); }
    { let mut pending = state.pending.lock().unwrap(); if pending.len() >= 32 || pending.contains_key(&id) { return Err("Too many engine requests or duplicate identity".into()); } pending.insert(id.clone(), channel); }
    let mut message = serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"request","method":method,"path":path,"headers":headers});
    if let Some(body) = body { message["body"] = body.into(); }
    if let Err(error) = state.send(message) { state.pending.lock().unwrap().remove(&id); return Err(error); }
    Ok(())
}

#[tauri::command]
pub fn engine_ack(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) { return Err("Invalid request identity".into()); }
    state.send(serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"ack"}))
}
#[tauri::command]
pub fn engine_cancel(window: tauri::WebviewWindow, state: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    main_window(&window)?;
    if !valid_id(&id) { return Err("Invalid request identity".into()); }
    state.pending.lock().unwrap().remove(&id);
    state.send(serde_json::json!({"v":PROTOCOL_VERSION,"id":id,"type":"cancel"}))
}

#[cfg(test)]
mod tests {
    fn egress_frames(data: &std::path::Path, body: &str) -> Vec<serde_json::Value> {
        let (tx, rx) = sync_channel::<Vec<u8>>(512);
        let sender: Input = Arc::new(Mutex::new(Some(tx)));
        let request: crate::egress::EgressRequest = serde_json::from_value(serde_json::json!({
            "v": PROTOCOL_VERSION, "id": "egr-live", "type": "egress_request", "url": "https://mcp.nseindia.in/bhavcopy/cm/mcp", "method": "POST",
            "headers": { "content-type": "application/json", "accept": "application/json, text/event-stream" }, "body": body,
        })).unwrap();
        tauri::async_runtime::block_on(dispatch_egress_request(request, sender.clone(), Arc::new(AtomicUsize::new(0)), "vak-test".into(), data.to_path_buf()));
        sender.lock().unwrap().take();
        rx.iter().map(|bytes| serde_json::from_slice(&bytes).unwrap()).collect()
    }

    /// Live: `cargo test --lib egress_reaches_nse_only_after_approval -- --ignored`.
    #[test]
    #[ignore = "contacts mcp.nseindia.in"]
    fn egress_reaches_nse_only_after_approval() {
        let base = std::env::temp_dir().join(format!("vak-egress-live-{}", std::process::id()));
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"vak-check","version":"0"}}}"#;
        let refused = egress_frames(&data, init);
        assert_eq!(refused.len(), 1);
        assert!(refused[0]["message"].as_str().unwrap().contains("needs your approval"), "{refused:?}");
        crate::egress::set_approval(&data, "mcp.nseindia.in", true).unwrap();
        let frames = egress_frames(&data, init);
        assert_eq!(frames[0]["type"], "provider_headers", "{frames:?}");
        assert_eq!(frames[0]["status"], 200);
        assert!(frames[0]["headers"]["mcp-session-id"].is_string());
        assert_eq!(frames.last().unwrap()["type"], "provider_end");
        let body: String = frames.iter().filter(|f| f["type"] == "provider_data").map(|f| {
            let mut bits = 0u32; let mut n = 0; let mut out = Vec::new();
            for c in f["data"].as_str().unwrap().bytes().filter(|c| *c != b'=') {
                let v = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".iter().position(|x| *x == c).unwrap() as u32;
                bits = (bits << 6) | v; n += 6;
                if n >= 8 { n -= 8; out.push((bits >> n) as u8); }
            }
            String::from_utf8(out).unwrap()
        }).collect();
        assert!(body.contains("serverInfo"), "{body}");
        std::fs::remove_dir_all(base).unwrap();
    }

    use super::*;
    use crate::control::{CapacityProfile, ControlActor};

    #[test]
    fn identifiers_and_output_frames_are_bounded_and_typed() {
        assert!(valid_id("request-123")); assert!(!valid_id("../request")); assert!(!valid_id(&"a".repeat(65)));
        assert!(serde_json::from_str::<Frame>(r#"{"v":2,"id":"x","type":"shell","command":"bad"}"#).is_err());
        let frame: Frame = serde_json::from_str(r#"{"v":2,"id":"x","type":"data","data":"AAE="}"#).unwrap();
        assert!(matches!(frame.event, Output::Data { .. }));
    }

    #[test]
    fn provider_frames_are_registered_operation_records_without_destinations() {
        let request: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-123","type":"provider_request","provider":"openai","operation":"responses","body":"{}","operationId":"root-op-1","attempt":1,"sessionId":"session-1","runId":"run-1"}"#,
        ).unwrap();
        assert!(request.validate());
        let gemini: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-124","type":"provider_request","provider":"gemini","operation":"stream_generate_content","routeModel":"gemini-2.5-flash","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"session-1","runId":"run-1"}"#,
        ).unwrap();
        assert!(gemini.validate());
        let ollama_tags: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-tags","type":"provider_request","provider":"ollama","operation":"ollama_tags","body":"","operationId":"root-op-1","attempt":0}"#,
        ).unwrap();
        assert!(ollama_tags.validate());
        let ollama_show: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-show","type":"provider_request","provider":"ollama","operation":"ollama_show","body":"{\"model\":\"qwen3.5:4b-mlx\"}","operationId":"root-op-1","attempt":0}"#,
        ).unwrap();
        assert!(ollama_show.validate());
        let openai_models: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-models","type":"provider_request","provider":"openai","operation":"models","body":"","operationId":"root-op-1","attempt":0}"#,
        ).unwrap();
        assert!(openai_models.validate());
        let invalid_execution_identity: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-invalid","type":"provider_request","provider":"openai","operation":"responses","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"../session","runId":"run-1"}"#,
        ).unwrap();
        assert!(!invalid_execution_identity.validate());
        let mismatched: ProviderRequest = serde_json::from_str(
            r#"{"v":2,"id":"gen-125","type":"provider_request","provider":"openai","operation":"messages","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"session-1","runId":"run-1"}"#,
        ).unwrap();
        assert!(!mismatched.validate());
        assert!(serde_json::from_str::<ProviderRequest>(
            r#"{"v":2,"id":"gen-126","type":"provider_request","provider":"openai","operation":"responses","url":"https://attacker.example","body":"{}","operationId":"root-op-1","attempt":0}"#,
        ).is_err());
    }




    #[cfg(unix)]
    #[test]
    fn private_child_pipe_round_trips_health_to_native_control_actor() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("vak-engine-control-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let actor = ControlActor::open(
            &root,
            "unconfigured-v1",
            CapacityProfile::unconfigured().unwrap(),
            32,
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        let response_path = root.join("control-response.json");
        let script = r#"printf 'VAK_READY {"transport":"stdio","version":2}\n'
printf '{"v":2,"id":"ctl-fixture","type":"control_request","operation":"health"}\n'
IFS= read -r response
printf '%s' "$response" > "$1"
"#;
        let mut command = Command::new("sh");
        command.arg("-c").arg(script).arg("fixture").arg(&response_path);
        let engine = start(command, Some(actor.handle()));
        assert!(engine.backend.is_ok());
        let mut child = engine.child.lock().unwrap().take().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("private control health response timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let response: serde_json::Value = serde_json::from_slice(&std::fs::read(&response_path).unwrap()).unwrap();
        assert_eq!(response["v"], PROTOCOL_VERSION);
        assert_eq!(response["id"], "ctl-fixture");
        assert_eq!(response["type"], "control_response");
        assert_eq!(response["status"], "ready");
        drop(engine);
        drop(actor);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_provider_pipe_returns_typed_fail_closed_response() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("vak-engine-provider-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let response_path = root.join("provider-response.json");
        let script = r#"echo 'VAK_READY {"transport":"stdio","version":2}'
echo '{"v":2,"id":"gen-fixture","type":"provider_request","provider":"openai","operation":"responses","body":"{}","operationId":"root-op-1","attempt":0,"sessionId":"session-1","runId":"run-1"}'
IFS= read -r response
printf '%s' "$response" > "$1"
"#;
        let mut command = Command::new("sh");
        command.arg("-c").arg(script).arg("fixture").arg(&response_path);
        let engine = start(command, None);
        assert!(engine.backend.is_ok());
        let mut child = engine.child.lock().unwrap().take().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(std::time::Instant::now() < deadline, "provider frame response timed out");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let response: serde_json::Value = serde_json::from_slice(&std::fs::read(&response_path).unwrap()).unwrap();
        assert_eq!(response["id"], "gen-fixture");
        assert_eq!(response["type"], "provider_error");
        assert_eq!(response["message"], "Native provider dispatch is not enabled");
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }
}
