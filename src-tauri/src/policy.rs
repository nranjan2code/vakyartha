// System Isolation & Security Policy for the Rust Trusted Engine.
// The Rust shell owns security invariants that must remain immutable
// even if the TypeScript worker is compromised or executes untrusted model output.

/// Static public service origins that the app may contact over HTTPS.
pub const ALLOWED_EGRESS_HOSTS: &[&str] = &[
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
    "api.elevenlabs.io",
    "api.telegram.org",
    "huggingface.co",
    "registry.npmjs.org",
    "mcp.kite.trade",
    "mcp.nseindia.in",
    "api.typesafe.ai",
];

/// Hosted model API origins. This narrower set is for the native model
/// transport; integration, messaging and package hosts cannot inherit it.
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
];

/// Permitted vendor workspace cloud suffixes.
pub const ALLOWED_WORKSPACE_HOST_SUFFIXES: &[&str] = &[
    ".cloud.databricks.com",
    ".azuredatabricks.net",
    ".gcp.databricks.com",
];

/// Local model server endpoints permitted on loopback.
pub const ALLOWED_LOOPBACK_PORTS: &[u16] = &[
    11434, // Ollama
    1234,  // LM Studio
];

#[derive(Debug, PartialEq, Eq)]
pub enum EgressDecision {
    Allowed,
    Denied(&'static str),
}

/// Validates whether an outbound request destination is permitted by the egress policy,
/// checking built-in providers as well as custom user-allowed hosts.
pub fn evaluate_egress_with_custom(
    scheme: &str,
    host: &str,
    port: Option<u16>,
    custom_hosts: &[String],
) -> EgressDecision {
    let host_lower = host.to_ascii_lowercase();

    // Check custom user-configured allowed hosts (can be host or host:port or .domain suffix, or URL with scheme/path)
    for custom in custom_hosts {
        let mut custom_trimmed = custom.trim().to_ascii_lowercase();
        if custom_trimmed.is_empty() {
            continue;
        }
        if let Some(stripped) = custom_trimmed.strip_prefix("https://") {
            custom_trimmed = stripped.to_string();
        } else if let Some(stripped) = custom_trimmed.strip_prefix("http://") {
            custom_trimmed = stripped.to_string();
        }
        if let Some((clean, _)) = custom_trimmed.split_once('/') {
            custom_trimmed = clean.to_string();
        }

        if let Some((custom_h, custom_p_str)) = custom_trimmed.split_once(':') {
            let matches_port = port
                .map(|p| p.to_string() == custom_p_str)
                .unwrap_or_else(|| {
                    (custom_p_str == "443" && scheme == "https")
                        || (custom_p_str == "80" && scheme == "http")
                });
            if custom_h == host_lower && matches_port {
                return EgressDecision::Allowed;
            }
        } else if custom_trimmed == host_lower
            || (custom_trimmed.starts_with('.')
                && host_lower.ends_with(&custom_trimmed)
                && host_lower.len() > custom_trimmed.len())
        {
            return EgressDecision::Allowed;
        }
    }

    // Loopback handling for local models.
    if host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower == "::1" {
        if scheme != "http" && scheme != "https" {
            return EgressDecision::Denied("Loopback requests must use HTTP or HTTPS");
        }
        let port_num = port.unwrap_or(if scheme == "https" { 443 } else { 80 });
        if ALLOWED_LOOPBACK_PORTS.contains(&port_num) {
            return EgressDecision::Allowed;
        }
        return EgressDecision::Denied("Loopback port is not in the allowed local model list");
    }

    // Public egress: MUST be HTTPS.
    if scheme != "https" {
        return EgressDecision::Denied("Public outbound network egress must use HTTPS");
    }

    // Check host allowlist.
    if ALLOWED_EGRESS_HOSTS.contains(&host_lower.as_str()) {
        return EgressDecision::Allowed;
    }

    // Check workspace vendor cloud host suffixes.
    if ALLOWED_WORKSPACE_HOST_SUFFIXES
        .iter()
        .any(|suffix| host_lower.ends_with(suffix) && host_lower.len() > suffix.len())
    {
        return EgressDecision::Allowed;
    }

    // Explicitly deny raw IP addresses or arbitrary domains.
    EgressDecision::Denied("Destination host is not in the authorized egress catalog")
}

/// Validates whether an outbound request destination is permitted by the default egress policy.
#[cfg(test)]
pub fn evaluate_egress(scheme: &str, host: &str, port: Option<u16>) -> EgressDecision {
    evaluate_egress_with_custom(scheme, host, port, &[])
}

/// Integration version pin policy: ensures that every integration specifies an exact version,
/// refusing floating versions, ranges, or latest tags.
#[cfg(test)]
pub fn validate_integration_version(version: &str) -> Result<(), &'static str> {
    if version.is_empty() {
        return Err("Version cannot be empty");
    }
    // Reject range operators.
    if version.starts_with('^')
        || version.starts_with('~')
        || version.starts_with('>')
        || version.starts_with('<')
        || version.starts_with('*')
        || version == "latest"
    {
        return Err(
            "Floating versions and version ranges are strictly forbidden; exact pin required",
        );
    }

    // Validate semantic version format: digits.digits.digits[-prerelease]
    let parts: Vec<&str> = version.split('-').collect();
    let main_part = parts[0];
    let subparts: Vec<&str> = main_part.split('.').collect();
    if subparts.len() != 3 {
        return Err("Version must follow exact SemVer format (major.minor.patch)");
    }
    for sub in subparts {
        if sub.is_empty() || !sub.chars().all(|c| c.is_ascii_digit()) {
            return Err("Version components must be non-empty ASCII digits");
        }
    }

    Ok(())
}

/// User approval policy defaults: verifies whether an operation category requires explicit confirmation.
#[derive(Debug, PartialEq, Eq)]
#[cfg(test)]
pub enum OperationImpact {
    ReadOnly,
    FileSystemWrite,
    ShellExecution,
    NetworkEgress,
    DestructiveDelete,
}

#[cfg(test)]
pub fn requires_user_approval(impact: OperationImpact) -> bool {
    match impact {
        OperationImpact::ReadOnly => false,
        OperationImpact::FileSystemWrite
        | OperationImpact::ShellExecution
        | OperationImpact::NetworkEgress
        | OperationImpact::DestructiveDelete => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn egress_admits_custom_hosts() {
        let custom = vec![
            "my-resource.openai.azure.com".to_string(),
            ".internal.corp".to_string(),
            "192.168.1.50:8000".to_string(),
            "https://mcp.alphavantage.co".to_string(),
            "https://api.custom-ai.org/v1/models".to_string(),
        ];
        assert_eq!(
            evaluate_egress_with_custom("https", "my-resource.openai.azure.com", None, &custom),
            EgressDecision::Allowed
        );
        assert_eq!(
            evaluate_egress_with_custom("https", "ai.internal.corp", None, &custom),
            EgressDecision::Allowed
        );
        assert_eq!(
            evaluate_egress_with_custom("http", "192.168.1.50", Some(8000), &custom),
            EgressDecision::Allowed
        );
        assert_eq!(
            evaluate_egress_with_custom("https", "mcp.alphavantage.co", None, &custom),
            EgressDecision::Allowed
        );
        assert_eq!(
            evaluate_egress_with_custom("https", "api.custom-ai.org", None, &custom),
            EgressDecision::Allowed
        );
        assert!(matches!(
            evaluate_egress_with_custom("https", "evil.attacker.com", None, &custom),
            EgressDecision::Denied(_)
        ));
    }

    #[test]
    fn egress_admits_known_providers() {
        for host in ALLOWED_EGRESS_HOSTS {
            assert_eq!(
                evaluate_egress("https", host, None),
                EgressDecision::Allowed,
                "{host}"
            );
        }
    }

    #[test]
    fn egress_denies_insecure_or_unapproved_destinations() {
        assert!(matches!(
            evaluate_egress("http", "api.openai.com", None),
            EgressDecision::Denied(_)
        ));
        assert!(matches!(
            evaluate_egress("https", "evil.attacker.com", None),
            EgressDecision::Denied(_)
        ));
        assert!(matches!(
            evaluate_egress("https", "192.168.1.100", None),
            EgressDecision::Denied(_)
        ));
    }

    #[test]
    fn egress_admits_configured_local_models() {
        assert_eq!(
            evaluate_egress("http", "127.0.0.1", Some(11434)),
            EgressDecision::Allowed
        );
        assert_eq!(
            evaluate_egress("http", "localhost", Some(1234)),
            EgressDecision::Allowed
        );
        assert!(matches!(
            evaluate_egress("http", "127.0.0.1", Some(8080)),
            EgressDecision::Denied(_)
        ));
    }

    #[test]
    fn validates_exact_integration_pins() {
        assert!(validate_integration_version("1.2.3").is_ok());
        assert!(validate_integration_version("0.1.0-alpha.1").is_ok());
        assert!(validate_integration_version("^1.2.3").is_err());
        assert!(validate_integration_version("~1.2.3").is_err());
        assert!(validate_integration_version("latest").is_err());
        assert!(validate_integration_version("1.2").is_err());
        assert!(validate_integration_version("").is_err());
    }

    #[test]
    fn approvals_default_to_ask_for_mutations_and_egress() {
        assert!(!requires_user_approval(OperationImpact::ReadOnly));
        assert!(requires_user_approval(OperationImpact::FileSystemWrite));
        assert!(requires_user_approval(OperationImpact::ShellExecution));
        assert!(requires_user_approval(OperationImpact::NetworkEgress));
        assert!(requires_user_approval(OperationImpact::DestructiveDelete));
    }
}
