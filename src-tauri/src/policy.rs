// Destination policy owned by the Rust shell. It must hold even if the
// TypeScript worker is compromised or executes untrusted model output.

/// Hosted model API origins, reachable only through the native model transport.
pub const MODEL_API_HOSTS: &[&str] = &[
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.mistral.ai",
    "api.x.ai",
    "api.deepseek.com",
    "api.groq.com",
    "api.cerebras.ai",
    "openrouter.ai",
    "api.together.xyz",
    "api.fireworks.ai",
    "api.moonshot.ai",
    "dashscope-intl.aliyuncs.com",
    "api.typesafe.ai",
];

/// Integration, messaging and package origins the user may approve for
/// worker egress. Model hosts cannot be reached through this route.
pub const INTEGRATION_HOSTS: &[&str] = &[
    "api.elevenlabs.io",
    "api.telegram.org",
    "huggingface.co",
    "registry.npmjs.org",
    "mcp.kite.trade",
    "mcp.nseindia.in",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_and_integration_routes_never_share_a_host() {
        assert!(INTEGRATION_HOSTS.iter().all(|host| !MODEL_API_HOSTS.contains(host)));
    }
}
