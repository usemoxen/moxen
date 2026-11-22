//! The stats screen: usage across every thread and provider, read from the
//! server (`usage.stats`), with the shareable PNG card (`usage.card`).
//!
//! The numbers and their wording follow the TUI's stats screen
//! (`src/tui/features/stats/statsmodal.tsx`, `model/stats.ts`) and its shared
//! presentation rules (`src/core/usage/present.ts`): short counts, the cost in
//! words, each model's share, the activity heatmap grid, and the stacked daily
//! bars whose parts add up to their column exactly.

use crate::{
    theme::{self, color},
    ui::{self, Control},
    usage::{format_share, number},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

/// The ranges the stats screen offers, oldest first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum StatsRange {
    #[default]
    All,
    Month30,
    Day7,
}

impl StatsRange {
    /// The value the server's `usage.stats` and `usage.card` read.
    pub fn wire(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Month30 => "30d",
            Self::Day7 => "7d",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Month30 => "30d",
            Self::Day7 => "7d",
        }
    }

    pub fn all() -> [Self; 3] {
        [Self::All, Self::Month30, Self::Day7]
    }
}

/// `1234` → `"1.2k"`, `4_600_000_000` → `"4.6B"`: three significant figures at
/// most, never a trailing `.0` (`formatCount` in `core/usage/present.ts`).
pub fn format_count(value: i64) -> String {
    let units: [(f64, &str); 3] = [(1e9, "B"), (1e6, "M"), (1e3, "k")];
    for (size, suffix) in units {
        if value as f64 >= size {
            let scaled = value as f64 / size;
            let text = if scaled >= 100. {
                format!("{}", scaled.round() as i64)
            } else {
                let one = format!("{scaled:.1}");
                one.strip_suffix(".0").unwrap_or(&one).to_string()
            };
            // 999.9k rounds to 1000k: that is 1M.
            if text == "1000" && size < 1e9 {
                return if suffix == "k" {
                    "1M".to_string()
                } else {
                    "1B".to_string()
                };
            }
            return format!("{text}{suffix}");
        }
    }
    value.to_string()
}

/// A reported cost as dollars; null (nobody reported one) is the caller's
/// word, not `$0.00` (`formatCost` in `present.ts`).
pub fn format_cost(cost_usd: f64) -> String {
    if cost_usd > 0. && cost_usd < 0.01 {
        "<$0.01".to_string()
    } else {
        format!("${cost_usd:.2}")
    }
}

/// 24-hour, so no locale decides how it reads (`formatHour` in `present.ts`).
pub fn format_hour(hour: u32) -> String {
    format!("{hour:02}:00")
}

fn float(value: &Value, path: &[&str]) -> Option<f64> {
    let mut at = value;
    for key in path {
        at = at.get(key)?;
    }
    at.as_f64()
        .or_else(|| number(value, path).map(|n| n as f64))
}

/// One row of tokens by model or provider (`StatsBucket` in
/// `core/usage/stats.ts`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Bucket {
    pub key: String,
    pub input: i64,
    pub cache: i64,
    pub output: i64,
    pub turns: i64,
    pub tokens: i64,
    pub share: f64,
    pub sessions: i64,
    pub cost_usd: Option<f64>,
    pub unpriced_turns: i64,
}

impl Bucket {
    fn from_json(value: &Value) -> Option<Self> {
        let usage = value.get("usage")?;
        Some(Self {
            key: crate::live::text(value, &["key"])?.to_string(),
            input: number(usage, &["input"]).unwrap_or(0),
            cache: number(usage, &["cacheRead"]).unwrap_or(0)
                + number(usage, &["cacheCreate"]).unwrap_or(0),
            output: number(usage, &["output"]).unwrap_or(0)
                + number(usage, &["thinking"]).unwrap_or(0),
            turns: number(usage, &["turns"]).unwrap_or(0),
            tokens: number(value, &["tokens"]).unwrap_or(0),
            share: float(value, &["share"]).unwrap_or(0.),
            sessions: number(value, &["sessions"]).unwrap_or(0),
            cost_usd: value.get("costUsd").and_then(Value::as_f64),
            unpriced_turns: number(value, &["unpricedTurns"]).unwrap_or(0),
        })
    }

    /// `{cached} cached · {input} in · {output} out`.
    pub fn usage_line(&self) -> String {
        format!(
            "{} cached · {} in · {} out",
            format_count(self.cache),
            format_count(self.input),
            format_count(self.output)
        )
    }

    /// The cost in words: free, the figure (with a plus where some turns
    /// reported none), or that nobody did.
    pub fn cost_text(&self) -> String {
        match self.cost_usd {
            None => "unpriced".to_string(),
            Some(cost) if cost == 0. && self.unpriced_turns == 0 => "free".to_string(),
            Some(cost) if self.unpriced_turns > 0 => format!("{}+", format_cost(cost)),
            Some(cost) => format_cost(cost),
        }
    }

    pub fn model_name(&self, other_count: usize) -> String {
        if self.key == OTHER_KEY {
            if other_count == 1 {
                "1 other model".to_string()
            } else {
                format!("{other_count} other models")
            }
        } else if self.key == "unknown" {
            "unknown model".to_string()
        } else {
            self.key.clone()
        }
    }
}

/// Key of the row that gathers every model past the ones listed on their own.
pub const OTHER_KEY: &str = "*other";

/// One active day: its tokens, by model and provider.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayStats {
    pub day: String,
    pub tokens: i64,
    pub by_model: BTreeMap<String, i64>,
    pub by_provider: BTreeMap<String, i64>,
}

impl DayStats {
    fn from_json(value: &Value) -> Option<Self> {
        let table = |key| {
            value
                .get(key)
                .and_then(Value::as_object)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|(name, tokens)| {
                            let tokens = tokens
                                .as_i64()
                                .or_else(|| tokens.as_f64().map(|n| n as i64))?;
                            Some((name.clone(), tokens))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        Some(Self {
            day: crate::live::text(value, &["day"])?.to_string(),
            tokens: number(value, &["tokens"]).unwrap_or(0),
            by_model: table("byModel"),
            by_provider: table("byProvider"),
        })
    }
}

/// What a `usage.stats` answer holds (`UsageStats` in `core/usage/stats.ts`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatsData {
    pub range: StatsRange,
    pub sessions: i64,
    pub messages: i64,
    pub turns: i64,
    pub total_tokens: i64,
    pub cost_usd: Option<f64>,
    pub unpriced_turns: i64,
    pub active_days: i64,
    pub best_streak: i64,
    pub peak_hour: Option<u32>,
    pub favorite_model: Option<String>,
    pub by_provider: Vec<Bucket>,
    pub by_model: Vec<Bucket>,
    pub daily: Vec<DayStats>,
}

impl StatsData {
    pub(crate) fn from_json(range: StatsRange, value: &Value) -> Option<Self> {
        let buckets = |key| {
            value
                .get(key)
                .and_then(Value::as_array)
                .map(|buckets| buckets.iter().filter_map(Bucket::from_json).collect())
                .unwrap_or_default()
        };
        Some(Self {
            range,
            sessions: number(value, &["sessions"]).unwrap_or(0),
            messages: number(value, &["messages"]).unwrap_or(0),
            turns: number(value, &["turns"]).unwrap_or(0),
            total_tokens: number(value, &["totalTokens"]).unwrap_or(0),
            cost_usd: value.get("costUsd").and_then(Value::as_f64),
            unpriced_turns: number(value, &["unpricedTurns"]).unwrap_or(0),
            active_days: number(value, &["activeDays"]).unwrap_or(0),
            best_streak: number(value, &["bestStreak"]).unwrap_or(0),
            peak_hour: value
                .get("peakHour")
                .and_then(Value::as_u64)
                .map(|hour| hour as u32),
            favorite_model: crate::live::text(value, &["favoriteModel"]).map(str::to_string),
            by_provider: buckets("byProvider"),
            by_model: buckets("byModel"),
            daily: value
                .get("daily")
                .and_then(Value::as_array)
                .map(|daily| daily.iter().filter_map(DayStats::from_json).collect())
                .unwrap_or_default(),
        })
    }
}

/// What a stats read holds: the numbers once they answer, or why they have
/// not. No data and no error means no read has answered yet.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatsState {
    pub data: Option<StatsData>,
    pub error: Option<String>,
}

/// The shareable PNG card, saved where the person can find it: the path once
/// written, or why it could not be read. The bytes travel in the answer and
/// are written out by the read, so the client saves the card the server drew
/// without another round trip.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CardState {
    pub path: Option<String>,
    pub error: Option<String>,
    pub busy: bool,
}

/// A `YYYY-MM-DD` day `days` after `day`.
pub fn add_days(day: &str, days: i64) -> Option<String> {
    use chrono::TimeDelta;
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    Some(
        date.checked_add_signed(TimeDelta::days(days))?
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// Today as `YYYY-MM-DD`, in the local time zone.
pub fn today_key(now_ms: i64) -> String {
    use chrono::{DateTime, Local};
    DateTime::from_timestamp_millis(now_ms)
        .map(|utc| utc.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Days since the Monday of the week holding `day`: Monday 0 … Sunday 6.
fn monday_offset(day: &str) -> Option<i64> {
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    use chrono::Datelike;
    Some(date.weekday().num_days_from_monday() as i64)
}

/// First day of a range as `YYYY-MM-DD`, today included in its count; none
/// for all time (`rangeStartDay` in `present.ts`).
pub fn range_start_day(range: StatsRange, today: &str) -> Option<String> {
    match range {
        StatsRange::All => None,
        StatsRange::Month30 => add_days(today, -(30 - 1)),
        StatsRange::Day7 => add_days(today, -(7 - 1)),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeatCell {
    pub day: String,
    /// 0 nothing that day … 4 the busiest of the range; 1 also covers a day of
    /// work whose tokens nobody reported. A day with activity outside the
    /// range is drawn grey (`muted`).
    pub level: u8,
    pub muted: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Heatmap {
    /// `rows[weekday][week]`, Monday first, none past today.
    pub rows: Vec<Vec<Option<HeatCell>>>,
    /// The month name's column: the first week starting a new month.
    pub month_starts: Vec<(usize, u32)>,
}

/// The last `weeks` weeks ending with the one holding today, a column a week
/// and a row a weekday (`heatmap` in `present.ts`). Days inside the range are
/// graded in quarters of the range's busiest day; active days before it turn
/// grey.
pub fn heatmap(daily: &[DayStats], today: &str, weeks: usize, range: StatsRange) -> Heatmap {
    let monday = monday_offset(today).unwrap_or(0);
    let Some(first) = add_days(today, -(monday + (weeks as i64 - 1) * 7)) else {
        return Heatmap::default();
    };
    let start = range_start_day(range, today);
    let by_day: HashMap<&str, i64> = daily
        .iter()
        .map(|entry| (entry.day.as_str(), entry.tokens))
        .collect();
    let busiest = by_day
        .iter()
        .filter(|(day, _)| {
            let day: &str = day;
            start.as_deref().is_none_or(|start| day >= start)
                && day >= first.as_str()
                && day <= today
        })
        .map(|(_, tokens)| *tokens)
        .max()
        .unwrap_or(0);
    let level = |tokens: Option<i64>| match tokens {
        None => 0,
        Some(tokens) if busiest <= 0 || tokens <= 0 => 1,
        Some(tokens) => {
            let share = tokens as f64 / busiest as f64;
            if share > 0.75 {
                4
            } else if share > 0.5 {
                3
            } else if share > 0.25 {
                2
            } else {
                1
            }
        }
    };
    let mut rows: Vec<Vec<Option<HeatCell>>> = vec![vec![]; 7];
    let mut month_starts = vec![];
    let mut last_month: Option<u32> = None;
    for week in 0..weeks {
        for (weekday, row) in rows.iter_mut().enumerate() {
            let date = add_days(&first, (week * 7 + weekday) as i64).unwrap_or_default();
            if date.as_str() > today {
                row.push(None);
                continue;
            }
            let tokens = by_day.get(date.as_str()).copied();
            let active = tokens.is_some();
            row.push(Some(HeatCell {
                day: date.clone(),
                level: level(tokens),
                muted: active && start.as_deref().is_some_and(|start| date.as_str() < start),
            }));
        }
        let monday_date = add_days(&first, (week * 7) as i64).unwrap_or_default();
        let month: u32 = monday_date
            .get(5..7)
            .and_then(|month| month.parse().ok())
            .unwrap_or(0);
        if Some(month) != last_month {
            month_starts.push((week, month));
            last_month = Some(month);
        }
    }
    Heatmap { rows, month_starts }
}

/// One column of the daily chart: its tokens and each model's part of them.
pub struct ChartColumn {
    pub tokens: i64,
    pub by_model: Vec<(String, i64)>,
}

/// Daily tokens as `columns` columns ending today, each `per_column` days
/// wide, scaled to `height` rows (`stackedBars` in `model/stats.ts`). Parts
/// are largest-remainder, so they add up to the column exactly.
pub fn stacked_bars(
    daily: &[DayStats],
    today: &str,
    columns: usize,
    height: usize,
    per_column: i64,
) -> Vec<Vec<(String, usize)>> {
    let by_day: HashMap<&str, &DayStats> = daily
        .iter()
        .map(|entry| (entry.day.as_str(), entry))
        .collect();
    let merged: Vec<ChartColumn> = (0..columns)
        .map(|column| {
            let mut models: BTreeMap<String, i64> = BTreeMap::new();
            let mut tokens = 0;
            for step in 0..per_column {
                let offset = (columns - 1 - column) as i64 * per_column + step;
                let Some(day) = add_days(today, -offset) else {
                    continue;
                };
                let Some(entry) = by_day.get(day.as_str()) else {
                    continue;
                };
                tokens += entry.tokens;
                for (model, spent) in &entry.by_model {
                    *models.entry(model.clone()).or_default() += spent;
                }
            }
            ChartColumn {
                tokens,
                by_model: models.into_iter().collect(),
            }
        })
        .collect();
    let busiest = merged.iter().map(|column| column.tokens).max().unwrap_or(0);
    merged
        .into_iter()
        .map(|column| {
            if column.tokens <= 0 || busiest <= 0 {
                return vec![];
            }
            let total = ((column.tokens as f64 / busiest as f64) * height as f64)
                .round()
                .max(1.) as usize;
            let sum: i64 = column.by_model.iter().map(|(_, spent)| spent).sum();
            if sum <= 0 {
                return vec![];
            }
            // Largest remainder, so the parts add up to the column exactly.
            // Display order is the heaviest first; ties read alphabetically.
            let mut parts: Vec<(String, i64, usize, f64)> = column
                .by_model
                .iter()
                .filter(|(_, spent)| *spent > 0)
                .map(|(key, spent)| {
                    let exact = *spent as f64 / sum as f64 * total as f64;
                    let rows = exact.floor() as usize;
                    (key.clone(), *spent, rows, exact - rows as f64)
                })
                .collect();
            parts.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
            let mut left =
                total.saturating_sub(parts.iter().map(|(_, _, rows, _)| rows).sum::<usize>());
            let mut order: Vec<usize> = (0..parts.len()).collect();
            order.sort_by(|&a, &b| {
                parts[b]
                    .3
                    .partial_cmp(&parts[a].3)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            for at in order {
                if left == 0 {
                    break;
                }
                parts[at].2 += 1;
                left -= 1;
            }
            parts
                .into_iter()
                .filter(|(_, _, rows, _)| *rows > 0)
                .map(|(key, _, rows, _)| (key, rows))
                .collect()
        })
        .collect()
}

/// What the tallest column holds, for the axis label.
pub fn tallest_column(daily: &[DayStats], today: &str, columns: usize, per_column: i64) -> i64 {
    let by_day: HashMap<&str, i64> = daily
        .iter()
        .map(|entry| (entry.day.as_str(), entry.tokens))
        .collect();
    (0..columns)
        .map(|column| {
            (0..per_column)
                .filter_map(|step| {
                    let offset = (columns - 1 - column) as i64 * per_column + step;
                    add_days(today, -offset).and_then(|day| by_day.get(day.as_str()).copied())
                })
                .sum()
        })
        .max()
        .unwrap_or(0)
}

/// The models worth a row: those that spent tokens, the `keep` biggest on
/// their own and the rest gathered into one `OTHER_KEY` bucket (`topModels`
/// in `model/stats.ts`).
pub fn top_models(by_model: &[Bucket], keep: usize) -> (Vec<Bucket>, usize) {
    let mut spent: Vec<&Bucket> = by_model.iter().filter(|bucket| bucket.tokens > 0).collect();
    if spent.len() <= keep {
        return (spent.into_iter().cloned().collect(), 0);
    }
    spent.sort_by(|left, right| {
        right
            .tokens
            .cmp(&left.tokens)
            .then(left.key.cmp(&right.key))
    });
    let rest = &spent[keep..];
    let sum = |pick: fn(&Bucket) -> i64| rest.iter().map(|bucket| pick(bucket)).sum();
    let priced: Vec<&&Bucket> = rest
        .iter()
        .filter(|bucket| bucket.cost_usd.is_some())
        .collect();
    let other = Bucket {
        key: OTHER_KEY.to_string(),
        input: sum(|bucket| bucket.input),
        cache: sum(|bucket| bucket.cache),
        output: sum(|bucket| bucket.output),
        turns: sum(|bucket| bucket.turns),
        tokens: sum(|bucket| bucket.tokens),
        share: rest.iter().map(|bucket| bucket.share).sum(),
        sessions: sum(|bucket| bucket.sessions),
        cost_usd: if priced.is_empty() {
            None
        } else {
            Some(
                priced
                    .iter()
                    .map(|bucket| bucket.cost_usd.unwrap_or(0.))
                    .sum(),
            )
        },
        unpriced_turns: sum(|bucket| bucket.unpriced_turns),
    };
    let mut buckets: Vec<Bucket> = spent[..keep]
        .iter()
        .map(|bucket| (*bucket).clone())
        .collect();
    buckets.push(other);
    (buckets, rest.len())
}

const TAB_LABELS: [(&str, StatsTab); 2] = [
    ("Overview", StatsTab::Overview),
    ("Models", StatsTab::Models),
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StatsTab {
    #[default]
    Overview,
    Models,
}

/// One colour per model, in the order the legend lists them.
fn model_color(at: usize) -> &'static str {
    const COLORS: [&str; 8] = [
        "label-1", "label-2", "label-3", "label-4", "label-5", "label-6", "label-7", "label-8",
    ];
    COLORS[at % COLORS.len()]
}

fn tile(label: String, value: String, width: f32) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .w(px(width))
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(11.))
                .text_color(color("ink-2"))
                .child(label),
        )
        .child(
            div()
                .text_size(px(15.))
                .text_color(color("ink"))
                .child(value),
        )
}

fn stat_row(cells: Vec<(String, String)>, width: f32) -> impl IntoElement {
    // The tiles share `width` minus the gaps between them, so the row spans
    // the modal's content instead of running under its border.
    let column = (width - 16. * (cells.len().max(1) - 1) as f32) / cells.len().max(1) as f32;
    div().flex().gap(px(16.)).children(
        cells
            .into_iter()
            .map(|(label, value)| tile(label, value, column)),
    )
}

/// The stats overlay: tabs, ranges, the numbers, and the card export.
/// Reads ride the source (`read_stats`, `read_card`); Escape closes it, as it
/// closes every other panel before a turn is interrupted.
pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let range = w.stats_range;
    let tab = w.stats_tab;
    let state = w.source.stats(range);
    div()
        .absolute()
        .top(px(72.))
        .left(px(300.))
        .w(px(560.))
        .max_h(px(640.))
        .p(px(16.))
        .rounded(px(10.))
        .bg(color("raised"))
        .border_1()
        .border_color(color("rule"))
        .shadow(crate::theme::float_shadow())
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .gap(px(16.))
                        .text_size(px(13.))
                        .children(TAB_LABELS.into_iter().enumerate().map(
                            |(at, (label, value))| {
                                let on = tab == value;
                                div()
                                    .id(("stats-tab", at))
                                    .px(px(6.))
                                    .py(px(2.))
                                    .rounded(px(4.))
                                    .text_color(color(if on { "ink" } else { "ink-2" }))
                                    .when(on, |s| s.bg(color("sunk")))
                                    .child(label)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.stats_tab = value;
                                        cx.notify();
                                    }))
                            },
                        )),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(2.))
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .children(
                            StatsRange::all()
                                .into_iter()
                                .enumerate()
                                .map(|(at, value)| {
                                    let on = range == value;
                                    div()
                                        .id(("stats-range", at))
                                        .px(px(6.))
                                        .py(px(2.))
                                        .rounded(px(4.))
                                        .text_color(color(if on { "ink" } else { "ink-2" }))
                                        .when(on, |s| s.bg(color("sunk")))
                                        .child(value.label())
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.stats_range = value;
                                            this.source.read_stats(value);
                                            cx.notify();
                                        }))
                                }),
                        ),
                )
                .child(
                    div()
                        .id("stats-close")
                        .control("Close")
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(4.))
                        .text_color(color("ink-2"))
                        .child("esc")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.stats_open = false;
                            cx.notify();
                        })),
                ),
        )
        .child(match state.as_deref() {
            None => div()
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child("Reading usage…".to_string())
                .into_any_element(),
            Some(state) if state.data.is_none() => div()
                .text_size(px(13.))
                .text_color(color(if state.error.is_some() {
                    "broken"
                } else {
                    "ink-2"
                }))
                .child(
                    state
                        .error
                        .clone()
                        .map(|message| format!("Couldn't read usage: {message}"))
                        .unwrap_or_else(|| "Reading usage…".to_string()),
                )
                .into_any_element(),
            Some(state) => {
                let data = state.data.clone().expect("stats data");
                if data.turns == 0 {
                    div()
                        .text_size(px(13.))
                        .text_color(color("ink-2"))
                        .child("No usage yet.".to_string())
                        .into_any_element()
                } else if tab == StatsTab::Overview {
                    overview(w, &data).into_any_element()
                } else {
                    models(&data).into_any_element()
                }
            }
        })
        .child(card_row(w, cx))
}

fn overview(w: &Workspace, data: &StatsData) -> impl IntoElement {
    let today = today_key(crate::live::now_ms());
    let cost = match data.cost_usd {
        None => "unpriced".to_string(),
        Some(cost) if cost == 0. && data.unpriced_turns == 0 => "free".to_string(),
        Some(cost) if data.unpriced_turns > 0 => format!("{}+", format_cost(cost)),
        Some(cost) => format_cost(cost),
    };
    let days = if data.best_streak == 1 {
        "1 day".to_string()
    } else {
        format!("{} days", data.best_streak)
    };
    div()
        .id("stats-overview")
        .flex()
        .flex_col()
        .gap(px(12.))
        .overflow_y_scroll()
        .child(stat_row(
            vec![
                ("Sessions".to_string(), data.sessions.to_string()),
                ("Messages".to_string(), data.messages.to_string()),
                ("Total tokens".to_string(), format_count(data.total_tokens)),
            ],
            528.,
        ))
        .child(stat_row(
            vec![
                ("Active days".to_string(), data.active_days.to_string()),
                (
                    "Peak hour".to_string(),
                    data.peak_hour
                        .map(format_hour)
                        .unwrap_or_else(|| "—".to_string()),
                ),
                (
                    "Favorite model".to_string(),
                    data.favorite_model.as_deref().map_or_else(
                        || "—".to_string(),
                        |slug| {
                            w.catalog().map_or_else(
                                || crate::catalog::prettify(slug),
                                |catalog| catalog.display_name(slug),
                            )
                        },
                    ),
                ),
            ],
            528.,
        ))
        .child(stat_row(
            vec![
                ("Best streak".to_string(), days),
                ("Cost (API eq.)".to_string(), cost),
                ("Turns".to_string(), data.turns.to_string()),
            ],
            528.,
        ))
        .child(heatmap_view(data, &today))
}

/// "2026-08-04" → "Aug 4", for the chart's axis.
fn short_date(day: &str) -> String {
    let mut parts = day.split('-');
    let month: u32 = parts
        .nth(1)
        .and_then(|month| month.parse().ok())
        .unwrap_or(0);
    let date: u32 = parts.next().and_then(|date| date.parse().ok()).unwrap_or(0);
    if month == 0 || date == 0 {
        return day.to_string();
    }
    format!("{} {date}", month_name(month))
}

fn month_name(month: u32) -> &'static str {
    const NAMES: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    NAMES
        .get(month.saturating_sub(1) as usize)
        .copied()
        .unwrap_or("")
}

/// The activity heatmap: one column a week, Monday first, graded in quarters
/// of the range's busiest day; active days before the range stay grey. Weeks
/// are fixed-width columns and filled cells are drawn squares: the bundled
/// fonts carry no block glyphs, and text-measured cells overflowed the pane
/// and clipped the newest weeks away. A week is exactly two 12px cells at
/// this face's measured 0.632em advance, so the month labels sit over their
/// columns.
fn heatmap_view(data: &StatsData, today: &str) -> impl IntoElement {
    /// One 12px cell at the face's measured advance.
    const CELL: f32 = 12. * 0.632;
    const WEEK: f32 = CELL * 2.;
    const CONTENT: f32 = 528.;
    let weeks = ((CONTENT - WEEK) / WEEK).floor().clamp(4., 53.) as usize;
    let map = heatmap(&data.daily, today, weeks, data.range);
    let header: String = {
        let mut cells = vec![" ".to_string(); 2 + weeks * 2];
        for (week, month) in &map.month_starts {
            let name = month_name(*month);
            let at = 2 + week * 2;
            if at + name.len() <= cells.len()
                && cells[at..at + name.len() + 1]
                    .iter()
                    .all(|cell| cell == " ")
            {
                for (i, char) in name.chars().enumerate() {
                    cells[at + i] = char.to_string();
                }
            }
        }
        cells.join("")
    };
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(header),
        )
        .children(map.rows.iter().enumerate().map(|(weekday, row)| {
            const ROWS: [&str; 7] = ["M", "T", "W", "T", "F", "S", "S"];
            div()
                .flex()
                .items_center()
                .child(
                    div()
                        .w(px(WEEK))
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(ROWS[weekday].to_string()),
                )
                .children(row.iter().map(|cell| {
                    div()
                        .w(px(WEEK))
                        .h(px(16.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(match cell {
                            None => div().into_any_element(),
                            Some(cell) if cell.muted => div()
                                .size(px(10.))
                                .rounded(px(2.))
                                .bg(color("ink-2"))
                                .into_any_element(),
                            Some(cell) if cell.level == 0 => div()
                                .font_family(theme::MONO)
                                .text_size(px(12.))
                                .text_color(color("rule"))
                                .child("·".to_string())
                                .into_any_element(),
                            Some(cell) => div()
                                .size(px(10.))
                                .rounded(px(2.))
                                .bg(color("live"))
                                .opacity(match cell.level {
                                    1 => 0.35,
                                    2 => 0.55,
                                    3 => 0.8,
                                    _ => 1.,
                                })
                                .into_any_element(),
                        })
                }))
        }))
}

/// Whole days from the first active day to now, like the TUI's chart: local
/// midnights, rounded, the day itself included, at least a week
/// (`statsmodal.tsx:182`).
pub(crate) fn all_time_span(first_day: &str, now_ms: i64) -> usize {
    use chrono::{Local, NaiveDate, TimeZone};
    let first_ms = (|| {
        let day = NaiveDate::parse_from_str(first_day, "%Y-%m-%d").ok()?;
        let midnight = day.and_hms_opt(0, 0, 0)?;
        Local
            .from_local_datetime(&midnight)
            .single()
            .map(|dt| dt.timestamp_millis())
    })()
    .or_else(|| crate::live::parse_iso_ms(&format!("{first_day}T00:00:00Z")));
    first_ms
        .map(|first| (((now_ms - first) as f64 / 86_400_000.).round() as i64 + 1).max(7) as usize)
        .unwrap_or(7)
}

fn models(data: &StatsData) -> impl IntoElement {
    let today = today_key(crate::live::now_ms());
    let (buckets, other_count) = top_models(&data.by_model, 7);
    let span = match data.range {
        StatsRange::Day7 => 7,
        StatsRange::Month30 => 30,
        StatsRange::All => data
            .daily
            .first()
            .map(|first| all_time_span(&first.day, crate::live::now_ms()))
            .unwrap_or(7),
    };
    let plot = 48usize;
    let per_column = if span <= plot { 1 } else { span.div_ceil(plot) } as i64;
    let columns = span.div_ceil(per_column as usize);
    // A column a day when they fit, two cells wide when there is room for it.
    let wide = per_column == 1 && columns * 2 <= plot;
    let bars = stacked_bars(&data.daily, &today, columns, 8, per_column);
    let peak = tallest_column(&data.daily, &today, columns, per_column);
    let start_day = add_days(&today, -((columns as i64 * per_column) - 1)).unwrap_or_default();
    let color_of = |key: &str| {
        buckets
            .iter()
            .position(|bucket| bucket.key == key)
            .filter(|&at| buckets[at].key != OTHER_KEY)
            .map(model_color)
            .unwrap_or("ink-2")
    };
    let rows: Vec<Vec<Option<&str>>> = (0..8)
        .rev()
        .map(|row| {
            bars.iter()
                .flat_map(|segments| {
                    let mut floor = 0;
                    let mut color = None;
                    for (key, rows) in segments {
                        if row >= floor && row < floor + rows {
                            color = Some(color_of(key));
                        }
                        floor += rows;
                    }
                    if wide {
                        vec![color, color]
                    } else {
                        vec![color]
                    }
                })
                .collect()
        })
        .collect();
    div()
        .id("stats-models")
        .flex()
        .flex_col()
        .gap(px(12.))
        .overflow_y_scroll()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Tokens per day, by model".to_string()),
                )
                .children((per_column > 1).then(|| {
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .text_color(color("ink-2"))
                        .child(format!("each column is {per_column} days"))
                })),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .children(rows.iter().enumerate().map(|(at, cells)| {
                    let label = if at == 0 && peak > 0 {
                        format_count(peak)
                    } else if at == 7 {
                        "0".to_string()
                    } else {
                        String::new()
                    };
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(
                            div()
                                .w(px(48.))
                                .text_align(gpui::TextAlign::Right)
                                .font_family(theme::MONO)
                                .text_size(px(10.))
                                .text_color(color("ink-2"))
                                .child(label),
                        )
                        .children(cells.iter().map(|cell| {
                            div()
                                .w(px(8.))
                                .font_family(theme::MONO)
                                .text_size(px(10.))
                                .text_color(color(cell.unwrap_or("sunk")))
                                .child(if cell.is_some() { "█" } else { " " }.to_string())
                        }))
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(div().w(px(48.)))
                        .child(
                            div()
                                .font_family(theme::MONO)
                                .text_size(px(10.))
                                .text_color(color("ink-2"))
                                .child(format!("{} today", short_date(&start_day))),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .children(buckets.iter().map(|bucket| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(13.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .flex_1()
                                .child(
                                    div()
                                        .text_color(color(color_of(&bucket.key)))
                                        .child("■".to_string()),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .child(bucket.model_name(other_count)),
                                ),
                        )
                        .child(
                            div()
                                .font_family(theme::MONO)
                                .text_size(px(11.5))
                                .text_color(color("ink-2"))
                                .child(format!(
                                    "{}  {}  {}",
                                    bucket.usage_line(),
                                    bucket.cost_text(),
                                    format_share(bucket.share)
                                )),
                        )
                })),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(ui::caps("By provider"))
                .children(
                    data.by_provider
                        .iter()
                        .filter(|bucket| bucket.tokens > 0)
                        .map(|bucket| {
                            let sessions = if bucket.sessions == 1 {
                                "1 session".to_string()
                            } else {
                                format!("{} sessions", bucket.sessions)
                            };
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .text_size(px(13.))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .child(provider_display_name(&bucket.key).to_string()),
                                )
                                .child(
                                    div()
                                        .font_family(theme::MONO)
                                        .text_size(px(11.5))
                                        .text_color(color("ink-2"))
                                        .child(format!(
                                            "{sessions}  {} tokens  {}  {}",
                                            format_count(bucket.tokens),
                                            bucket.cost_text(),
                                            format_share(bucket.share)
                                        )),
                                )
                        }),
                ),
        )
}

fn provider_display_name(key: &str) -> &str {
    match key {
        "claude" | "claudeAgent" => "Claude Code",
        "codex" => "Codex",
        "chatgpt" => "ChatGPT",
        "antigravity" | "agy" => "Antigravity",
        "opencode" | "opencode/opencode" => "OpenCode",
        "opencode/opencode-go" => "OpenCode Go",
        _ => key,
    }
}

fn card_row(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let range = w.stats_range;
    let card = w.source.card(range);
    let busy = card.as_deref().is_some_and(|card| card.busy);
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .child(
            div()
                .id("stats-card")
                .control("Save the shareable PNG card for this range")
                .px(px(8.))
                .py(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(color("edge"))
                .text_size(px(12.5))
                .text_color(color("ink-2"))
                .child(if busy {
                    "Saving card…".to_string()
                } else {
                    "Save card".to_string()
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.source.read_card(range);
                    cx.notify();
                })),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(theme::MONO)
                .text_size(px(11.5))
                .text_color(color("ink-2"))
                .child(match card.as_deref() {
                    Some(card) if card.path.is_some() => {
                        format!("Saved {}", card.path.clone().unwrap_or_default())
                    }
                    Some(card) if card.error.is_some() => {
                        format!(
                            "Couldn't make the card: {}",
                            card.error.clone().unwrap_or_default()
                        )
                    }
                    _ => String::new(),
                }),
        )
}

#[cfg(test)]
mod tests {
    use super::{
        OTHER_KEY, StatsRange, add_days, format_cost, format_count, format_hour, heatmap,
        range_start_day, stacked_bars, tallest_column, top_models,
    };
    use crate::usage::format_share;
    use serde_json::json;

    fn bucket(
        key: &str,
        tokens: i64,
        cost: Option<f64>,
        unpriced: i64,
        share: f64,
    ) -> super::Bucket {
        super::Bucket {
            key: key.to_string(),
            input: tokens / 2,
            cache: tokens / 4,
            output: tokens / 4,
            turns: 1,
            tokens,
            share,
            sessions: 1,
            cost_usd: cost,
            unpriced_turns: unpriced,
        }
    }

    #[test]
    fn counts_costs_and_hours_read_like_the_shared_rules() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(1234), "1.2k");
        assert_eq!(format_count(663_000), "663k");
        assert_eq!(format_count(999_999), "1M");
        assert_eq!(format_count(4_600_000_000), "4.6B");
        assert_eq!(format_cost(0.), "$0.00");
        assert_eq!(format_cost(0.004), "<$0.01");
        assert_eq!(format_cost(1.234), "$1.23");
        assert_eq!(format_share(0.66), "66%");
        assert_eq!(format_hour(7), "07:00");
        assert_eq!(StatsRange::Month30.wire(), "30d");
        assert_eq!(StatsRange::Day7.label(), "7d");
    }

    #[test]
    fn days_add_and_ranges_start_on_the_first_day_in() {
        assert_eq!(add_days("2026-08-04", 1).as_deref(), Some("2026-08-05"));
        assert_eq!(add_days("2026-08-04", -6).as_deref(), Some("2026-07-29"));
        assert_eq!(range_start_day(StatsRange::All, "2026-08-04"), None);
        assert_eq!(
            range_start_day(StatsRange::Day7, "2026-08-04").as_deref(),
            Some("2026-07-29")
        );
        assert_eq!(
            range_start_day(StatsRange::Month30, "2026-08-04").as_deref(),
            Some("2026-07-06")
        );
    }

    #[test]
    fn active_days_land_filled_in_the_right_column_and_row() {
        // The mock fixture's three active days, on the real grid: the last
        // 31 weeks ending Wednesday 2026-11-18, all time. Nov 12/13/14 are
        // the Thursday–Saturday of the next-to-last week.
        let daily = ["2026-11-12", "2026-11-13", "2026-11-14"]
            .into_iter()
            .map(|day| super::DayStats {
                day: day.to_string(),
                tokens: 100,
                by_model: Default::default(),
                by_provider: Default::default(),
            })
            .collect::<Vec<_>>();
        let map = heatmap(&daily, "2026-11-18", 31, StatsRange::All);
        assert_eq!(map.rows.len(), 7);
        assert!(map.rows.iter().all(|row| row.len() == 31));
        // Monday-first rows: Thursday is row 3, Friday 4, Saturday 5; the
        // next-to-last column is week 29.
        for (weekday, day) in [(3, "2026-11-12"), (4, "2026-11-13"), (5, "2026-11-14")] {
            let cell = map.rows[weekday][29].as_ref().expect("active day");
            assert_eq!(cell.day, day);
            assert!(cell.level > 0, "day with activity is filled");
            assert!(!cell.muted);
        }
        // The Sunday of that week stayed empty, and days past today are blank.
        assert_eq!(map.rows[6][29].as_ref().map(|cell| cell.level), Some(0));
        assert!(map.rows[6][30].is_none());
        assert_eq!(
            map.rows[2][30].as_ref().map(|cell| cell.day.as_str()),
            Some("2026-11-18")
        );
    }

    #[test]
    fn all_time_span_counts_the_first_day() {
        use chrono::{Local, NaiveDate, TimeZone};
        let midnight = |day: &str| {
            let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").expect("day");
            Local
                .from_local_datetime(&date.and_hms_opt(0, 0, 0).expect("midnight"))
                .single()
                .expect("local midnight")
                .timestamp_millis()
        };
        let now = midnight("2026-08-04");
        // Ten days back, plus the first day itself; never less than a week.
        assert_eq!(super::all_time_span("2026-07-25", now), 11);
        assert_eq!(super::all_time_span("2026-08-04", now), 7);
        assert_eq!(super::all_time_span("not a day", now), 7);
    }

    #[test]
    fn heatmap_grades_quarters_of_the_busiest_day_and_greys_the_past() {
        // 2026-08-04 is a Tuesday.
        let daily = ["2026-07-28", "2026-08-03", "2026-08-04"]
            .into_iter()
            .map(|day| super::DayStats {
                day: day.to_string(),
                tokens: if day == "2026-08-04" { 100 } else { 10 },
                by_model: Default::default(),
                by_provider: Default::default(),
            })
            .collect::<Vec<_>>();
        let map = heatmap(&daily, "2026-08-04", 2, StatsRange::Day7);
        // Monday 2026-08-03: 10/100 → level 1. Tuesday 2026-08-04: the busiest → 4.
        assert_eq!(map.rows[0][1].as_ref().map(|cell| cell.level), Some(1));
        assert_eq!(map.rows[1][1].as_ref().map(|cell| cell.level), Some(4));
        // 2026-07-28 is active but before the 7-day range: still drawn, grey.
        let grey = map
            .rows
            .iter()
            .flatten()
            .flatten()
            .find(|cell| cell.day == "2026-07-28")
            .expect("past day");
        assert!(grey.muted);
        // Past today: nothing.
        assert!(map.rows[2][1].is_none());
        assert!(!map.month_starts.is_empty());
    }

    #[test]
    fn models_list_the_biggest_and_gather_the_tail() {
        let spent = (0..9)
            .map(|at| bucket(&format!("model-{at}"), 100 - at * 10, Some(1.), 0, 0.1))
            .collect::<Vec<_>>();
        let (buckets, other) = top_models(&spent, 7);
        assert_eq!(other, 2);
        assert_eq!(buckets.len(), 8);
        assert_eq!(
            buckets.last().map(|bucket| bucket.key.as_str()),
            Some(OTHER_KEY)
        );
        assert_eq!(buckets.last().map(|bucket| bucket.tokens), Some(50));
        let (all, none) = top_models(&spent[..3], 7);
        assert_eq!((all.len(), none), (3, 0));
    }

    #[test]
    fn stacked_parts_add_up_to_their_column() {
        let daily = ["2026-08-03", "2026-08-04"]
            .into_iter()
            .map(|day| super::DayStats {
                day: day.to_string(),
                tokens: 100,
                by_model: [("a".to_string(), 70), ("b".to_string(), 30)]
                    .into_iter()
                    .collect(),
                by_provider: Default::default(),
            })
            .collect::<Vec<_>>();
        let bars = stacked_bars(&daily, "2026-08-04", 2, 8, 1);
        assert_eq!(bars.len(), 2);
        for column in &bars {
            assert_eq!(column.iter().map(|(_, rows)| rows).sum::<usize>(), 8);
        }
        assert_eq!(tallest_column(&daily, "2026-08-04", 2, 1), 100);
    }

    #[test]
    fn stats_decode_off_the_servers_shape() {
        let data = super::StatsData::from_json(
            StatsRange::All,
            &json!({
                "range": "all", "sessions": 2, "messages": 40, "turns": 10, "totalTokens": 663_000,
                "costUsd": 1.5, "unpricedTurns": 1, "activeDays": 3, "bestStreak": 2,
                "peakHour": 9, "favoriteModel": "opus",
                "byProvider": [{"key": "claude", "usage": {"input": 1, "cacheRead": 2, "cacheCreate": 0, "output": 3, "thinking": 0, "turns": 4},
                                "tokens": 6, "share": 0.5, "sessions": 2, "costUsd": 1.5, "unpricedTurns": 1}],
                "byModel": [], "daily": [{"day": "2026-08-04", "tokens": 6, "byModel": {"opus": 6}, "byProvider": {}}],
            }),
        )
        .expect("stats");
        assert_eq!(data.peak_hour, Some(9));
        assert_eq!(data.by_provider[0].usage_line(), "2 cached · 1 in · 3 out");
        assert_eq!(data.by_provider[0].cost_text(), "$1.50+");
        assert_eq!(data.daily[0].by_model["opus"], 6);
    }

    #[test]
    fn cost_words_and_model_names_cover_the_missing_cases() {
        assert_eq!(bucket("m", 10, None, 0, 0.1).cost_text(), "unpriced");
        assert_eq!(bucket("m", 10, Some(0.), 0, 0.1).cost_text(), "free");
        assert_eq!(bucket("m", 10, Some(0.), 1, 0.1).cost_text(), "$0.00+");
        assert_eq!(bucket("m", 10, Some(2.), 0, 0.1).cost_text(), "$2.00");
        assert_eq!(
            bucket("unknown", 10, Some(2.), 0, 0.1).model_name(0),
            "unknown model"
        );
        assert_eq!(
            bucket(OTHER_KEY, 10, Some(2.), 0, 0.1).model_name(1),
            "1 other model"
        );
        assert_eq!(
            bucket(OTHER_KEY, 10, Some(2.), 0, 0.1).model_name(3),
            "3 other models"
        );
    }
}
