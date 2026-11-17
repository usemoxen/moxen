//! What the Context tab and the composer's usage rows show, read from the
//! server: the live breakdown (`thread.context`), the last recorded reading
//! (`thread.context-reading`), the account's plan usage (`usage.limits`) and
//! usage protection holds (`usage.protection`, `usage.wrap`, `usage.queue`).
//!
//! The decoding and wording follow the TUI's reading of the same answers
//! (`src/tui/features/sidepanel/sidepanel.tsx`, `model/sidepanel.ts`,
//! `model/usageprotection.tsx`, `core/usage/present.ts`): shares are each
//! category's part of the window, a reset that already passed reads as no
//! reset, and anything the server did not report reads as "no data", never
//! as 0% or unlimited.

use crate::{
    live::{now_ms, text},
    theme::{self, color},
    ui,
};
use gpui::{prelude::*, *};
use serde_json::Value;
use std::collections::HashMap;

/// What the server did not report: shown in place of a number, never as 0%.
pub const NO_DATA: &str = "no data";

/// `359_000` → `"359k"`, `999_999` → `"1m"`, `1_400_000` → `"1.4m"`: the TUI's
/// `formatTokenCount` (`src/tui/model/turns.ts`).
pub fn format_count(value: i64) -> String {
    if value < 1000 {
        return value.max(0).to_string();
    }
    if value < 1_000_000 {
        let thousands = (value as f64 / 1000.).round() as i64;
        // 999_999 rounds to a thousand thousands: read it as millions below.
        if thousands < 1000 {
            return format!("{thousands}k");
        }
    }
    let millions = (value as f64 / 1_000_000. * 10.).round() / 10.;
    if millions.fract() == 0. {
        format!("{}m", millions as i64)
    } else {
        format!("{millions:.1}m")
    }
}

/// A share of the window in words: `0.66` → `"66%"`. `present.ts` reads a
/// share under a tenth of a percent as a trace, and zero as zero.
pub fn format_share(share: f64) -> String {
    if share <= 0. {
        return "0%".to_string();
    }
    if share < 0.001 {
        return "<0.1%".to_string();
    }
    let percent = share * 100.;
    let rounded = (percent * 10.).round() / 10.;
    if rounded.fract() == 0. {
        format!("{}%", rounded as i64)
    } else {
        format!("{rounded:.1}%")
    }
}

/// "in 1h 12m" / "in 4m" / "now" until a reset instant: the TUI's `untilLabel`
/// (`src/tui/model/thread.ts`).
pub fn until_label(target_ms: i64, now_ms: i64) -> String {
    let minutes = (target_ms - now_ms + 59_999).div_euclid(60_000);
    if minutes <= 0 {
        return "now".to_string();
    }
    let hours = minutes / 60;
    let days = hours / 24;
    if days > 0 {
        return format!("in {days}d {}h", hours % 24);
    }
    if hours > 0 {
        return format!("in {hours}h {}m", minutes % 60);
    }
    format!("in {minutes}m")
}

/// A reset time as the plan-usage rows show it: `↻ 2h 5m`, without the "in".
/// A reset that already passed (or never parses) is not a reset.
pub fn reset_label(resets_at: Option<&str>, now: i64) -> Option<String> {
    let at = resets_at?;
    let target = crate::live::parse_iso_ms(at)?;
    if target <= now {
        return None;
    }
    Some(format!(
        "↻ {}",
        until_label(target, now).trim_start_matches("in ")
    ))
}

pub(crate) fn number(value: &Value, path: &[&str]) -> Option<i64> {
    let mut at = value;
    for key in path {
        at = at.get(key)?;
    }
    at.as_i64()
        .or_else(|| at.as_u64().map(|n| n.min(i64::MAX as u64) as i64))
        .or_else(|| at.as_f64().map(|n| n as i64))
}

/// One quota window of a provider's plan usage (`ProviderUsageWindow` in
/// `src/core/catalog/summary.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindow {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

impl UsageWindow {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        let used = value.get("usedPercent")?.as_f64()?;
        Some(Self {
            id: text(value, &["id"])?.to_string(),
            kind: text(value, &["kind"]).unwrap_or("other").to_string(),
            label: text(value, &["label"]).unwrap_or_default().to_string(),
            used_percent: used,
            resets_at: text(value, &["resetsAt"]).map(str::to_string),
        })
    }
}

/// A provider's account limits, as `usage.limits` reports them: the windows,
/// or why nothing can be reported (an API key account, or a failed probe).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProviderLimits {
    pub windows: Vec<UsageWindow>,
    pub unavailable: Option<String>,
}

impl ProviderLimits {
    pub(crate) fn from_json(value: &Value) -> Self {
        let unavailable = value
            .get("unavailable")
            .filter(|unavailable| !unavailable.is_null())
            .and_then(|unavailable| {
                text(unavailable, &["message"])
                    .filter(|message| !message.is_empty())
                    .map(str::to_string)
            });
        let windows = value
            .get("windows")
            .and_then(Value::as_array)
            .map(|windows| windows.iter().filter_map(UsageWindow::from_json).collect())
            .unwrap_or_default();
        Self {
            windows,
            unavailable,
        }
    }
}

/// Every provider's limits, keyed by account (`usageKeyForInstance` in
/// `src/core/usage/limits.ts`): the driver kind, or an `opencode/<provider>`
/// instance of its own.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LimitsData {
    pub providers: HashMap<String, ProviderLimits>,
    pub error: Option<String>,
}

impl LimitsData {
    pub fn from_json(value: &Value) -> Self {
        let providers = value
            .get("providers")
            .and_then(Value::as_object)
            .map(|providers| {
                providers
                    .iter()
                    .map(|(key, limits)| (key.clone(), ProviderLimits::from_json(limits)))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            providers,
            error: None,
        }
    }

    /// The limits for a thread's provider: its own account first, then its
    /// driver's, as the TUI's composer does.
    pub fn for_instance(&self, instance: &str) -> Option<&ProviderLimits> {
        let key = instance.trim().to_lowercase();
        self.providers.get(&key).or_else(|| {
            let kind = driver_kind(&key)?;
            self.providers.get(kind)
        })
    }
}

/// The driver an instance id routes to (`driverKindOfInstance` in
/// `src/core/types.ts`).
pub(crate) fn driver_kind(instance: &str) -> Option<&str> {
    let key = instance.trim().to_lowercase();
    if key == "codex" {
        return Some("codex");
    }
    if key == "opencode" || key.starts_with("opencode/") {
        return Some("opencode");
    }
    if key == "harness" || key.starts_with("harness/") {
        return Some("harness");
    }
    if key == "claudeagent" || key == "claude" {
        return Some("claude");
    }
    None
}

/// One gauge of the composer's compact reading: the session window and the
/// main weekly one always, any other window only once it is past 70% — the
/// point where it can bite (`planUsageGauges` in `model/sidepanel.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct Gauge {
    pub short: String,
    pub percent: f64,
}

pub fn plan_gauges(limits: Option<&ProviderLimits>) -> Vec<Gauge> {
    let Some(limits) = limits else {
        return vec![];
    };
    let short = |kind: &str| match kind {
        "session" => Some("5h"),
        "weekly" => Some("wk"),
        "monthly" => Some("mo"),
        _ => None,
    };
    let mut gauges = vec![];
    let mut seen = std::collections::HashSet::new();
    for window in &limits.windows {
        if !seen.contains(window.kind.as_str())
            && let Some(name) = short(&window.kind)
        {
            seen.insert(window.kind.as_str());
            gauges.push(Gauge {
                short: name.to_string(),
                percent: window.used_percent,
            });
        } else if window.used_percent >= 70. {
            // "Weekly – Opus" → "Opus".
            let name = window
                .label
                .split(['–', '-'])
                .next_back()
                .unwrap_or(&window.label);
            gauges.push(Gauge {
                short: name.trim().to_string(),
                percent: window.used_percent,
            });
        }
    }
    gauges
}

/// What fills the context window, by category, from `ContextBreakdown` in
/// `src/core/providers/spi.ts`.
#[derive(Clone, Debug, PartialEq)]
pub struct Category {
    pub name: String,
    pub tokens: i64,
    /// `used` fills the window; `free` is what is left; `buffer` is held back.
    pub kind: CategoryKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CategoryKind {
    Used,
    Free,
    Buffer,
}

impl CategoryKind {
    pub(crate) fn from_json(kind: &str) -> Self {
        match kind {
            "free" => Self::Free,
            "buffer" => Self::Buffer,
            _ => Self::Used,
        }
    }
}

/// One tool's share of the conversation, heaviest first.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolShare {
    pub name: String,
    pub tokens: i64,
}

/// The live breakdown: the provider's own count, or its total without
/// categories. `estimated` is true when the shares are moxen's estimate
/// rather than the provider's own count.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Breakdown {
    pub used: i64,
    pub max: Option<i64>,
    pub cached: Option<i64>,
    pub threshold: Option<i64>,
    pub compacts: Option<bool>,
    pub cost: Option<f64>,
    pub categories: Vec<Category>,
    pub tools: Vec<ToolShare>,
    pub estimated: bool,
}

impl Breakdown {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            used: number(value, &["usedTokens"])?,
            max: number(value, &["maxTokens"]),
            cached: number(value, &["cachedInputTokens"]),
            threshold: number(value, &["autoCompactThreshold"]),
            compacts: value.get("compactsAutomatically").and_then(Value::as_bool),
            cost: value.get("costUsd").and_then(Value::as_f64),
            categories: value
                .get("categories")
                .and_then(Value::as_array)
                .map(|categories| {
                    categories
                        .iter()
                        .filter_map(|category| {
                            Some(Category {
                                name: text(category, &["name"])?.to_string(),
                                tokens: number(category, &["tokens"])?,
                                kind: CategoryKind::from_json(
                                    text(category, &["kind"]).unwrap_or("used"),
                                ),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            tools: value
                .get("tools")
                .and_then(Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(|tool| {
                            Some(ToolShare {
                                name: text(tool, &["name"])?.to_string(),
                                tokens: number(tool, &["tokens"])?,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            estimated: value.get("estimated").and_then(Value::as_bool) == Some(true),
        })
    }
}

/// The latest reading moxen recorded for a thread: the totals, when they
/// were taken, and whether a compaction has made them stale
/// (`thread.context-reading`).
#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    pub used: i64,
    pub max: Option<i64>,
    pub taken_at: String,
    pub compacted_since: bool,
}

impl Reading {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        let reading = value.get("reading")?;
        if reading.is_null() {
            return None;
        }
        Some(Self {
            used: number(reading, &["usedTokens"])?,
            max: number(reading, &["maxTokens"]),
            taken_at: text(reading, &["takenAt"]).unwrap_or_default().to_string(),
            compacted_since: reading.get("compactedSince").and_then(Value::as_bool) == Some(true),
        })
    }
}

/// What the Context tab shows for a thread: the live breakdown and the last
/// recorded reading behind it. `error` is a read that failed; no data and no
/// error means no read has answered yet.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContextData {
    pub live: bool,
    pub breakdown: Option<Breakdown>,
    pub reading: Option<Reading>,
    pub error: Option<String>,
}

impl ContextData {
    /// The used and ceiling the status line and header read: the live
    /// breakdown first, then the last recorded reading.
    pub fn totals(&self) -> Option<(i64, Option<i64>)> {
        if let Some(breakdown) = &self.breakdown {
            return Some((breakdown.used, breakdown.max));
        }
        self.reading
            .as_ref()
            .map(|reading| (reading.used, reading.max))
    }
}

/// One category's share of the window, largest used first, free space and
/// buffer last (`contextShares` in `model/sidepanel.ts`).
pub struct Share<'a> {
    pub name: &'a str,
    pub tokens: i64,
    /// Of the whole window (or of what is used, when its size is unknown).
    pub percent: f64,
    pub kind: CategoryKind,
}

pub fn context_shares(categories: &[Category], max: Option<i64>, used: i64) -> Vec<Share<'_>> {
    let whole = match max {
        Some(max) if max > 0 => max as f64,
        _ => used.max(1) as f64,
    };
    let mut shares: Vec<Share> = categories
        .iter()
        .filter(|category| category.tokens > 0)
        .map(|category| Share {
            name: &category.name,
            tokens: category.tokens,
            percent: category.tokens as f64 / whole * 100.,
            kind: category.kind,
        })
        .collect();
    shares.sort_by(|left, right| {
        let rank = |kind: CategoryKind| match kind {
            CategoryKind::Used => 0,
            CategoryKind::Buffer => 1,
            CategoryKind::Free => 2,
        };
        rank(left.kind)
            .cmp(&rank(right.kind))
            .then(right.tokens.cmp(&left.tokens))
    });
    shares
}

/// A forecast that the account's allowance runs out mid-work: the provider,
/// the window, and whether the thread should wrap up now.
#[derive(Clone, Debug, PartialEq)]
pub struct Forecast {
    pub provider: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
    pub remaining_ms: Option<i64>,
    pub should_wrap: bool,
}

impl Forecast {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            provider: text(value, &["provider"])?.to_string(),
            label: text(value, &["label"]).unwrap_or_default().to_string(),
            used_percent: value
                .get("usedPercent")
                .and_then(Value::as_f64)
                .unwrap_or(0.),
            resets_at: text(value, &["resetsAt"]).map(str::to_string),
            remaining_ms: number(value, &["remainingWorkMs"]),
            should_wrap: value.get("shouldWrap").and_then(Value::as_bool) == Some(true),
        })
    }
}

/// Where a recovering thread stands: paused, wrapping up, waiting for the
/// reset, or resuming. `usageQueueStatus` in `model/usageprotection.tsx`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QueuePhase {
    #[default]
    Pending,
    Wrapping,
    Waiting,
    Resuming,
    /// The window reset and the work picked up where it stopped.
    Resumed,
}

impl QueuePhase {
    pub(crate) fn from_json(entry: &Value) -> Self {
        let running = text(entry, &["phase"]) == Some("resuming")
            && entry.get("error").and_then(Value::as_str).is_none();
        if running {
            return Self::Resumed;
        }
        match text(entry, &["phase"]) {
            Some("wrapping") => Self::Wrapping,
            Some("waiting") => Self::Waiting,
            Some("resuming") => Self::Resuming,
            _ => Self::Pending,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "paused",
            Self::Wrapping => "wrapping up",
            Self::Waiting => "waiting for usage",
            Self::Resuming => "resuming",
            Self::Resumed => "resumed",
        }
    }
}

/// One thread waiting on its allowance: what it says, and what the person
/// can do about it. A forced hold waits on no reset and cannot be cancelled;
/// reordering it still applies.
#[derive(Clone, Debug, PartialEq)]
pub struct QueueEntry {
    pub thread_id: String,
    pub title: String,
    pub phase: QueuePhase,
    pub resets_at: Option<String>,
    pub forced: bool,
    pub error: Option<String>,
}

impl QueueEntry {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            thread_id: text(value, &["threadId"])?.to_string(),
            title: text(value, &["title"]).unwrap_or_default().to_string(),
            phase: QueuePhase::from_json(value),
            resets_at: text(value, &["resetsAt"]).map(str::to_string),
            forced: value.get("forced").and_then(Value::as_bool) == Some(true),
            error: text(value, &["error"]).map(str::to_string),
        })
    }

    /// The line under the entry: how long the wait is, or what ends it.
    pub fn detail(&self, now: i64) -> String {
        if self.phase == QueuePhase::Resumed {
            return "The usage window reset and the work picked up where it stopped.".to_string();
        }
        if self.forced {
            return "Manually protected. Send a message to end it.".to_string();
        }
        if let Some(error) = &self.error {
            return error.clone();
        }
        match &self.resets_at {
            None => "No reset time reported; automatic recovery is held.".to_string(),
            Some(at) => match crate::live::parse_iso_ms(at) {
                None => "No reset time reported; automatic recovery is held.".to_string(),
                Some(target) if target <= now => {
                    "Usage has reset · recovery starts shortly · messages wait in this thread's queue".to_string()
                }
                Some(target) => {
                    format!(
                        "Resets in {} · messages wait in this thread's queue",
                        duration_words(target - now)
                    )
                }
            },
        }
    }

    /// What the person can do: moves always, Cancel unless the hold is forced
    /// or already resuming.
    pub fn actions(&self) -> Vec<QueueMove> {
        if self.phase == QueuePhase::Resumed || self.forced {
            if self.phase == QueuePhase::Resumed {
                return vec![];
            }
            return vec![QueueMove::First, QueueMove::Last];
        }
        vec![QueueMove::First, QueueMove::Last, QueueMove::Cancel]
    }
}

/// Minutes in words: "4 min", "1 h 2 min". The TUI counts minutes up under an
/// hour and hours above it.
pub fn duration_words(ms: i64) -> String {
    let mut minutes = (ms + 59_999).div_euclid(60_000).max(0);
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let hours = minutes / 60;
    minutes %= 60;
    if minutes == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {minutes} min")
    }
}

/// Moves and cancels of one recovery-queue entry (`usage.queue`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueMove {
    First,
    Last,
    Cancel,
}

impl QueueMove {
    /// The value the server's `usage.queue` reads.
    pub fn wire(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Last => "last",
            Self::Cancel => "cancel",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::First => "Move first",
            Self::Last => "Move last",
            Self::Cancel => "Cancel recovery",
        }
    }
}

/// Usage protection as `usage.protection` reports it: the forecasts and the
/// recovery queue. `error` is a read that failed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProtectionData {
    pub forecasts: Vec<Forecast>,
    pub queue: Vec<QueueEntry>,
    pub error: Option<String>,
}

impl ProtectionData {
    pub fn from_json(value: &Value) -> Self {
        let forecasts = value
            .get("forecasts")
            .and_then(Value::as_array)
            .map(|forecasts| forecasts.iter().filter_map(Forecast::from_json).collect())
            .unwrap_or_default();
        let queue = value
            .get("queue")
            .and_then(Value::as_array)
            .map(|queue| queue.iter().filter_map(QueueEntry::from_json).collect())
            .unwrap_or_default();
        Self {
            forecasts,
            queue,
            error: None,
        }
    }
}

/// The open thread's own hold, off its snapshot: protection is holding it,
/// by the person when forced, with automatic wake-ups waiting.
#[derive(Clone, Debug, PartialEq)]
pub struct Hold {
    pub forced: bool,
    pub waiting: u64,
}

impl Hold {
    pub fn from_json(value: &Value) -> Option<Self> {
        let protection = value.get("protection")?;
        if protection.get("protected").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        Some(Self {
            forced: protection.get("forced").and_then(Value::as_bool) == Some(true),
            waiting: protection
                .get("waitingWakeUps")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
    }

    pub fn title(&self) -> &'static str {
        if self.forced {
            "Thread protected by you"
        } else {
            "Thread protected"
        }
    }

    pub fn detail(&self) -> &'static str {
        if self.forced {
            "Nothing runs on its own. Send a message to end it."
        } else {
            "Automatic wake-ups wait until the allowance resets, or until you send a message."
        }
    }
}

/// The thread's recorded context totals, off its snapshot: what the status
/// line reads without another query.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SnapshotUsage {
    pub used: i64,
    pub max: Option<i64>,
}

impl SnapshotUsage {
    pub fn from_json(thread: &Value) -> Option<Self> {
        let usage = thread.get("contextUsage")?;
        if usage.is_null() {
            return None;
        }
        Some(Self {
            used: number(usage, &["usedTokens"])?,
            max: number(usage, &["maxTokens"]),
        })
    }
}

fn mono(text: String) -> Div {
    div()
        .font_family(theme::MONO)
        .text_size(px(12.))
        .text_color(color("ink-2"))
        .child(text)
}

/// The status line's usage meter: each used category its own colour, in
/// stacked order. Missing shares leave it out rather than show an empty bar.
pub fn meter(shares: &[Share], width: f32, height: f32) -> impl IntoElement {
    let mut used = 0;
    let colors: Vec<(&str, f32)> = shares
        .iter()
        .map(|share| {
            let token = match share.kind {
                CategoryKind::Free => "rule",
                CategoryKind::Buffer => "ink-2",
                CategoryKind::Used => {
                    let tokens = [
                        "context-tools",
                        "context-system",
                        "context-reasoning",
                        "context-messages",
                    ];
                    let token = tokens[used % tokens.len()];
                    used += 1;
                    token
                }
            };
            (token, share.percent as f32)
        })
        .collect();
    div()
        .w(px(width))
        .h(px(height))
        .flex_shrink_0()
        .flex()
        .rounded(px(height / 2.))
        .overflow_hidden()
        .bg(color("sunk"))
        .children(
            colors.into_iter().map(move |(token, part)| {
                div().h_full().w(px(width * part / 100.)).bg(color(token))
            }),
        )
}

/// The Context tab: what fills the window, then the account's plan usage.
/// Missing readings read as "no data", never as 0% or unlimited.
pub fn render(
    data: &ContextData,
    limits: Option<&ProviderLimits>,
    provider_name: Option<&str>,
) -> impl IntoElement {
    let now = now_ms();
    let breakdown = data.breakdown.as_ref();
    let (used, max) = data
        .totals()
        .map(|(used, max)| (Some(used), max))
        .unwrap_or((None, None));
    let shares = breakdown
        .map(|breakdown| context_shares(&breakdown.categories, breakdown.max, breakdown.used))
        .unwrap_or_default();
    let threshold = breakdown.and_then(|breakdown| breakdown.threshold);
    let compacts = breakdown.and_then(|breakdown| breakdown.compacts);
    let cost = breakdown.and_then(|breakdown| breakdown.cost);
    let estimated = breakdown.is_some_and(|breakdown| breakdown.estimated);
    let mut body = div().p(px(16.)).flex().flex_col().gap(px(24.)).child(
        div().flex().flex_col().gap(px(8.)).child(
            div()
                .flex()
                .items_baseline()
                .gap(px(10.))
                .child(
                    div()
                        .text_size(px(15.))
                        .font_weight(FontWeight::BOLD)
                        .child(match (used, max) {
                            (Some(used), Some(max)) if max > 0 => {
                                format!(
                                    "{} / {} · {}%",
                                    format_count(used),
                                    format_count(max),
                                    used * 100 / max.max(1)
                                )
                            }
                            (Some(used), _) => format!("{} tokens in context", format_count(used)),
                            (None, _) => NO_DATA.to_string(),
                        }),
                )
                .child(mono(if data.live {
                    "live".to_string()
                } else if data
                    .reading
                    .as_ref()
                    .is_some_and(|reading| reading.compacted_since)
                {
                    "last reading · compacted since".to_string()
                } else {
                    "last reading".to_string()
                })),
        ),
    );
    if !shares.is_empty() {
        let bar = shares
            .iter()
            .map(|share| {
                let token = match share.kind {
                    CategoryKind::Free => "rule",
                    CategoryKind::Buffer => "ink-2",
                    CategoryKind::Used => "context-tools",
                };
                (token, share.percent as f32)
            })
            .collect::<Vec<_>>();
        body = body.child(
            div()
                .h(px(10.))
                .rounded(px(5.))
                .overflow_hidden()
                .bg(color("sunk"))
                .flex()
                .children(bar.into_iter().map(|(token, part)| {
                    div()
                        .h_full()
                        .w(relative(part / 100.))
                        .border_r_2()
                        .border_color(color("ground"))
                        .bg(color(token))
                })),
        );
    }
    if let (Some(threshold), Some(_), Some(used)) = (threshold, max, used) {
        body = body.child(mono(if compacts == Some(false) {
            format!(
                "Compaction due at {} · {}",
                format_count(threshold),
                headroom(used, threshold)
            )
        } else {
            format!(
                "Auto-compacts at {} · {}",
                format_count(threshold),
                headroom(used, threshold)
            )
        }));
    }
    if shares.is_empty() {
        body = body.child(div().text_size(px(13.)).text_color(color("ink-2")).child(
            if used.is_none() {
                "No reading yet: one arrives with the thread's first turn.".to_string()
            } else {
                format!(
                    "{} reports the total only, not what fills it.",
                    provider_name.unwrap_or("This provider")
                )
            },
        ));
    } else {
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(ui::caps(if estimated {
                    "Estimated usage by category"
                } else {
                    "Usage by category"
                }))
                .children(shares.iter().map(|share| {
                    let token = match share.kind {
                        CategoryKind::Free => "rule",
                        CategoryKind::Buffer => "ink-2",
                        CategoryKind::Used => "context-tools",
                    };
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .text_size(px(13.))
                        .child(div().size(px(8.)).rounded(px(2.)).bg(color(token)))
                        .child(div().flex_1().child(share.name.to_string()))
                        .child(mono(format!(
                            "{} · {:.1}%",
                            format_count(share.tokens),
                            share.percent
                        )))
                })),
        );
    }
    if let Some(breakdown) = breakdown {
        let tools: Vec<&ToolShare> = breakdown.tools.iter().take(6).collect();
        if !tools.is_empty() {
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(ui::caps("Heaviest tools"))
                    .children(tools.iter().map(|tool| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .text_size(px(13.))
                            .child(div().flex_1().child(tool.name.clone()))
                            .child(mono(format_count(tool.tokens)))
                    })),
            );
        }
    }
    if let Some(cost) = cost {
        body = body.child(mono(format!(
            "Session cost {}",
            if cost > 0. && cost < 0.01 {
                "<$0.01".to_string()
            } else {
                format!("${cost:.2}")
            }
        )));
    }
    body = body.child(plan_usage(limits, provider_name, now));
    body
}

/// Headroom is the useful number: how much more the thread can take before it
/// compacts, not where the line sits in the window.
fn headroom(used: i64, threshold: i64) -> String {
    if used >= threshold {
        return "due now".to_string();
    }
    format!("{} to go", format_count(threshold - used))
}

fn plan_usage(
    limits: Option<&ProviderLimits>,
    provider_name: Option<&str>,
    now: i64,
) -> impl IntoElement {
    let heading = match provider_name {
        Some(name) => format!("Plan usage · {name}"),
        None => "Plan usage".to_string(),
    };
    let section = div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(ui::caps(&heading));
    let Some(limits) = limits else {
        return section.child(
            div()
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child("No subscription usage reported for this provider.".to_string()),
        );
    };
    if limits.windows.is_empty() {
        return section.child(
            div().text_size(px(13.)).text_color(color("ink-2")).child(
                limits
                    .unavailable
                    .clone()
                    .unwrap_or_else(|| NO_DATA.to_string()),
            ),
        );
    }
    let rows: Vec<(String, f64, Option<String>)> = limits
        .windows
        .iter()
        .map(|window| {
            (
                window.label.clone(),
                window.used_percent,
                reset_label(window.resets_at.as_deref(), now),
            )
        })
        .collect();
    let percent_width = rows
        .iter()
        .map(|(_, percent, _)| format!("{}%", percent.round() as i64).len())
        .max()
        .unwrap_or(0);
    section.child(
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .children(rows.into_iter().map(move |(label, percent, reset)| {
                let fraction = (percent / 100.).clamp(0., 1.) as f32;
                let token = if fraction >= 0.9 {
                    "broken"
                } else if fraction >= 0.7 {
                    "held"
                } else {
                    "context-tools"
                };
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .font_family(theme::MONO)
                    .text_size(px(12.))
                    .child(div().w(px(64.)).child(label))
                    .child(
                        div()
                            .flex_1()
                            .h(px(6.))
                            .rounded(px(3.))
                            .bg(color("sunk"))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative(fraction))
                                    .rounded(px(3.))
                                    .bg(color(token)),
                            ),
                    )
                    .child(div().text_color(color("ink")).child(format!(
                        "{:>percent_width$}",
                        format!("{}%", percent.round() as i64)
                    )))
                    .children(reset.map(|reset| div().text_color(color("ink-2")).child(reset)))
            })),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        Category, CategoryKind, Hold, LimitsData, QueueEntry, format_count, format_share, headroom,
        plan_gauges, reset_label, until_label,
    };
    use serde_json::json;

    #[test]
    fn counts_read_like_the_tui() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(663), "663");
        assert_eq!(format_count(663_000), "663k");
        assert_eq!(format_count(999_999), "1m");
        assert_eq!(format_count(1_400_000), "1.4m");
        assert_eq!(format_count(4_600_000_000), "4600m");
    }

    #[test]
    fn shares_round_to_a_tenth_and_name_a_trace() {
        assert_eq!(format_share(0.), "0%");
        assert_eq!(format_share(0.0005), "<0.1%");
        assert_eq!(format_share(0.66), "66%");
        assert_eq!(format_share(0.431), "43.1%");
    }

    #[test]
    fn resets_count_up_and_lapsed_ones_are_no_reset() {
        use crate::live::parse_iso_ms;
        let reset = parse_iso_ms("2026-08-04T10:04:00.000Z").expect("reset");
        assert_eq!(until_label(reset, reset), "now");
        assert_eq!(until_label(reset, reset - 4 * 60_000), "in 4m");
        assert_eq!(until_label(reset, reset - 72 * 60_000), "in 1h 12m");
        assert_eq!(until_label(reset, reset - 26 * 3_600_000), "in 1d 2h");
        assert_eq!(
            reset_label(Some("2026-08-04T10:04:00.000Z"), reset - 4 * 60_000),
            Some("↻ 4m".to_string())
        );
        assert_eq!(reset_label(Some("not a date"), reset), None);
        assert_eq!(reset_label(None, reset), None);
        assert_eq!(reset_label(Some("2026-08-04T10:04:00.000Z"), reset), None);
    }

    #[test]
    fn missing_numbers_decode_as_no_data_not_as_zero() {
        let limits = LimitsData::from_json(&json!({"providers": {}}));
        assert!(limits.for_instance("claude").is_none());
        assert!(plan_gauges(None).is_empty());
        let empty = LimitsData::from_json(
            &json!({"providers": {"claude": {"checkedAt": "x", "windows": [], "unavailable": null}}}),
        );
        assert!(
            empty
                .for_instance("Claude")
                .is_some_and(|limits| limits.windows.is_empty() && limits.unavailable.is_none())
        );
        // The instance's own account wins over its driver's.
        let both = LimitsData::from_json(&json!({"providers": {
            "claude": {"checkedAt": "x", "windows": [], "unavailable": null},
            "opencode/foo": {"checkedAt": "x", "windows": [{"id": "w", "kind": "session", "label": "Session", "usedPercent": 36.0, "resetsAt": null}], "unavailable": null},
            "opencode": {"checkedAt": "x", "windows": [], "unavailable": null},
        }}));
        let foo = both.for_instance("opencode/foo").expect("instance account");
        assert_eq!(foo.windows.len(), 1);
        assert!(
            both.for_instance("opencode/bar")
                .is_some_and(|limits| limits.windows.is_empty())
        );
        assert!(both.for_instance("unknown").is_none());
    }

    #[test]
    fn gauges_keep_the_session_and_weekly_windows_and_biting_others() {
        let limits = LimitsData::from_json(
            &json!({"providers": {"claude": {"checkedAt": "x", "windows": [
            {"id": "s", "kind": "session", "label": "Session", "usedPercent": 36.0, "resetsAt": null},
            {"id": "w", "kind": "weekly", "label": "Weekly", "usedPercent": 43.0, "resetsAt": null},
            {"id": "o", "kind": "weekly", "label": "Weekly – Opus", "usedPercent": 71.0, "resetsAt": null},
            {"id": "q", "kind": "weekly", "label": "Weekly – Quiet", "usedPercent": 10.0, "resetsAt": null},
        ], "unavailable": null}}}),
        );
        let gauges = plan_gauges(limits.for_instance("claude"));
        assert_eq!(
            gauges
                .iter()
                .map(|gauge| (gauge.short.as_str(), gauge.percent as i64))
                .collect::<Vec<_>>(),
            [("5h", 36), ("wk", 43), ("Opus", 71)]
        );
    }

    #[test]
    fn queue_entries_name_their_exit_and_offer_moves() {
        use crate::live::parse_iso_ms;
        let reset = parse_iso_ms("2026-08-04T11:00:00.000Z").expect("reset");
        let now = reset - 60 * 60_000;
        let entry = QueueEntry::from_json(&json!({
            "threadId": "t1", "title": "Backfill", "phase": "waiting",
            "resetsAt": "2026-08-04T11:00:00.000Z", "order": 1, "handoff": false,
        }))
        .expect("entry");
        assert_eq!(
            entry.detail(now),
            "Resets in 1 h · messages wait in this thread's queue"
        );
        assert_eq!(
            entry
                .actions()
                .iter()
                .map(|action| action.wire())
                .collect::<Vec<_>>(),
            ["first", "last", "cancel"]
        );
        let forced = QueueEntry::from_json(&json!({
            "threadId": "t1", "title": "Backfill", "phase": "waiting", "forced": true,
            "resetsAt": null, "order": 1, "handoff": false,
        }))
        .expect("forced");
        assert_eq!(
            forced.detail(now),
            "Manually protected. Send a message to end it."
        );
        assert_eq!(
            forced
                .actions()
                .iter()
                .map(|action| action.wire())
                .collect::<Vec<_>>(),
            ["first", "last"]
        );
        let resumed = QueueEntry::from_json(&json!({
            "threadId": "t1", "title": "Backfill", "phase": "resuming",
            "resetsAt": null, "order": 1, "handoff": false,
        }))
        .expect("resumed");
        assert!(resumed.detail(now).starts_with("The usage window reset"));
        assert!(resumed.actions().is_empty());
    }

    #[test]
    fn holds_and_categories_decode() {
        let hold = Hold::from_json(
            &json!({"protection": {"protected": true, "forced": false, "waitingWakeUps": 2}}),
        )
        .expect("hold");
        assert_eq!(hold.title(), "Thread protected");
        assert!(hold.detail().contains("wake-ups"));
        assert!(Hold::from_json(&json!({})).is_none());
        assert!(Hold::from_json(&json!({"protection": {"protected": false}})).is_none());
        let categories = [Category {
            name: "Tools".to_string(),
            tokens: 1,
            kind: CategoryKind::Used,
        }];
        assert!(!super::context_shares(&categories, Some(0), 0).is_empty());
        assert_eq!(headroom(90, 80), "due now");
        assert_eq!(headroom(70, 80), "10 to go");
    }

    #[test]
    fn snapshot_usage_keeps_the_recorded_total() {
        let usage = super::SnapshotUsage::from_json(
            &json!({"contextUsage": {"usedTokens": 663_000, "maxTokens": 1_000_000}}),
        )
        .expect("usage");
        assert_eq!((usage.used, usage.max), (663_000, Some(1_000_000)));
        assert!(super::SnapshotUsage::from_json(&json!({})).is_none());
    }
}
