use reqwest::Url;
use sha2::{Digest, Sha256};

pub(crate) fn stable_id(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())
}

pub(crate) fn short_hash(seed: &str) -> String {
    stable_id(seed)[..8].to_string()
}

pub(crate) fn provider_segment(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return "downloads".to_string();
    };

    let Some(host) = parsed.host_str() else {
        return "downloads".to_string();
    };

    if host.ends_with("youtube.com") || host.eq_ignore_ascii_case("youtu.be") {
        return "youtube".to_string();
    }

    host.trim_start_matches("www.")
        .split('.')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("downloads")
        .to_string()
}

pub(crate) fn sanitize_path_component(text: &str) -> String {
    let mut sanitized = text
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            ch if ch.is_control() => '-',
            _ => ch,
        })
        .collect::<String>();

    while sanitized.ends_with('.') || sanitized.ends_with(' ') {
        sanitized.pop();
    }

    if sanitized.is_empty() {
        "untitled".to_string()
    } else {
        sanitized
    }
}
