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
const REQUEST_HEADERS: &[&str] = &["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
pub(crate) const RESPONSE_HEADERS: &[&str] = &["content-type", "retry-after", "mcp-session-id"];
const STORE: &str = "egress-approvals.json";

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

/// Compiled in, so the worker cannot change which host receives which key.
static HOSTS: LazyLock<Vec<Host>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../shared/integration-egress.json")).expect("integration egress catalog")
});

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
    pub fn admit(&self, protocol: u8) -> Result<Admitted, &'static str> {
        let valid_id = self.id.starts_with("egr-") && self.id.len() <= 64 && self.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if self.v != protocol || self.kind != "egress_request" || !valid_id { return Err("Invalid egress request"); }
        let method = match self.method.as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("Unsupported egress method"),
        };
        if self.body.len() > MAX_BODY || (method != reqwest::Method::POST && !self.body.is_empty()) { return Err("Unsupported egress body"); }
        if self.url.len() > 4096 { return Err("Egress URL is too long"); }
        let url = reqwest::Url::parse(&self.url).map_err(|_| "Invalid egress URL")?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.port().is_some_and(|p| p != 443) {
            return Err("Integration egress must be plain HTTPS on port 443");
        }
        let host = url.host_str().ok_or("Invalid egress URL")?.to_ascii_lowercase();
        if !approvable(&host) { return Err("Destination is not an approved integration host"); }
        let mut headers = Vec::with_capacity(self.headers.len());
        for (name, value) in &self.headers {
            let name = name.to_ascii_lowercase();
            if !REQUEST_HEADERS.contains(&name.as_str()) || value.len() > 512 || !value.bytes().all(|b| (0x20..0x7f).contains(&b)) {
                return Err("Unsupported egress header");
            }
            headers.push((name, value.clone()));
        }
        let body = (method == reqwest::Method::POST).then(|| self.body.clone());
        Ok(Admitted { host, url, method, headers, body })
    }
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
        let ok = request("https://mcp.nseindia.in/bhavcopy/cm/mcp", "POST", &[("Content-Type", "application/json"), ("mcp-session-id", "abc")], "{}");
        assert_eq!(ok.admit(2).unwrap().host, "mcp.nseindia.in");
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
            assert!(bad.admit(2).is_err(), "{} {}", bad.method, bad.url);
        }
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
