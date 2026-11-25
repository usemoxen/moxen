//! Keeping identifiers and secrets out of logs, `Debug` output and error
//! messages.
//!
//! The repository is public and a log line outlives the session that wrote it,
//! so nothing this crate renders may carry a token, a session id, an account
//! uid or an IBAN in full. [`mask`] shortens anything identifier-like to a
//! short prefix, [`mask_url`] applies the same rule to a URL's path and query,
//! and [`clip`] bounds a message that came from the API.

/// The longest string left untouched. Ids (session ids, account uids, JWTs,
/// continuation keys) are longer; dates, currency codes, status codes and
/// balances-derived numbers are not.
const SAFE_LENGTH: usize = 12;

/// The prefix a masked value keeps.
const PREFIX: usize = 8;

/// Shorten `value` to its first 8 characters when it is long enough to be an
/// identifier, so `73100c65-c54d-46a1-87d1-aa3effde435a` becomes
/// `73100c65…`. Anything short stays as it is.
pub fn mask(value: &str) -> String {
    if value.chars().count() <= SAFE_LENGTH {
        return value.to_string();
    }
    let prefix: String = value.chars().take(PREFIX).collect();
    format!("{prefix}…")
}

/// [`mask`] every long segment of a URL: its path, and each query value. The
/// scheme and the host stay readable, because they say which service was
/// called and hold no identifier; a path segment or a query value longer than
/// [`SAFE_LENGTH`] is an id, a key or a code.
pub fn mask_url(url: &str) -> String {
    let (base, query) = match url.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (url, None),
    };
    let (authority, path) = match base.find("://") {
        Some(separator) => {
            let after = separator + 3;
            match base[after..].find('/') {
                Some(slash) => (&base[..after + slash], &base[after + slash..]),
                None => (base, ""),
            }
        }
        None => ("", base),
    };
    let path = path.split('/').map(mask).collect::<Vec<_>>().join("/");
    let base = format!("{authority}{path}");
    match query {
        // Keys are ours (`date_from`, `strategy`) and values are either dates
        // or opaque keys; masking by length leaves the dates readable.
        Some(query) => {
            let query = query
                .split('&')
                .map(|pair| match pair.split_once('=') {
                    Some((key, value)) => format!("{key}={}", mask(value)),
                    None => mask(pair),
                })
                .collect::<Vec<_>>()
                .join("&");
            format!("{base}?{query}")
        }
        None => base,
    }
}

/// Bound a message that came from somewhere else (an API error, an IO error)
/// so a single failure cannot fill a log with a payload.
pub fn clip(message: &str) -> String {
    const MAX: usize = 200;
    let message = message.trim();
    if message.chars().count() <= MAX {
        return message.to_string();
    }
    let kept: String = message.chars().take(MAX).collect();
    format!("{kept}…")
}
