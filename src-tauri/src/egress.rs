//! Integration egress for the contained worker. The worker names a URL; Rust
//! admits it only for an allowlisted integration host the user approved from
//! the main window, then carries the bytes. Model hosts keep their own route.
//! Credentials stay in the vault: Rust attaches a host's own key, so the worker
//! can neither read a key nor send it anywhere else.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use serde::Deserialize;

const MAX_BODY: usize = 8 * 1024 * 1024;
const REQUEST_HEADERS: &[&str] = &["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id", "user-agent"];
pub(crate) const RESPONSE_HEADERS: &[&str] = &["content-type", "retry-after", "mcp-session-id"];
const STORE: &str = "egress-approvals.json";
const CUSTOM_STORE: &str = "custom-egress-hosts.json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EgressRequest {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Credential {
    pub account: String,
    pub header: String,
    pub format: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Host {
    host: String,
    #[serde(default)]
    credential: Option<Credential>,
}

/// A local server that needs the network: the only hosts its broker tunnels to,
/// and which vault account fills each declared key variable.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NetworkServer {
    pub hosts: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    hosts: Vec<Host>,
    servers: BTreeMap<String, NetworkServer>,
}

/// Compiled in, so the worker cannot change which host receives which key.
static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../shared/integration-egress.json")).expect("integration egress catalog")
});
static HOSTS: LazyLock<&'static [Host]> = LazyLock::new(|| CATALOG.hosts.as_slice());

pub(crate) fn network_server(integration: &str) -> Option<&'static NetworkServer> { CATALOG.servers.get(integration) }

pub(crate) fn hosts() -> impl Iterator<Item = &'static str> { HOSTS.iter().map(|h| h.host.as_str()) }

pub(crate) fn approvable(host: &str) -> bool { HOSTS.iter().any(|h| h.host == host) }

pub(crate) fn credential(host: &str) -> Option<&'static Credential> {
    HOSTS.iter().find(|h| h.host == host).and_then(|h| h.credential.as_ref())
}

/// Vault accounts whose presence the worker may know (never their values).
pub(crate) fn credential_accounts() -> impl Iterator<Item = &'static str> {
    HOSTS.iter().filter_map(|h| h.credential.as_ref()).map(|c| c.account.as_str())
}

pub(crate) struct Admitted {
    pub host: String,
    pub url: reqwest::Url,
    pub method: reqwest::Method,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl EgressRequest {
    pub fn admit(&self, protocol: u8, data_dir: &Path) -> Result<Admitted, String> {
        let valid_id = self.id.starts_with("egr-") && self.id.len() <= 64 && self.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if self.v != protocol || self.kind != "egress_request" || !valid_id { return Err("Invalid egress request".into()); }
        let method = match self.method.as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("Unsupported egress method".into()),
        };
        if self.body.len() > MAX_BODY || (method != reqwest::Method::POST && !self.body.is_empty()) { return Err("Unsupported egress body".into()); }
        if self.url.len() > 4096 { return Err("Egress URL is too long".into()); }
        let url = reqwest::Url::parse(&self.url).map_err(|_| "Invalid egress URL".to_string())?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.port().is_some_and(|p| p != 443) {
            return Err("Integration egress must be plain HTTPS on port 443".into());
        }
        let host = url.host_str().ok_or_else(|| "Invalid egress URL".to_string())?.to_ascii_lowercase();
        if !is_permitted(data_dir, &host) {
            return Err(format!("Network access to {host} needs your approval: open Settings and choose Allow or add it under Sandbox Allowed URLs"));
        }
        let mut headers = Vec::with_capacity(self.headers.len());
        for (name, value) in &self.headers {
            let name = name.to_ascii_lowercase();
            if !REQUEST_HEADERS.contains(&name.as_str()) || value.len() > 512 || !value.bytes().all(|b| (0x20..0x7f).contains(&b)) {
                return Err("Unsupported egress header".into());
            }
            headers.push((name, value.clone()));
        }
        let body = (method == reqwest::Method::POST).then(|| self.body.clone());
        Ok(Admitted { host, url, method, headers, body })
    }
}

pub(crate) fn normalize_host_pattern(input: &str) -> Result<String, &'static str> {
    let mut s = input.trim();
    if s.is_empty() { return Err("Host cannot be empty"); }
    if let Some(rest) = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")) {
        s = rest;
    }
    if let Some((clean, _)) = s.split_once('/') { s = clean; }
    if let Some((clean, _)) = s.split_once('?') { s = clean; }
    if let Some((clean, _)) = s.split_once('#') { s = clean; }
    if let Some((clean, port)) = s.split_once(':') {
        if port != "443" { return Err("Only HTTPS port 443 is permitted for network egress"); }
        s = clean;
    }
    let host = s.to_ascii_lowercase();
    if host.len() > 253 { return Err("Host is too long"); }
    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host.starts_with("10.") || host.starts_with("192.168.") || host.starts_with("169.254.") {
        return Err("Loopback and private IP addresses are not permitted");
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Err("IP address literals are not permitted; use hostnames");
    }
    let check = host.strip_prefix('.').unwrap_or(&host);
    if check.is_empty() || !check.contains('.') {
        return Err("Please provide a valid fully qualified domain name (e.g. api.example.com or .example.com)");
    }
    for part in check.split('.') {
        if part.is_empty() || part.len() > 63 || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || part.starts_with('-') || part.ends_with('-') {
            return Err("Invalid domain name format");
        }
    }
    if crate::policy::MODEL_API_HOSTS.contains(&host.as_str()) {
        return Err("Model API hosts are handled by Providers, not custom egress");
    }
    Ok(host)
}

fn custom_store(data_dir: &Path) -> PathBuf { crate::private_store::root(data_dir).join(CUSTOM_STORE) }

pub(crate) fn custom_hosts(data_dir: &Path) -> Vec<String> {
    std::fs::read(custom_store(data_dir)).ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|h| normalize_host_pattern(&h).ok())
        .collect()
}

pub(crate) fn add_custom_host(data_dir: &Path, raw: &str) -> Result<Vec<String>, String> {
    let host = normalize_host_pattern(raw).map_err(|e| e.to_string())?;
    let mut hosts = custom_hosts(data_dir);
    if !hosts.contains(&host) {
        hosts.push(host);
        hosts.sort();
        save_custom_hosts(data_dir, &hosts)?;
    }
    Ok(hosts)
}

pub(crate) fn remove_custom_host(data_dir: &Path, raw: &str) -> Result<Vec<String>, String> {
    let host = normalize_host_pattern(raw).unwrap_or_else(|_| raw.trim().to_ascii_lowercase());
    let mut hosts = custom_hosts(data_dir);
    hosts.retain(|h| h != &host);
    save_custom_hosts(data_dir, &hosts)?;
    Ok(hosts)
}

fn save_custom_hosts(data_dir: &Path, hosts: &[String]) -> Result<(), String> {
    let root = crate::private_store::root(data_dir);
    crate::private_store::ensure_root(&root).map_err(|_| "Custom egress store is unavailable".to_owned())?;
    let temp = root.join(format!("{CUSTOM_STORE}.tmp"));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp).map_err(|_| "Custom egress store is unavailable".to_owned())?;
        file.write_all(&serde_json::to_vec(hosts).unwrap()).and_then(|_| file.sync_all()).map_err(|_| "Custom host could not be saved".to_owned())?;
    }
    std::fs::rename(&temp, custom_store(data_dir)).map_err(|_| "Custom host could not be saved".to_owned())?;
    Ok(())
}

pub(crate) fn is_permitted(data_dir: &Path, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if crate::policy::MODEL_API_HOSTS.contains(&host.as_str()) {
        return false;
    }
    if approvable(&host) && approved(data_dir).iter().any(|h| h == &host) {
        return true;
    }
    custom_hosts(data_dir).iter().any(|pattern| {
        let pattern = pattern.to_ascii_lowercase();
        if pattern.starts_with('.') {
            host.ends_with(&pattern) && host.len() > pattern.len()
        } else {
            pattern == host
        }
    })
}

fn store(data_dir: &Path) -> PathBuf { crate::private_store::root(data_dir).join(STORE) }

pub(crate) fn approved(data_dir: &Path) -> Vec<String> {
    std::fs::read(store(data_dir)).ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter().filter(|host| approvable(host)).collect()
}

/// Only the main window calls this; the worker cannot widen its own egress.
pub(crate) fn set_approval(data_dir: &Path, host: &str, allow: bool) -> Result<Vec<String>, String> {
    let host = host.to_ascii_lowercase();
    if !approvable(&host) { return Err(format!("{host} is not on the app's integration allowlist")); }
    let mut hosts = approved(data_dir);
    hosts.retain(|h| *h != host);
    if allow { hosts.push(host); }
    hosts.sort();
    let root = crate::private_store::root(data_dir);
    crate::private_store::ensure_root(&root).map_err(|_| "Approval store is unavailable".to_owned())?;
    let temp = root.join(format!("{STORE}.tmp"));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp).map_err(|_| "Approval store is unavailable".to_owned())?;
        file.write_all(&serde_json::to_vec(&hosts).unwrap()).and_then(|_| file.sync_all()).map_err(|_| "Approval could not be saved".to_owned())?;
    }
    std::fs::rename(&temp, store(data_dir)).map_err(|_| "Approval could not be saved".to_owned())?;
    Ok(hosts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str, method: &str, headers: &[(&str, &str)], body: &str) -> EgressRequest {
        EgressRequest {
            v: 2, id: "egr-1".into(), kind: "egress_request".into(), url: url.into(), method: method.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: body.into(),
        }
    }

    #[test]
    fn admits_only_plain_https_integration_hosts_with_bounded_headers() {
        let base = std::env::temp_dir().join(format!("vak-egress-admit-{}", std::process::id()));
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        set_approval(&data, "mcp.nseindia.in", true).unwrap();

        let ok = request("https://mcp.nseindia.in/bhavcopy/cm/mcp", "POST", &[("Content-Type", "application/json"), ("mcp-session-id", "abc"), ("user-agent", "custom-agent/1.0")], "{}");
        assert_eq!(ok.admit(2, &data).unwrap().host, "mcp.nseindia.in");
        for bad in [
            request("http://mcp.nseindia.in/mcp", "POST", &[], "{}"),
            request("https://mcp.nseindia.in:8443/mcp", "POST", &[], "{}"),
            request("https://user@mcp.nseindia.in/mcp", "POST", &[], "{}"),
            request("https://api.openai.com/v1/responses", "POST", &[], "{}"),
            request("https://attacker.example/x", "GET", &[], ""),
            request("https://mcp.nseindia.in/mcp", "POST", &[("authorization", "Bearer x")], "{}"),
            request("https://mcp.nseindia.in/mcp", "GET", &[], "body"),
            request("https://mcp.nseindia.in/mcp", "PUT", &[], ""),
            request("https://mcp.nseindia.in/mcp", "POST", &[("accept", "a\r\nx: y")], ""),
        ] {
            assert!(bad.admit(2, &data).is_err(), "{} {}", bad.method, bad.url);
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn custom_hosts_persist_normalize_and_admit_exact_and_wildcard() {
        let base = std::env::temp_dir().join(format!("vak-egress-custom-{}", std::process::id()));
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();

        assert!(custom_hosts(&data).is_empty());
        assert_eq!(add_custom_host(&data, "https://api.example.com/v1/test").unwrap(), vec!["api.example.com"]);
        assert_eq!(add_custom_host(&data, ".corp.internal").unwrap(), vec![".corp.internal", "api.example.com"]);
        assert_eq!(custom_hosts(&data), vec![".corp.internal", "api.example.com"]);

        // Exact match
        assert!(is_permitted(&data, "api.example.com"));
        assert!(!is_permitted(&data, "other.example.com"));

        // Wildcard match
        assert!(is_permitted(&data, "service.corp.internal"));
        assert!(is_permitted(&data, "deep.service.corp.internal"));
        assert!(!is_permitted(&data, "corp.internal")); // domain itself does not match .corp.internal
        assert!(!is_permitted(&data, "evil-corp.internal"));

        // Egress request admittance
        let ok_custom = request("https://api.example.com/data", "GET", &[("accept", "application/json")], "");
        assert_eq!(ok_custom.admit(2, &data).unwrap().host, "api.example.com");

        let ok_wildcard = request("https://node1.corp.internal/ping", "GET", &[], "");
        assert_eq!(ok_wildcard.admit(2, &data).unwrap().host, "node1.corp.internal");

        // Normalization rejects bad inputs
        assert!(add_custom_host(&data, "").is_err());
        assert!(add_custom_host(&data, "127.0.0.1").is_err());
        assert!(add_custom_host(&data, "localhost").is_err());
        assert!(add_custom_host(&data, "192.168.1.1").is_err());
        assert!(add_custom_host(&data, "api.openai.com").is_err()); // model host
        assert!(add_custom_host(&data, "https://api.example.com:8443").is_err()); // non-443 port

        // Removal
        assert_eq!(remove_custom_host(&data, "api.example.com").unwrap(), vec![".corp.internal"]);
        assert!(!is_permitted(&data, "api.example.com"));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn catalog_hosts_are_disjoint_from_models_and_credentials_are_well_formed() {
        assert!(hosts().all(|h| !crate::policy::MODEL_API_HOSTS.contains(&h)));
        for c in HOSTS.iter().filter_map(|h| h.credential.as_ref()) {
            assert!(c.format.contains("{value}") && !REQUEST_HEADERS.contains(&c.header.as_str()));
            assert!(!c.account.is_empty() && c.account.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'));
        }
        assert_eq!(credential("mcp.tavily.com").unwrap().account, "INTEGRATION_TAVILY_APIKEY");
        assert!(credential("mcp.nseindia.in").is_none());
        for server in CATALOG.servers.values() {
            assert!(server.hosts.iter().all(|h| approvable(h)), "server hosts must be approvable");
            assert!(server.env.values().all(|a| a.starts_with("INTEGRATION_")));
        }
    }

    #[test]
    fn approvals_persist_privately_and_refuse_unlisted_hosts() {
        let base = std::env::temp_dir().join(format!("vak-egress-{}", std::process::id()));
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        assert!(approved(&data).is_empty());
        assert_eq!(set_approval(&data, "MCP.nseindia.in", true).unwrap(), vec!["mcp.nseindia.in"]);
        assert_eq!(approved(&data), vec!["mcp.nseindia.in"]);
        assert!(set_approval(&data, "attacker.example", true).is_err());
        assert!(set_approval(&data, "api.openai.com", true).is_err());
        assert!(set_approval(&data, "mcp.nseindia.in", false).unwrap().is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }
}
