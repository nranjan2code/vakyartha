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
