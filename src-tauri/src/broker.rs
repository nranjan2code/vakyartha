//! Native HTTP transport primitive for the provider broker.
//!
//! This is intentionally not wired to worker requests yet. Provider operation
//! schemas, credential binding, approval and bounded stream receipts must be
//! composed before this client can dispatch product traffic.

use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io::Read;
use std::time::Duration;

const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelApi {
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
pub(crate) enum ModelOperation {
    Responses,
    ChatCompletions,
    Messages,
    StreamGenerateContent { model: String },
}

#[derive(Debug)]
pub(crate) enum BrokerError {
    InvalidEndpoint,
    UnsupportedOperation,
    UnapprovedDestination,
    InvalidPayload,
    ModelMismatch,
    OutputLimitExceeded,
    ToolNotAllowed,
    RequestTooLarge,
    ResponseTooLarge,
    Transport,
}

/// Created only after native admission has resolved the provider/model,
/// cumulative output allowance and exact tool-name subset for this call.
pub(crate) struct GenerationPermit {
    provider: ModelApi,
    operation: ModelOperation,
    model: String,
    max_output_tokens: u32,
    max_request_bytes: usize,
    allowed_tools: BTreeSet<String>,
    allowed_extras: BTreeMap<String, Value>,
}

impl GenerationPermit {
    pub(crate) fn from_admitted_policy(
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

    /// POST JSON to one registered model generation route. Callers cannot
    /// supply an origin, path, headers or proxy policy. The permit validates
    /// the request envelope before it crosses the network boundary.
    pub(crate) fn post_provider_json(
        &self,
        permit: &GenerationPermit,
        body: &[u8],
    ) -> Result<BrokerResponse, BrokerError> {
        let url = model_endpoint(permit.provider, permit.operation.clone())?;
        if body.len() > permit.max_request_bytes {
            return Err(BrokerError::RequestTooLarge);
        }
        let body = prepare_generation_body(permit, body)?;
        let response = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .map_err(|_| BrokerError::Transport)?;
        bounded_response(response)
    }
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
    serde_json::to_vec(&value).map_err(|_| BrokerError::InvalidPayload)
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
    let (content_field, streaming_field) = match permit.operation {
        ModelOperation::Responses => ("input", Some("stream")),
        ModelOperation::ChatCompletions | ModelOperation::Messages => ("messages", Some("stream")),
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
    let disallowed = match permit.operation {
        ModelOperation::Responses => &["max_tokens", "max_completion_tokens"][..],
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
    for tool in tools {
        let names = match permit.operation {
            ModelOperation::Responses => vec![tool.get("name")],
            ModelOperation::ChatCompletions => vec![
                tool.get("function")
                    .and_then(|function| function.get("name")),
            ],
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
            if !permit.allowed_tools.contains(name) {
                return Err(BrokerError::ToolNotAllowed);
            }
        }
    }
    Ok(())
}

fn model_endpoint(provider: ModelApi, operation: ModelOperation) -> Result<Url, BrokerError> {
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

pub(crate) struct BrokerResponse {
    pub(crate) status: StatusCode,
    pub(crate) body: Vec<u8>,
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
    fn registered_generation_operations_resolve_to_fixed_routes() {
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
