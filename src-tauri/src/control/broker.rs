//! Native HTTP transport primitive for the provider broker.
//!
//! This is intentionally not wired to worker requests yet. Provider operation
//! schemas, task authorization, approval, cancellation and operation receipts
//! must be composed before this client can dispatch product traffic.

use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ModelApi {
    OllamaLocal,
    OpenAi,
    Anthropic,
    Gemini,
    Mistral,
    Xai,
    DeepSeek,
    Groq,
    Cerebras,
    OpenRouter,
    Together,
    Fireworks,
    Moonshot,
    DashScope,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ModelOperation {
    OllamaChat,
    Responses,
    ChatCompletions,
    Messages,
    StreamGenerateContent { model: String },
}

#[derive(Debug)]
pub(super) enum BrokerError {
    InvalidEndpoint,
    UnsupportedOperation,
    UnapprovedDestination,
    InvalidPayload,
    ModelMismatch,
    OutputLimitExceeded,
    ToolNotAllowed,
    CredentialUnavailable,
    RequestTooLarge,
    ResponseTooLarge,
    Transport,
}

/// Created only after native admission has resolved the provider/model,
/// cumulative output allowance and exact tool-name subset for this call.
pub(super) struct GenerationPermit {
    provider: ModelApi,
    operation: ModelOperation,
    model: String,
    max_output_tokens: u32,
    max_request_bytes: usize,
    allowed_tools: BTreeSet<String>,
    allowed_extras: BTreeMap<String, Value>,
}

impl GenerationPermit {
    pub(super) fn from_admitted_policy(
        provider: ModelApi,
        operation: ModelOperation,
        model: String,
        max_output_tokens: u32,
        max_request_bytes: usize,
        allowed_tools: BTreeSet<String>,
        allowed_extras: BTreeMap<String, Value>,
    ) -> Result<Self, BrokerError> {
        if !valid_model_id(&model)
            || max_output_tokens == 0
            || max_request_bytes == 0
            || max_request_bytes > MAX_REQUEST_BYTES
        {
            return Err(BrokerError::InvalidPayload);
        }
        let endpoint = model_endpoint(provider, operation.clone())?;
        if matches!(provider, ModelApi::Gemini)
            && !matches!(operation, ModelOperation::StreamGenerateContent { model: ref route_model } if route_model == &model)
        {
            return Err(BrokerError::ModelMismatch);
        }
        if !matches!(provider, ModelApi::Gemini) && endpoint.host_str().is_none() {
            return Err(BrokerError::InvalidEndpoint);
        }
        if allowed_tools
            .iter()
            .any(|name| name.is_empty() || name.len() > 128 || name.chars().any(char::is_control))
        {
            return Err(BrokerError::InvalidPayload);
        }
        if allowed_extras.iter().any(|(name, _)| {
            name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        }) {
            return Err(BrokerError::InvalidPayload);
        }
        Ok(Self {
            provider,
            operation,
            model,
            max_output_tokens,
            max_request_bytes,
            allowed_tools,
            allowed_extras,
        })
    }
}

pub(super) struct NativeHttpClient {
    service: String,
    data_dir: PathBuf,
}

impl NativeHttpClient {
    pub(super) fn new(service: String, data_dir: PathBuf) -> Self {
        Self { service, data_dir }
    }

    /// POST JSON to one registered model generation route. Callers cannot
    /// supply an origin, path, headers or proxy policy. The permit validates
    /// the request envelope before it crosses the network boundary.
    /// Dispatches one admitted request and exposes its bounded response body
    /// incrementally so a future broker bridge can apply backpressure.
    pub(super) fn post_provider_json_stream(
        &self,
        permit: &GenerationPermit,
        body: &[u8],
    ) -> Result<BrokerStreamResponse, BrokerError> {
        let url = model_endpoint(permit.provider, permit.operation.clone())?;
        if body.len() > permit.max_request_bytes {
            return Err(BrokerError::RequestTooLarge);
        }
        let body = prepare_generation_body(permit, body)?;
        let client = if permit.provider == ModelApi::OllamaLocal {
            build_client(None)?
        } else {
            let host = url.host_str().ok_or(BrokerError::InvalidEndpoint)?;
            let addresses = resolve_public_addresses(host)?;
            build_client(Some((host, &addresses)))?
        };
        let credential = self.credential(permit.provider)?;
        let request = provider_post(client, url, permit.provider, credential.as_deref())?;
        let response = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .map_err(|_| BrokerError::Transport)?;
        bounded_stream_response(response)
    }

    fn credential(&self, provider: ModelApi) -> Result<Option<String>, BrokerError> {
        let Some(account) = credential_account(provider) else {
            return Ok(None);
        };
        crate::vault::get(&self.service, account, &self.data_dir)
            .map_err(|_| BrokerError::CredentialUnavailable)?
            .filter(|value| !value.is_empty())
            .map(Some)
            .ok_or(BrokerError::CredentialUnavailable)
    }
}

fn provider_post(
    client: Client,
    url: Url,
    provider: ModelApi,
    credential: Option<&str>,
) -> Result<reqwest::blocking::RequestBuilder, BrokerError> {
    match (provider, credential) {
        (ModelApi::OllamaLocal, None) => Ok(client.post(url)),
        (ModelApi::OllamaLocal, Some(_)) => Err(BrokerError::InvalidPayload),
        (_, Some(credential)) => apply_provider_auth(client.post(url), provider, credential),
        (_, None) => Err(BrokerError::CredentialUnavailable),
    }
}

fn credential_account(provider: ModelApi) -> Option<&'static str> {
    match provider {
        ModelApi::OllamaLocal => None,
        ModelApi::OpenAi => Some("OPENAI_API_KEY"),
        ModelApi::Anthropic => Some("ANTHROPIC_API_KEY"),
        ModelApi::Gemini => Some("GEMINI_API_KEY"),
        ModelApi::Mistral => Some("MISTRAL_API_KEY"),
        ModelApi::Xai => Some("XAI_API_KEY"),
        ModelApi::DeepSeek => Some("DEEPSEEK_API_KEY"),
        ModelApi::Groq => Some("GROQ_API_KEY"),
        ModelApi::Cerebras => Some("CEREBRAS_API_KEY"),
        ModelApi::OpenRouter => Some("OPENROUTER_API_KEY"),
        ModelApi::Together => Some("TOGETHER_API_KEY"),
        ModelApi::Fireworks => Some("FIREWORKS_API_KEY"),
        ModelApi::Moonshot => Some("MOONSHOT_API_KEY"),
        ModelApi::DashScope => Some("DASHSCOPE_API_KEY"),
    }
}

fn apply_provider_auth(
    request: reqwest::blocking::RequestBuilder,
    provider: ModelApi,
    credential: &str,
) -> Result<reqwest::blocking::RequestBuilder, BrokerError> {
    let credential = reqwest::header::HeaderValue::from_str(credential)
        .map_err(|_| BrokerError::CredentialUnavailable)?;
    let request = match provider {
        ModelApi::Anthropic => request
            .header("x-api-key", credential)
            .header("anthropic-version", "2023-06-01"),
        ModelApi::Gemini => request.header("x-goog-api-key", credential),
        _ => {
            let bearer = reqwest::header::HeaderValue::from_str(&format!(
                "Bearer {}",
                credential
                    .to_str()
                    .map_err(|_| BrokerError::CredentialUnavailable)?
            ))
            .map_err(|_| BrokerError::CredentialUnavailable)?;
            request.header(reqwest::header::AUTHORIZATION, bearer)
        }
    };
    Ok(request)
}

fn build_client(resolution: Option<(&str, &[SocketAddr])>) -> Result<Client, BrokerError> {
    let builder = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120));
    let builder = match resolution {
        Some((host, addresses)) if !addresses.is_empty() => {
            builder.resolve_to_addrs(host, addresses)
        }
        Some(_) => return Err(BrokerError::UnapprovedDestination),
        None => builder,
    };
    builder.build().map_err(|_| BrokerError::Transport)
}

fn resolve_public_addresses(host: &str) -> Result<Vec<SocketAddr>, BrokerError> {
    let resolved = (host, 443)
        .to_socket_addrs()
        .map_err(|_| BrokerError::Transport)?;
    validate_public_addresses(resolved)
}

fn validate_public_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
) -> Result<Vec<SocketAddr>, BrokerError> {
    let addresses = addresses.into_iter().collect::<BTreeSet<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !is_public_unicast(address.ip()))
    {
        return Err(BrokerError::UnapprovedDestination);
    }
    Ok(addresses.into_iter().collect())
}

/// Conservative public-unicast check based on the IANA special-purpose
/// registries. Provider names are separately fixed by `model_endpoint`; these
/// ranges prevent a compromised resolver from mapping one to local services.
fn is_public_unicast(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let blocked = [
                (Ipv4Addr::new(0, 0, 0, 0), 8),
                (Ipv4Addr::new(10, 0, 0, 0), 8),
                (Ipv4Addr::new(100, 64, 0, 0), 10),
                (Ipv4Addr::new(127, 0, 0, 0), 8),
                (Ipv4Addr::new(169, 254, 0, 0), 16),
                (Ipv4Addr::new(172, 16, 0, 0), 12),
                (Ipv4Addr::new(192, 0, 0, 0), 24),
                (Ipv4Addr::new(192, 0, 2, 0), 24),
                (Ipv4Addr::new(192, 88, 99, 0), 24),
                (Ipv4Addr::new(192, 168, 0, 0), 16),
                (Ipv4Addr::new(198, 18, 0, 0), 15),
                (Ipv4Addr::new(198, 51, 100, 0), 24),
                (Ipv4Addr::new(203, 0, 113, 0), 24),
                (Ipv4Addr::new(224, 0, 0, 0), 4),
                (Ipv4Addr::new(240, 0, 0, 0), 4),
            ];
            !blocked
                .iter()
                .any(|(network, prefix)| ipv4_in_subnet(address, *network, *prefix))
        }
        IpAddr::V6(address) => {
            ipv6_in_subnet(address, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
                && !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_unique_local()
                && !address.is_unicast_link_local()
                && !ipv6_in_subnet(address, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23)
                && !ipv6_in_subnet(address, Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32)
                && !ipv6_in_subnet(address, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)
                && !ipv6_in_subnet(address, Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20)
        }
    }
}

fn ipv4_in_subnet(address: Ipv4Addr, network: Ipv4Addr, prefix: u8) -> bool {
    let mask = u32::MAX << (32 - u32::from(prefix));
    u32::from(address) & mask == u32::from(network) & mask
}

fn ipv6_in_subnet(address: Ipv6Addr, network: Ipv6Addr, prefix: u8) -> bool {
    let mask = u128::MAX << (128 - u32::from(prefix));
    u128::from(address) & mask == u128::from(network) & mask
}

fn valid_model_id(model: &str) -> bool {
    !model.trim().is_empty()
        && model.trim() == model
        && model.len() <= 256
        && !model.chars().any(char::is_control)
}

fn prepare_generation_body(permit: &GenerationPermit, body: &[u8]) -> Result<Vec<u8>, BrokerError> {
    if body.len() > permit.max_request_bytes {
        return Err(BrokerError::RequestTooLarge);
    }
    let mut value: Value = serde_json::from_slice(body).map_err(|_| BrokerError::InvalidPayload)?;
    let object = value.as_object_mut().ok_or(BrokerError::InvalidPayload)?;
    if [
        "api_key",
        "authorization",
        "headers",
        "base_url",
        "endpoint",
        "url",
    ]
    .iter()
    .any(|name| object.contains_key(*name))
    {
        return Err(BrokerError::InvalidPayload);
    }
    if permit.provider == ModelApi::Gemini {
        if object.contains_key("model") {
            return Err(BrokerError::ModelMismatch);
        }
    } else if object.get("model").and_then(Value::as_str) != Some(&permit.model) {
        return Err(BrokerError::ModelMismatch);
    }
    validate_operation_model(permit)?;
    validate_generation_fields(permit, object)?;
    enforce_output_limit(permit, object)?;
    validate_tool_names(permit, object)?;
    if matches!(permit.operation, ModelOperation::Responses) {
        object.insert("store".into(), Value::Bool(false));
    }
    let prepared = serde_json::to_vec(&value).map_err(|_| BrokerError::InvalidPayload)?;
    if prepared.len() > permit.max_request_bytes {
        return Err(BrokerError::RequestTooLarge);
    }
    Ok(prepared)
}

fn validate_generation_fields(
    permit: &GenerationPermit,
    object: &Map<String, Value>,
) -> Result<(), BrokerError> {
    let fixed_fields: &[&str] = match permit.operation {
        ModelOperation::Responses => &[
            "model",
            "stream",
            "store",
            "include",
            "input",
            "instructions",
            "prompt_cache_key",
            "tools",
            "max_output_tokens",
        ],
        ModelOperation::ChatCompletions => &[
            "model",
            "stream",
            "messages",
            "tools",
            "max_tokens",
            "max_completion_tokens",
        ],
        ModelOperation::OllamaChat => {
            &["model", "stream", "messages", "tools", "format", "options"]
        }
        ModelOperation::Messages => &[
            "model",
            "max_tokens",
            "stream",
            "messages",
            "system",
            "tools",
        ],
        ModelOperation::StreamGenerateContent { .. } => {
            &["contents", "systemInstruction", "tools", "generationConfig"]
        }
    };
    for name in fixed_fields {
        if permit.allowed_extras.contains_key(*name) {
            return Err(BrokerError::InvalidPayload);
        }
    }
    for (name, expected) in &permit.allowed_extras {
        if object.get(name) != Some(expected) {
            return Err(BrokerError::InvalidPayload);
        }
    }
    if object.keys().any(|name| {
        !fixed_fields.contains(&name.as_str()) && !permit.allowed_extras.contains_key(name)
    }) {
        return Err(BrokerError::InvalidPayload);
    }
    if matches!(permit.operation, ModelOperation::Responses)
        && object
            .get("store")
            .is_some_and(|store| store.as_bool() != Some(false))
    {
        return Err(BrokerError::InvalidPayload);
    }
    if permit.provider == ModelApi::Gemini
        && let Some(config) = object.get("generationConfig")
        && config
            .as_object()
            .is_none_or(|config| config.keys().any(|key| key != "maxOutputTokens"))
    {
        return Err(BrokerError::InvalidPayload);
    }
    if matches!(permit.operation, ModelOperation::OllamaChat) {
        validate_ollama_options(permit, object)?;
    }
    let (content_field, streaming_field) = match permit.operation {
        ModelOperation::Responses => ("input", Some("stream")),
        ModelOperation::ChatCompletions | ModelOperation::OllamaChat | ModelOperation::Messages => {
            ("messages", Some("stream"))
        }
        ModelOperation::StreamGenerateContent { .. } => ("contents", None),
    };
    if !object.contains_key(content_field) {
        return Err(BrokerError::InvalidPayload);
    }
    if let Some(field) = streaming_field
        && object.get(field).and_then(Value::as_bool) != Some(true)
    {
        return Err(BrokerError::InvalidPayload);
    }
    Ok(())
}

fn validate_operation_model(permit: &GenerationPermit) -> Result<(), BrokerError> {
    if let ModelOperation::StreamGenerateContent { model } = &permit.operation
        && model != &permit.model
    {
        return Err(BrokerError::ModelMismatch);
    }
    Ok(())
}

fn enforce_output_limit(
    permit: &GenerationPermit,
    object: &mut Map<String, Value>,
) -> Result<(), BrokerError> {
    if matches!(permit.operation, ModelOperation::OllamaChat) {
        let options = object
            .get_mut("options")
            .and_then(Value::as_object_mut)
            .ok_or(BrokerError::InvalidPayload)?;
        return enforce_token_field(options, "num_predict", permit.max_output_tokens);
    }
    let disallowed = match permit.operation {
        ModelOperation::Responses => &["max_tokens", "max_completion_tokens"][..],
        ModelOperation::OllamaChat => &[][..],
        ModelOperation::ChatCompletions if permit.provider == ModelApi::OpenAi => {
            &["max_tokens", "max_output_tokens"][..]
        }
        ModelOperation::ChatCompletions => &["max_completion_tokens", "max_output_tokens"][..],
        ModelOperation::Messages => &["max_output_tokens", "max_completion_tokens"][..],
        ModelOperation::StreamGenerateContent { .. } => {
            &["max_tokens", "max_completion_tokens", "max_output_tokens"][..]
        }
    };
    if disallowed.iter().any(|field| object.contains_key(*field)) {
        return Err(BrokerError::InvalidPayload);
    }
    if object
        .get("n")
        .is_some_and(|value| value.as_u64().is_none_or(|count| count != 1))
        || object
            .get("candidateCount")
            .is_some_and(|value| value.as_u64().is_none_or(|count| count != 1))
    {
        return Err(BrokerError::InvalidPayload);
    }
    let field = match permit.operation {
        ModelOperation::Responses => "max_output_tokens",
        ModelOperation::OllamaChat => "num_predict",
        ModelOperation::ChatCompletions if permit.provider == ModelApi::OpenAi => {
            "max_completion_tokens"
        }
        ModelOperation::ChatCompletions => "max_tokens",
        ModelOperation::Messages => "max_tokens",
        ModelOperation::StreamGenerateContent { .. } => {
            let config = object
                .entry("generationConfig")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or(BrokerError::InvalidPayload)?;
            enforce_token_field(config, "maxOutputTokens", permit.max_output_tokens)?;
            return Ok(());
        }
    };
    let alternate = match permit.operation {
        ModelOperation::ChatCompletions if permit.provider == ModelApi::OpenAi => "max_tokens",
        ModelOperation::ChatCompletions => "max_completion_tokens",
        _ => "",
    };
    if !alternate.is_empty() && object.contains_key(alternate) {
        return Err(BrokerError::InvalidPayload);
    }
    enforce_token_field(object, field, permit.max_output_tokens)
}

fn enforce_token_field(
    object: &mut Map<String, Value>,
    field: &str,
    maximum: u32,
) -> Result<(), BrokerError> {
    match object.get(field) {
        Some(Value::Number(value))
            if value.as_u64().is_some_and(|value| value > maximum as u64) =>
        {
            Err(BrokerError::OutputLimitExceeded)
        }
        Some(Value::Number(value)) if value.as_u64().is_some_and(|value| value > 0) => Ok(()),
        Some(_) => Err(BrokerError::InvalidPayload),
        None => {
            object.insert(field.into(), Value::from(maximum));
            Ok(())
        }
    }
}

fn validate_tool_names(
    permit: &GenerationPermit,
    object: &Map<String, Value>,
) -> Result<(), BrokerError> {
    let Some(tools) = object.get("tools") else {
        return Ok(());
    };
    let tools = tools.as_array().ok_or(BrokerError::InvalidPayload)?;
    let mut seen = BTreeSet::new();
    for tool in tools {
        if !tool.is_object() {
            return Err(BrokerError::InvalidPayload);
        }
        let names = match permit.operation {
            ModelOperation::Responses => {
                if tool.get("type").and_then(Value::as_str) != Some("function") {
                    return Err(BrokerError::InvalidPayload);
                }
                vec![tool.get("name")]
            }
            ModelOperation::ChatCompletions | ModelOperation::OllamaChat => {
                if tool.get("type").and_then(Value::as_str) != Some("function") {
                    return Err(BrokerError::InvalidPayload);
                }
                vec![
                    tool.get("function")
                        .and_then(|function| function.get("name")),
                ]
            }
            ModelOperation::Messages => vec![tool.get("name")],
            ModelOperation::StreamGenerateContent { .. } => tool
                .get("functionDeclarations")
                .and_then(Value::as_array)
                .ok_or(BrokerError::InvalidPayload)?
                .iter()
                .map(|function| function.get("name"))
                .collect(),
        };
        if names.is_empty() {
            return Err(BrokerError::InvalidPayload);
        }
        for raw_name in names {
            let name = raw_name
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or(BrokerError::InvalidPayload)?;
            if !seen.insert(name) {
                return Err(BrokerError::InvalidPayload);
            }
            if !permit.allowed_tools.contains(name) {
                return Err(BrokerError::ToolNotAllowed);
            }
        }
    }
    Ok(())
}

fn validate_ollama_options(
    permit: &GenerationPermit,
    object: &Map<String, Value>,
) -> Result<(), BrokerError> {
    let options = object
        .get("options")
        .and_then(Value::as_object)
        .ok_or(BrokerError::InvalidPayload)?;
    const ALLOWED: &[&str] = &[
        "num_predict",
        "temperature",
        "top_p",
        "top_k",
        "seed",
        "stop",
        "repeat_penalty",
        "repeat_last_n",
    ];
    if options.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(BrokerError::InvalidPayload);
    }
    for (name, value) in options {
        let valid = match name.as_str() {
            "num_predict" | "top_k" | "seed" | "repeat_last_n" => {
                value.as_i64().is_some_and(|number| number >= 0)
            }
            "temperature" | "top_p" | "repeat_penalty" => value.as_f64().is_some(),
            "stop" => match value {
                Value::String(stop) => !stop.is_empty() && stop.len() <= 256,
                Value::Array(stops) => {
                    !stops.is_empty()
                        && stops.len() <= 16
                        && stops.iter().all(|stop| {
                            stop.as_str()
                                .is_some_and(|stop| !stop.is_empty() && stop.len() <= 256)
                        })
                }
                _ => false,
            },
            _ => false,
        };
        if !valid {
            return Err(BrokerError::InvalidPayload);
        }
    }
    if options.get("num_predict").is_some_and(|value| {
        value
            .as_u64()
            .is_some_and(|value| value > permit.max_output_tokens as u64)
    }) {
        return Err(BrokerError::OutputLimitExceeded);
    }
    Ok(())
}

fn model_endpoint(provider: ModelApi, operation: ModelOperation) -> Result<Url, BrokerError> {
    if provider == ModelApi::OllamaLocal && operation == ModelOperation::OllamaChat {
        return validate_endpoint("http://127.0.0.1:11434/api/chat");
    }
    let (host, path, allowed_query) = match (provider, operation) {
        (ModelApi::OpenAi, ModelOperation::Responses) => {
            ("api.openai.com", "/v1/responses".to_owned(), None)
        }
        (ModelApi::OpenAi, ModelOperation::ChatCompletions) => {
            ("api.openai.com", "/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::Anthropic, ModelOperation::Messages) => {
            ("api.anthropic.com", "/v1/messages".to_owned(), None)
        }
        (ModelApi::Gemini, ModelOperation::StreamGenerateContent { model })
            if valid_model_segment(&model) =>
        {
            (
                "generativelanguage.googleapis.com",
                format!("/v1beta/models/{model}:streamGenerateContent"),
                Some("alt=sse"),
            )
        }
        (ModelApi::Mistral, ModelOperation::ChatCompletions) => {
            ("api.mistral.ai", "/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::Xai, ModelOperation::ChatCompletions) => {
            ("api.x.ai", "/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::DeepSeek, ModelOperation::ChatCompletions) => {
            ("api.deepseek.com", "/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::Groq, ModelOperation::ChatCompletions) => (
            "api.groq.com",
            "/openai/v1/chat/completions".to_owned(),
            None,
        ),
        (ModelApi::Cerebras, ModelOperation::ChatCompletions) => {
            ("api.cerebras.ai", "/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::OpenRouter, ModelOperation::ChatCompletions) => {
            ("openrouter.ai", "/api/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::Together, ModelOperation::ChatCompletions) => {
            ("api.together.xyz", "/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::Fireworks, ModelOperation::ChatCompletions) => (
            "api.fireworks.ai",
            "/inference/v1/chat/completions".to_owned(),
            None,
        ),
        (ModelApi::Moonshot, ModelOperation::ChatCompletions) => {
            ("api.moonshot.ai", "/v1/chat/completions".to_owned(), None)
        }
        (ModelApi::DashScope, ModelOperation::ChatCompletions) => (
            "dashscope-intl.aliyuncs.com",
            "/compatible-mode/v1/chat/completions".to_owned(),
            None,
        ),
        _ => return Err(BrokerError::UnsupportedOperation),
    };
    let mut url =
        Url::parse(&format!("https://{host}{path}")).map_err(|_| BrokerError::InvalidEndpoint)?;
    url.set_query(allowed_query);
    validate_endpoint_query(url.as_str(), allowed_query)
}

fn valid_model_segment(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(super) struct BrokerStreamResponse {
    pub(super) status: StatusCode,
    body: Response,
    delivered: u64,
}

impl BrokerStreamResponse {
    /// Reads at most one caller-provided chunk and never exposes bytes beyond
    /// the response ceiling. A one-byte probe detects an undeclared overflow.
    pub(super) fn read_chunk(&mut self, buffer: &mut [u8]) -> Result<usize, BrokerError> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let remaining = MAX_RESPONSE_BYTES.saturating_sub(self.delivered);
        if remaining == 0 {
            let mut probe = [0_u8; 1];
            return match self.body.read(&mut probe) {
                Ok(0) => Ok(0),
                Ok(_) => Err(BrokerError::ResponseTooLarge),
                Err(_) => Err(BrokerError::Transport),
            };
        }
        let limit = buffer.len().min(remaining as usize);
        let read = self
            .body
            .read(&mut buffer[..limit])
            .map_err(|_| BrokerError::Transport)?;
        self.delivered = self.delivered.saturating_add(read as u64);
        Ok(read)
    }
}

fn validate_endpoint(endpoint: &str) -> Result<Url, BrokerError> {
    validate_endpoint_query(endpoint, None)
}

fn validate_endpoint_query(
    endpoint: &str,
    allowed_query: Option<&str>,
) -> Result<Url, BrokerError> {
    if endpoint.len() > MAX_ENDPOINT_BYTES {
        return Err(BrokerError::InvalidEndpoint);
    }
    let url = Url::parse(endpoint).map_err(|_| BrokerError::InvalidEndpoint)?;
    if endpoint == "http://127.0.0.1:11434/api/chat"
        && allowed_query.is_none()
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(11434)
        && url.path() == "/api/chat"
        && url.query().is_none()
        && url.fragment().is_none()
    {
        return Ok(url);
    }
    let host = url.host_str().ok_or(BrokerError::InvalidEndpoint)?;
    let has_user_info = endpoint
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split(['/', '?', '#']).next())
        .is_some_and(|authority| authority.contains('@'));
    if url.scheme() != "https"
        || has_user_info
        || url.port().is_some_and(|port| port != 443)
        || url.fragment().is_some()
        || url.query() != allowed_query
    {
        return Err(BrokerError::InvalidEndpoint);
    }
    if !crate::policy::MODEL_API_HOSTS.contains(&host) {
        return Err(BrokerError::UnapprovedDestination);
    }
    Ok(url)
}

fn bounded_stream_response(response: Response) -> Result<BrokerStreamResponse, BrokerError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(BrokerError::ResponseTooLarge);
    }
    let status = response.status();
    Ok(BrokerStreamResponse {
        status,
        body: response,
        delivered: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    fn openai_permit(allowed_tools: &[&str]) -> GenerationPermit {
        GenerationPermit::from_admitted_policy(
            ModelApi::OpenAi,
            ModelOperation::ChatCompletions,
            "gpt-local-profile".into(),
            1024,
            64 * 1024,
            allowed_tools.iter().map(|name| (*name).into()).collect(),
            BTreeMap::new(),
        )
        .unwrap()
    }

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
    fn public_address_validation_rejects_special_and_mixed_dns_answers() {
        let public = "8.8.8.8:443".parse::<SocketAddr>().unwrap();
        let private = "10.0.0.1:443".parse::<SocketAddr>().unwrap();
        assert_eq!(
            validate_public_addresses([public, public]).unwrap(),
            [public]
        );
        assert!(matches!(
            validate_public_addresses([public, private]),
            Err(BrokerError::UnapprovedDestination)
        ));
        assert!(matches!(
            validate_public_addresses(std::iter::empty()),
            Err(BrokerError::UnapprovedDestination)
        ));
    }

    #[test]
    fn public_unicast_classifier_allows_global_addresses_and_rejects_special_ranges() {
        for address in [
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
            IpAddr::V6("2001:4860:4860::8888".parse().unwrap()),
        ] {
            assert!(is_public_unicast(address), "{address} should be allowed");
        }
        for address in [
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(240, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6("fc00::1".parse().unwrap()),
            IpAddr::V6("fe80::1".parse().unwrap()),
            IpAddr::V6("2001:db8::1".parse().unwrap()),
            IpAddr::V6("2002::1".parse().unwrap()),
            IpAddr::V6("::ffff:8.8.8.8".parse().unwrap()),
            IpAddr::V6("3fff::1".parse().unwrap()),
        ] {
            assert!(!is_public_unicast(address), "{address} should be refused");
        }
    }

    #[test]
    fn reqwest_uses_the_explicit_resolver_pin() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("POST / HTTP/1.1"));
            use std::io::Write;
            write!(
                stream,
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let client = build_client(Some(("pin.test", &[address]))).unwrap();
        let url = Url::parse(&format!("http://pin.test:{}/", address.port())).unwrap();
        let response = client.post(url).body("{}").send().unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        server.join().unwrap();
    }

    #[test]
    fn provider_credentials_use_fixed_vault_accounts_and_native_auth_headers() {
        for (provider, account) in [
            (ModelApi::OpenAi, "OPENAI_API_KEY"),
            (ModelApi::Anthropic, "ANTHROPIC_API_KEY"),
            (ModelApi::Gemini, "GEMINI_API_KEY"),
            (ModelApi::Mistral, "MISTRAL_API_KEY"),
            (ModelApi::Xai, "XAI_API_KEY"),
            (ModelApi::DeepSeek, "DEEPSEEK_API_KEY"),
            (ModelApi::Groq, "GROQ_API_KEY"),
            (ModelApi::Cerebras, "CEREBRAS_API_KEY"),
            (ModelApi::OpenRouter, "OPENROUTER_API_KEY"),
            (ModelApi::Together, "TOGETHER_API_KEY"),
            (ModelApi::Fireworks, "FIREWORKS_API_KEY"),
            (ModelApi::Moonshot, "MOONSHOT_API_KEY"),
            (ModelApi::DashScope, "DASHSCOPE_API_KEY"),
        ] {
            assert_eq!(credential_account(provider), Some(account));
        }
        assert_eq!(credential_account(ModelApi::OllamaLocal), None);

        let client = Client::new();
        let request = apply_provider_auth(
            client.post("https://api.openai.com/v1/responses"),
            ModelApi::OpenAi,
            "synthetic-key",
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer synthetic-key"
        );
        assert!(request.body().is_none());

        let request = apply_provider_auth(
            client.post("https://api.anthropic.com/v1/messages"),
            ModelApi::Anthropic,
            "synthetic-key",
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(request.headers().get("x-api-key").unwrap(), "synthetic-key");
        assert_eq!(
            request.headers().get("anthropic-version").unwrap(),
            "2023-06-01"
        );

        let request = apply_provider_auth(
            client.post("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent"),
            ModelApi::Gemini,
            "synthetic-key",
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(
            request.headers().get("x-goog-api-key").unwrap(),
            "synthetic-key"
        );
        assert!(request.url().query().is_none());
    }

    #[test]
    fn native_credential_lookup_uses_the_fixed_vault_account() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let service = format!("vakyartha-test-{}-{suffix}", std::process::id());
        let test_root = std::env::temp_dir().join(&service);
        let data_dir = test_root.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        crate::private_store::ensure_root(&crate::private_store::root(&data_dir)).unwrap();
        std::fs::write(
            crate::private_store::root(&data_dir).join(".vault.secrets"),
            "OPENAI_API_KEY=synthetic-key\n",
        )
        .unwrap();
        let client = NativeHttpClient::new(service, data_dir.clone());
        assert_eq!(
            client.credential(ModelApi::OpenAi).unwrap(),
            Some("synthetic-key".into())
        );
        assert_eq!(client.credential(ModelApi::OllamaLocal).unwrap(), None);
        assert!(matches!(
            client.credential(ModelApi::Gemini),
            Err(BrokerError::CredentialUnavailable)
        ));
        std::fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn registered_generation_operations_resolve_to_fixed_routes() {
        assert_eq!(
            model_endpoint(ModelApi::OllamaLocal, ModelOperation::OllamaChat)
                .unwrap()
                .as_str(),
            "http://127.0.0.1:11434/api/chat"
        );
        assert!(matches!(
            validate_endpoint("http://127.0.0.1:11434/api/show"),
            Err(BrokerError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("http://127.0.0.1:11415/api/chat"),
            Err(BrokerError::InvalidEndpoint)
        ));
        for endpoint in [
            "http://localhost:11434/api/chat",
            "http://[::1]:11434/api/chat",
            "http://127.0.0.1:11434/api/chat?redirect=https://example.com",
            "http://127.0.0.1:11434/api/chat/",
        ] {
            assert!(validate_endpoint(endpoint).is_err(), "{endpoint}");
        }
        let request = provider_post(
            Client::new(),
            model_endpoint(ModelApi::OllamaLocal, ModelOperation::OllamaChat).unwrap(),
            ModelApi::OllamaLocal,
            None,
        )
        .unwrap()
        .build()
        .unwrap();
        assert!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .is_none()
        );
        assert_eq!(
            model_endpoint(ModelApi::OpenAi, ModelOperation::Responses)
                .unwrap()
                .as_str(),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            model_endpoint(
                ModelApi::Gemini,
                ModelOperation::StreamGenerateContent {
                    model: "gemini-2.5-flash".into()
                }
            )
            .unwrap()
            .as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            model_endpoint(ModelApi::Groq, ModelOperation::ChatCompletions)
                .unwrap()
                .as_str(),
            "https://api.groq.com/openai/v1/chat/completions"
        );
        assert!(matches!(
            model_endpoint(ModelApi::Anthropic, ModelOperation::ChatCompletions),
            Err(BrokerError::UnsupportedOperation)
        ));
        assert!(matches!(
            model_endpoint(
                ModelApi::Gemini,
                ModelOperation::StreamGenerateContent {
                    model: "../v1/models".into()
                }
            ),
            Err(BrokerError::UnsupportedOperation)
        ));
    }

    fn ollama_permit() -> GenerationPermit {
        GenerationPermit::from_admitted_policy(
            ModelApi::OllamaLocal,
            ModelOperation::OllamaChat,
            "qwen3.5:4b-mlx".into(),
            2_400,
            64 * 1024,
            ["vak_render".into()].into_iter().collect(),
            BTreeMap::from([
                ("think".into(), Value::Bool(false)),
                ("keep_alive".into(), Value::String("30m".into())),
            ]),
        )
        .unwrap()
    }

    #[test]
    fn local_ollama_payload_keeps_fixed_chat_route_and_native_limits() {
        let permit = ollama_permit();
        let prepared = prepare_generation_body(
            &permit,
            br#"{"model":"qwen3.5:4b-mlx","stream":true,"think":false,"messages":[{"role":"user","content":"synthetic"}],"tools":[{"type":"function","function":{"name":"vak_render","parameters":{"type":"object"}}}],"format":{"type":"object"},"options":{},"keep_alive":"30m"}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&prepared).unwrap();
        assert_eq!(value["options"]["num_predict"], 2_400);
        assert_eq!(value["model"], "qwen3.5:4b-mlx");

        for body in [
            br#"{"model":"other","stream":true,"think":false,"messages":[],"options":{},"keep_alive":"30m"}"#.as_slice(),
            br#"{"model":"qwen3.5:4b-mlx","stream":false,"think":false,"messages":[],"options":{},"keep_alive":"30m"}"#.as_slice(),
            br#"{"model":"qwen3.5:4b-mlx","stream":true,"think":false,"messages":[],"options":{"num_ctx":999999},"keep_alive":"30m"}"#.as_slice(),
            br#"{"model":"qwen3.5:4b-mlx","stream":true,"think":false,"messages":[],"options":{"num_predict":2401},"keep_alive":"30m"}"#.as_slice(),
            br#"{"model":"qwen3.5:4b-mlx","stream":true,"think":false,"messages":[],"options":{},"keep_alive":"30m","url":"http://127.0.0.1:11434/api/show"}"#.as_slice(),
        ] {
            assert!(prepare_generation_body(&permit, body).is_err());
        }
    }

    #[test]
    fn generation_payload_is_bound_to_model_and_native_output_ceiling() {
        let permit = openai_permit(&[]);
        let prepared = prepare_generation_body(
            &permit,
            br#"{"model":"gpt-local-profile","messages":[],"stream":true}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&prepared).unwrap();
        assert_eq!(value["model"], "gpt-local-profile");
        assert_eq!(value["max_completion_tokens"], 1024);

        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"other-model","messages":[],"stream":true,"max_completion_tokens":100}"#
            ),
            Err(BrokerError::ModelMismatch)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","messages":[],"stream":true,"max_completion_tokens":2048}"#
            ),
            Err(BrokerError::OutputLimitExceeded)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","messages":[],"stream":true,"max_tokens":100}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
    }

    #[test]
    fn generation_payload_rejects_unapproved_tools_and_credential_fields() {
        let permit = openai_permit(&["search__fetch"]);
        let prepared = prepare_generation_body(
            &permit,
            br#"{"model":"gpt-local-profile","stream":true,"messages":[],"tools":[{"type":"function","function":{"name":"search__fetch"}}]}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&prepared).unwrap();
        assert_eq!(value["tools"][0]["function"]["name"], "search__fetch");

        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":true,"messages":[],"tools":[{"type":"function","function":{"name":"shell__run"}}]}"#
            ),
            Err(BrokerError::ToolNotAllowed)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":true,"messages":[],"headers":{"authorization":"secret"}}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":true,"messages":[],"tools":[{"type":"function"}]}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":true,"messages":[],"tools":[{"type":"function","function":{"name":"search__fetch"}},{"type":"function","function":{"name":"search__fetch"}}]}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":true,"messages":[],"tools":[{"type":"custom","function":{"name":"search__fetch"}}]}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
    }

    #[test]
    fn normalized_generation_body_cannot_exceed_its_permit_size() {
        let body = br#"{"model":"gpt-local-profile","stream":true,"messages":[]}"#;
        let permit = GenerationPermit::from_admitted_policy(
            ModelApi::OpenAi,
            ModelOperation::ChatCompletions,
            "gpt-local-profile".into(),
            128,
            body.len(),
            BTreeSet::new(),
            BTreeMap::new(),
        )
        .unwrap();
        assert!(matches!(
            prepare_generation_body(&permit, body),
            Err(BrokerError::RequestTooLarge)
        ));
    }

    #[test]
    fn generation_payload_requires_streaming_and_exact_native_extras() {
        let mut extras = BTreeMap::new();
        extras.insert("reasoning_effort".into(), Value::String("low".into()));
        let permit = GenerationPermit::from_admitted_policy(
            ModelApi::OpenAi,
            ModelOperation::ChatCompletions,
            "gpt-local-profile".into(),
            512,
            64 * 1024,
            BTreeSet::new(),
            extras,
        )
        .unwrap();

        let allowed = prepare_generation_body(
            &permit,
            br#"{"model":"gpt-local-profile","stream":true,"messages":[],"reasoning_effort":"low"}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&allowed).unwrap();
        assert_eq!(value["max_completion_tokens"], 512);

        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":true,"messages":[],"reasoning_effort":"high"}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":false,"messages":[],"reasoning_effort":"low"}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"model":"gpt-local-profile","stream":true,"reasoning_effort":"low"}"#
            ),
            Err(BrokerError::InvalidPayload)
        ));
    }

    #[test]
    fn generation_permit_binds_gemini_route_model_and_token_cap() {
        let permit = GenerationPermit::from_admitted_policy(
            ModelApi::Gemini,
            ModelOperation::StreamGenerateContent {
                model: "gemini-2.5-flash".into(),
            },
            "gemini-2.5-flash".into(),
            512,
            64 * 1024,
            BTreeSet::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let prepared =
            prepare_generation_body(&permit, br#"{"contents":[],"generationConfig":{}}"#).unwrap();
        let value: Value = serde_json::from_slice(&prepared).unwrap();
        assert_eq!(value["generationConfig"]["maxOutputTokens"], 512);
        assert!(matches!(
            GenerationPermit::from_admitted_policy(
                ModelApi::Gemini,
                ModelOperation::StreamGenerateContent {
                    model: "gemini-2.5-flash".into()
                },
                "another-model".into(),
                512,
                64 * 1024,
                BTreeSet::new(),
                BTreeMap::new()
            ),
            Err(BrokerError::ModelMismatch)
        ));
        assert!(matches!(
            prepare_generation_body(
                &permit,
                br#"{"contents":[],"generationConfig":{"maxOutputTokens":513}}"#
            ),
            Err(BrokerError::OutputLimitExceeded)
        ));
    }

    #[test]
    fn responses_payload_is_forced_to_non_persistent_streaming_mode() {
        let permit = GenerationPermit::from_admitted_policy(
            ModelApi::OpenAi,
            ModelOperation::Responses,
            "gpt-local-profile".into(),
            256,
            64 * 1024,
            BTreeSet::new(),
            BTreeMap::new(),
        )
        .unwrap();
        let prepared = prepare_generation_body(
            &permit,
            br#"{"model":"gpt-local-profile","stream":true,"input":[]}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&prepared).unwrap();
        assert_eq!(value["store"], false);
        assert_eq!(value["max_output_tokens"], 256);
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
        let client = build_client(None).unwrap();
        let url = Url::parse(&format!("http://{first_addr}/start")).unwrap();
        let response = client.post(url).body("{}").send().unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        first_thread.join().unwrap();
        second_thread.join().unwrap();
        assert!(!redirected.load(Ordering::SeqCst));
    }

    #[test]
    fn streamed_response_limit_is_enforced_when_length_is_not_declared() {
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
        let client = build_client(None).unwrap();
        let response = client
            .post(Url::parse(&format!("http://{address}/large")).unwrap())
            .body("{}")
            .send()
            .unwrap();
        let mut response = bounded_stream_response(response).unwrap();
        let mut total = 0_u64;
        let mut chunk = [0_u8; 128 * 1024];
        loop {
            match response.read_chunk(&mut chunk) {
                Ok(0) => panic!("oversized response unexpectedly reached EOF"),
                Ok(read) => total += read as u64,
                Err(BrokerError::ResponseTooLarge) => break,
                Err(error) => panic!("unexpected response error: {error:?}"),
            }
        }
        assert_eq!(total, MAX_RESPONSE_BYTES);
        server.join().unwrap();
    }

    #[test]
    fn bounded_stream_response_is_available_before_the_body_finishes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent_tx, sent_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            use std::io::Write;
            write!(stream, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nfirst").unwrap();
            stream.flush().unwrap();
            sent_tx.send(()).unwrap();
            continue_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            stream.write_all(b"-second").unwrap();
        });

        let client = build_client(None).unwrap();
        let (response_tx, response_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let response = client
                .post(Url::parse(&format!("http://{address}/stream")).unwrap())
                .body("{}")
                .send()
                .unwrap();
            response_tx.send(bounded_stream_response(response)).unwrap();
        });
        sent_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let mut response = response_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("headers and an unfinished body should be available incrementally")
            .unwrap();
        assert_eq!(response.status, StatusCode::OK);
        let mut first = [0_u8; 5];
        assert_eq!(response.read_chunk(&mut first).unwrap(), 5);
        assert_eq!(&first, b"first");
        continue_tx.send(()).unwrap();
        let mut second = [0_u8; 7];
        assert_eq!(response.read_chunk(&mut second).unwrap(), 7);
        assert_eq!(&second, b"-second");
        assert_eq!(response.read_chunk(&mut second).unwrap(), 0);
        server.join().unwrap();
    }
}
