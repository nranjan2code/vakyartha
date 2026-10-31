//! Voice: reading aloud and dictation for the worker. The worker names one of a
//! fixed set of operations; Rust owns every destination, attaches the vault key
//! for hosted voices, builds recording uploads, and runs the local Whistle
//! engine from Rust-owned data the worker cannot write.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Speech text is a sentence; a Gemini transcription carries the recording inline.
const MAX_BODY: usize = 12 * 1024 * 1024;
/// About four minutes of 16 kHz mono WAV.
const MAX_RECORDING: usize = 8_000_000;
const OLLAMA: &str = "http://127.0.0.1:11434";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct VoiceRequest {
    v: u8,
    pub(crate) id: String,
    #[serde(rename = "type")]
    kind: String,
    operation: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    audio: Option<String>,
}

pub(crate) enum Payload {
    None,
    Json(String),
    Upload { fields: Vec<(String, String)>, audio: Vec<u8> },
}

/// A hosted or local HTTP call with everything but the key decided here.
pub(crate) struct Remote {
    /// None: the local Ollama server.
    pub(crate) host: Option<&'static str>,
    pub(crate) method: reqwest::Method,
    pub(crate) url: String,
    /// Vault account, header, the text before the key, and the provider's name.
    pub(crate) credential: Option<(&'static str, &'static str, &'static str, &'static str)>,
    pub(crate) payload: Payload,
    pub(crate) timeout: Duration,
}

pub(crate) enum Plan {
    Remote(Remote),
    WhistleStatus,
    WhistleInstall,
    WhistleTranscribe { audio: Vec<u8>, language: Option<String> },
}

/// `name`, `namespace/name` or either with `:tag`: never a URL or another registry host.
fn ollama_name(value: &str) -> bool {
    let (path, tag) = value.split_once(':').unwrap_or((value, "latest"));
    let part = |p: &str| !p.is_empty() && p.len() <= 80 && p.as_bytes()[0].is_ascii_alphanumeric() && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b));
    let segments: Vec<&str> = path.split('/').collect();
    segments.len() <= 2 && segments.iter().all(|s| part(s)) && !tag.is_empty() && tag.len() <= 64 && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn valid_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

/// Upload fields: a JSON object of short one-line strings, only the names this operation sends.
fn fields(body: &str, allowed: &[&str]) -> Result<Vec<(String, String)>, &'static str> {
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(body).map_err(|_| "Voice fields must be a JSON object")?;
    map.into_iter().map(|(name, value)| {
        let value = value.as_str().ok_or("Voice fields must be text")?.to_owned();
        if !allowed.contains(&name.as_str()) { return Err("Unsupported voice field"); }
        if value.is_empty() || value.len() > 1000 || value.contains(['\r', '\n', '"']) { return Err("Invalid voice field"); }
        Ok((name, value))
    }).collect()
}

fn json_object(body: &str) -> Result<Payload, &'static str> {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(serde_json::Value::Object(_)) => Ok(Payload::Json(body.to_owned())),
        _ => Err("Voice requests carry a JSON object"),
    }
}

fn recording(audio: Option<&str>) -> Result<Vec<u8>, &'static str> {
    let audio = decode_base64(audio.ok_or("No recording")?).ok_or("The recording is not base64")?;
    if audio.len() > MAX_RECORDING { return Err("The recording is too long"); }
    if audio.len() < 44 || &audio[0..4] != b"RIFF" || &audio[8..12] != b"WAVE" { return Err("The recording is not a WAV file"); }
    Ok(audio)
}

impl VoiceRequest {
    pub(crate) fn plan(&self, protocol: u8) -> Result<Plan, &'static str> {
        if self.v != protocol || self.kind != "voice_request" { return Err("Invalid voice request"); }
        if self.body.len() > MAX_BODY { return Err("Voice request is too large"); }
        if self.target.as_deref().is_some_and(|t| !valid_name(t)) { return Err("Invalid voice target"); }
        let uses_audio = self.operation.ends_with("_transcribe");
        if self.audio.is_some() != uses_audio { return Err("Invalid voice request"); }
        let local = |method, path: &str, payload, timeout| Ok(Plan::Remote(Remote { host: None, method, url: format!("{OLLAMA}{path}"), credential: None, payload, timeout }));
        let hosted = |host: &'static str, credential, method, url: String, payload| Ok(Plan::Remote(Remote { host: Some(host), method, url, credential: Some(credential), payload, timeout: Duration::from_secs(120) }));
        const OPENAI: (&str, &str, &str, &str) = ("OPENAI_API_KEY", "authorization", "Bearer ", "OpenAI");
        const GEMINI: (&str, &str, &str, &str) = ("GEMINI_API_KEY", "x-goog-api-key", "", "Google Gemini");
        const ELEVEN: (&str, &str, &str, &str) = ("ELEVENLABS_API_KEY", "xi-api-key", "", "ElevenLabs");
        let target = || self.target.clone().ok_or("Missing voice target");
        let get = reqwest::Method::GET;
        let post = reqwest::Method::POST;
        let short = Duration::from_secs(10);
        match self.operation.as_str() {
            "ollama_tags" => local(get, "/api/tags", Payload::None, short),
            "ollama_show" => local(post, "/api/show", json_object(&self.body)?, short),
            "ollama_speech" => local(post, "/v1/audio/speech", json_object(&self.body)?, Duration::from_secs(120)),
            "ollama_transcribe" => {
                let audio = recording(self.audio.as_deref())?;
                local(post, "/v1/audio/transcriptions", Payload::Upload { fields: fields(&self.body, &["model", "response_format", "language"])?, audio }, Duration::from_secs(120))
            }
            "ollama_pull" => {
                let body: serde_json::Value = serde_json::from_str(&self.body).map_err(|_| "Invalid voice pack")?;
                // A catalog name the person entered; Ollama fetches it from its own registry and verifies it.
                let model = body.get("model").and_then(serde_json::Value::as_str).filter(|m| ollama_name(m)).ok_or("Not an Ollama model name")?;
                local(post, "/api/pull", Payload::Json(serde_json::json!({ "model": model, "stream": false }).to_string()), Duration::from_secs(900))
            }
            "openai_speech" => hosted("api.openai.com", OPENAI, post, "https://api.openai.com/v1/audio/speech".into(), json_object(&self.body)?),
            "openai_transcribe" => {
                let audio = recording(self.audio.as_deref())?;
                hosted("api.openai.com", OPENAI, post, "https://api.openai.com/v1/audio/transcriptions".into(), Payload::Upload { fields: fields(&self.body, &["model", "language", "prompt"])?, audio })
            }
            "gemini_models" => hosted("generativelanguage.googleapis.com", GEMINI, get, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200".into(), Payload::None),
            "gemini_generate" => hosted("generativelanguage.googleapis.com", GEMINI, post, format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", target()?), json_object(&self.body)?),
            "elevenlabs_voices" => hosted("api.elevenlabs.io", ELEVEN, get, "https://api.elevenlabs.io/v1/voices".into(), Payload::None),
            "elevenlabs_speech" => hosted("api.elevenlabs.io", ELEVEN, post, format!("https://api.elevenlabs.io/v1/text-to-speech/{}?output_format=pcm_24000", target()?), json_object(&self.body)?),
            "elevenlabs_dialogue" => hosted("api.elevenlabs.io", ELEVEN, post, "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=pcm_24000".into(), json_object(&self.body)?),
            "elevenlabs_transcribe" => {
                let audio = recording(self.audio.as_deref())?;
                hosted("api.elevenlabs.io", ELEVEN, post, "https://api.elevenlabs.io/v1/speech-to-text".into(), Payload::Upload { fields: fields(&self.body, &["model_id", "language_code"])?, audio })
            }
            "whistle_status" => Ok(Plan::WhistleStatus),
            "whistle_install" => Ok(Plan::WhistleInstall),
            "whistle_transcribe" => {
                let audio = recording(self.audio.as_deref())?;
                let language = fields(&self.body, &["language"])?.into_iter().next().map(|(_, v)| v);
                if language.as_deref().is_some_and(|l| !WHISTLE_LANGUAGES.contains(&l)) { return Err("Whistle does not transcribe this language"); }
                Ok(Plan::WhistleTranscribe { audio, language })
            }
            _ => Err("Unsupported voice operation"),
        }
    }
}

/// A multipart body and its content type: the fields, then the recording as speech.wav.
pub(crate) fn multipart(fields: &[(String, String)], audio: &[u8]) -> (String, Vec<u8>) {
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let boundary = format!("vak-{}", &hex(&Sha256::digest(format!("{seed}{}", audio.len()).as_bytes()))[..32]);
    let mut body = Vec::with_capacity(audio.len() + 512);
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 { return None; }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index == bytes.len() / 4 - 1;
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) { return None; }
        let mut n = 0u32;
        for &c in &chunk[..4 - pad] { n = (n << 6) | u32::from(value(c)?); }
        n <<= 6 * pad as u32;
        let decoded = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&decoded[..3 - pad]);
    }
    Some(out)
}

// --- Whistle ---------------------------------------------------------------------
// Cactus Compute's prebuilt engine has no published source, so it is untrusted:
// both files are pinned to Hugging Face commits and their SHA-256, it gets no
// environment, and it runs with networking denied and writes confined to its folder.

const ENGINE_REV: &str = "93e88ede867e4311c39151285e74df513e4b835b";
const WEIGHTS_REV: &str = "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5";
const WHISTLE_LANGUAGES: &[&str] = &["en", "de", "fr", "es", "it", "nl", "pl"];

struct Pinned { name: &'static str, path: String, bytes: u64, sha256: &'static str, mode: u32 }

fn pinned() -> [Pinned; 2] {
    [
        Pinned { name: "needle", path: format!("Cactus-Compute/needle3/resolve/{ENGINE_REV}/macos-arm64/needle"), bytes: 1_106_424, sha256: "1e7e698b492904a92496e2b168844a3101e671928ffa6372970d897512251c48", mode: 0o755 },
        Pinned { name: "whistle.cact", path: format!("Cactus-Compute/whistle/resolve/{WEIGHTS_REV}/whistle.cact"), bytes: 16_919_407, sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb", mode: 0o644 },
    ]
}

const SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

/// One folder per pinned pair, in Rust-owned data outside every worker grant.
fn whistle_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("voice").join("whistle").join(format!("{}-{}", &ENGINE_REV[..12], &WEIGHTS_REV[..12]))
}

/// Installed only when every file matches its pin, checked on each use.
fn whistle_installed(dir: &Path) -> bool {
    pinned().iter().all(|file| {
        std::fs::read(dir.join(file.name)).is_ok_and(|bytes| bytes.len() as u64 == file.bytes && hex(&Sha256::digest(&bytes)) == file.sha256)
    })
}

/// A JSON answer and its status, relayed like an HTTP response.
pub(crate) type Answer = (u16, serde_json::Value);
fn refused(status: u16, message: impl Into<String>) -> Answer {
    (status, serde_json::json!({ "error": message.into() }))
}

pub(crate) fn whistle_status(data_dir: &Path) -> Answer {
    (200, serde_json::json!({ "supported": SUPPORTED, "installed": SUPPORTED && whistle_installed(&whistle_dir(data_dir)) }))
}

/// Download both files, check each against its pin, then move the folder into place whole.
pub(crate) fn whistle_install(data_dir: &Path) -> Answer {
    if !SUPPORTED { return refused(400, "Whistle runs on Apple Silicon Macs."); }
    let target = whistle_dir(data_dir);
    if whistle_installed(&target) { return (200, serde_json::json!({ "ok": true })); }
    // Hugging Face answers with a redirect to its own content hosts; nothing else is followed.
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let host = attempt.url().host_str().unwrap_or("").to_owned();
        let trusted = host == "huggingface.co" || host.ends_with(".huggingface.co") || host.ends_with(".hf.co");
        if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" || !trusted { attempt.stop() } else { attempt.follow() }
    });
    let client = match reqwest::blocking::Client::builder().no_proxy().redirect(policy).timeout(Duration::from_secs(300)).build() {
        Ok(client) => client,
        Err(_) => return refused(500, "The download could not start"),
    };
    let staging = target.with_extension("part");
    let _ = std::fs::remove_dir_all(&staging);
    let result = (|| -> Result<(), String> {
        std::fs::create_dir_all(&staging).map_err(|_| "The voice folder could not be created".to_owned())?;
        for file in pinned() {
            let response = client.get(format!("https://huggingface.co/{}", file.path)).send().map_err(|_| "Hugging Face is not reachable".to_owned())?;
            if !response.status().is_success() { return Err(format!("Downloading {} failed: {}", file.name, response.status().as_u16())); }
            let mut bytes = Vec::with_capacity(file.bytes as usize);
            response.take(file.bytes + 1).read_to_end(&mut bytes).map_err(|_| format!("Downloading {} was interrupted", file.name))?;
            if bytes.len() as u64 != file.bytes || hex(&Sha256::digest(&bytes)) != file.sha256 { return Err(format!("{} does not match its pinned checksum", file.name)); }
            write_private(&staging.join(file.name), &bytes, file.mode)?;
        }
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&staging, &target).map_err(|_| "The voice pack could not be put in place".to_owned())
    })();
    match result {
        Ok(()) => (200, serde_json::json!({ "ok": true })),
        Err(message) => { let _ = std::fs::remove_dir_all(&staging); refused(502, message) }
    }
}

fn write_private(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|_| "The voice pack could not be saved".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|_| "The voice pack could not be saved".to_owned())?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

/// One recording to text, the engine confined to its own folder with no network.
pub(crate) fn whistle_transcribe(data_dir: &Path, audio: &[u8], language: Option<&str>) -> Answer {
    if !SUPPORTED { return refused(400, "Whistle runs on Apple Silicon Macs."); }
    let home = whistle_dir(data_dir);
    if !whistle_installed(&home) { return refused(400, "Install the Whistle pack in Providers → Whistle."); }
    let Ok(home) = home.canonicalize() else { return refused(500, "The Whistle folder is unavailable") };
    let Some(home_text) = home.to_str().filter(|p| !p.contains(['"', '\\'])) else { return refused(500, "The Whistle folder path is unsupported") };
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let clip = home.join(format!("clip-{}-{seed}.wav", std::process::id()));
    if let Err(message) = write_private(&clip, audio, 0o600) { return refused(500, message); }
    let profile = format!("(version 1)(allow default)(deny network*)(deny file-write* (require-not (subpath \"{home_text}\")))");
    let mut cmd = Command::new("/usr/bin/sandbox-exec");
    cmd.arg("-p").arg(profile).arg(home.join("needle"))
        .arg("--model").arg(home.join("whistle.cact"))
        .arg("--audio").arg(&clip);
    if let Some(language) = language { cmd.arg("--audio-language").arg(language); }
    cmd.env_clear().current_dir(&home).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let answer = run_bounded(cmd, Duration::from_secs(120));
    let _ = std::fs::remove_file(&clip);
    match answer {
        Ok(stdout) => {
            let text = stdout.trim().lines().last()
                .and_then(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .and_then(|v| v.get("text").and_then(serde_json::Value::as_str).map(|t| t.trim().to_owned()));
            match text {
                Some(text) => (200, serde_json::json!({ "text": text })),
                None => refused(502, "Whistle returned no transcript"),
            }
        }
        Err(message) => refused(502, message),
    }
}

/// Run to completion within `limit`, keeping a bounded tail of each stream.
fn run_bounded(mut cmd: Command, limit: Duration) -> Result<String, String> {
    let mut child = cmd.spawn().map_err(|_| "Whistle could not start".to_owned())?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || { let mut s = Vec::new(); let _ = (&mut stdout).take(1 << 20).read_to_end(&mut s); s });
    let err = std::thread::spawn(move || { let mut s = Vec::new(); let _ = (&mut stderr).take(1 << 16).read_to_end(&mut s); s });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(25)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("Whistle took too long".into()); }
        }
    };
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    if status.success() { return Ok(stdout); }
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    Err(format!("Whistle stopped ({}): {}", status.code().map_or("killed".into(), |c| c.to_string()), stderr.trim().lines().last().unwrap_or("").chars().take(300).collect::<String>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: &str, body: &str, target: Option<&str>, audio: Option<&str>) -> VoiceRequest {
        VoiceRequest { v: 2, id: "voc-1".into(), kind: "voice_request".into(), operation: operation.into(), target: target.map(Into::into), body: body.into(), audio: audio.map(Into::into) }
    }
    const WAV: &str = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

    #[test]
    fn decodes_base64_strictly() {
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert!(decode_base64("aG=k").is_none());
        assert!(decode_base64("a").is_none());
        assert!(decode_base64("aGk*").is_none());
    }

    #[test]
    fn destinations_are_fixed_by_operation() {
        let Ok(Plan::Remote(r)) = request("ollama_speech", "{\"model\":\"phonon:latest\"}", None, None).plan(2) else { panic!() };
        assert_eq!(r.url, "http://127.0.0.1:11434/v1/audio/speech");
        assert!(r.host.is_none() && r.credential.is_none());
        let Ok(Plan::Remote(r)) = request("openai_speech", "{}", None, None).plan(2) else { panic!() };
        assert_eq!((r.host, r.credential.unwrap().0), (Some("api.openai.com"), "OPENAI_API_KEY"));
        let Ok(Plan::Remote(r)) = request("elevenlabs_speech", "{}", Some("abc123"), None).plan(2) else { panic!() };
        assert_eq!(r.url, "https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=pcm_24000");
        assert!(request("elevenlabs_speech", "{}", Some("../x"), None).plan(2).is_err());
        assert!(request("gemini_generate", "{}", None, None).plan(2).is_err());
        assert!(request("ollama_delete", "{}", None, None).plan(2).is_err());
        assert!(request("ollama_speech", "[]", None, None).plan(2).is_err());
        assert!(request("ollama_speech", "{}", None, None).plan(1).is_err());
    }

    #[test]
    fn pulls_only_plain_catalog_names() {
        let Ok(Plan::Remote(r)) = request("ollama_pull", "{\"model\":\"phonon:fr\",\"insecure\":true}", None, None).plan(2) else { panic!() };
        let Payload::Json(body) = r.payload else { panic!() };
        assert_eq!(body, "{\"model\":\"phonon:fr\",\"stream\":false}");
        assert!(request("ollama_pull", "{\"model\":\"someone/lfm3-audio\"}", None, None).plan(2).is_ok());
        for bad in ["hf.co/x/y", "a/b/c", "https://evil", "Phonon", "../x", ":tag", "x:"] {
            assert!(request("ollama_pull", &format!("{{\"model\":\"{bad}\"}}"), None, None).plan(2).is_err(), "{bad}");
        }
    }

    #[test]
    fn uploads_need_a_wav_and_listed_fields() {
        let Ok(Plan::Remote(r)) = request("openai_transcribe", "{\"model\":\"whisper-1\",\"language\":\"en\"}", None, Some(WAV)).plan(2) else { panic!() };
        let Payload::Upload { fields, audio } = r.payload else { panic!() };
        assert_eq!(fields.len(), 2);
        let (kind, body) = multipart(&fields, &audio);
        let text = String::from_utf8_lossy(&body);
        assert!(kind.starts_with("multipart/form-data; boundary=vak-"));
        assert!(text.contains("name=\"model\"\r\n\r\nwhisper-1\r\n") && text.contains("filename=\"speech.wav\""));
        assert!(request("openai_transcribe", "{\"model\":\"whisper-1\"}", None, None).plan(2).is_err());
        assert!(request("openai_transcribe", "{\"url\":\"x\"}", None, Some(WAV)).plan(2).is_err());
        assert!(request("openai_transcribe", "{\"model\":\"a\\r\\nb\"}", None, Some(WAV)).plan(2).is_err());
        assert!(request("openai_transcribe", "{\"model\":\"m\"}", None, Some("aGk=")).plan(2).is_err());
        assert!(request("openai_speech", "{}", None, Some(WAV)).plan(2).is_err());
        assert!(matches!(request("whistle_transcribe", "{\"language\":\"ja\"}", None, Some(WAV)).plan(2), Err(_)));
        assert!(matches!(request("whistle_transcribe", "{\"language\":\"fr\"}", None, Some(WAV)).plan(2), Ok(Plan::WhistleTranscribe { .. })));
    }

    /// Downloads the real pack (18 MB): `cargo test --lib voice -- --ignored`.
    #[test]
    #[ignore]
    fn installs_and_runs_the_pinned_whistle_pack() {
        let dir = std::env::temp_dir().join(format!("vak-whistle-{}", std::process::id()));
        assert_eq!(whistle_install(&dir).0, 200);
        assert_eq!(whistle_status(&dir).1["installed"], true);
        let wav = std::fs::read(std::env::var("VAK_WHISTLE_SAMPLE").unwrap_or_default()).ok();
        if let Some(wav) = wav {
            let (status, body) = whistle_transcribe(&dir, &wav, Some("en"));
            assert_eq!(status, 200, "{body}");
            assert!(!body["text"].as_str().unwrap().is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn whistle_lives_in_rust_owned_data() {
        let dir = whistle_dir(Path::new("/data"));
        assert!(dir.starts_with("/data/voice/whistle") && !dir.starts_with("/data/worker"));
        assert!(!whistle_installed(Path::new("/nonexistent")));
    }
}
