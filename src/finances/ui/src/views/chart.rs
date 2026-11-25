//! The hand-drawn canvas charts: the dashboard's balance chart, the
//! projection's daily line (with an optional dashed scenario line, a zero
//! rule and the selected day) and the analysis' monthly bars with a net
//! line — all in design tokens. Every chart has a [`Axis`] with rounded
//! ticks: its grid rules and its value labels ([`with_axes`]) read the same
//! one, and every series on a chart is drawn on it.

use crate::data::{BalancePoint, Currency, Money};
use crate::format;
use crate::theme::{self, color};
use gpui::{prelude::*, *};

const PAD: f32 = 6.;
/// The width of the value labels' column and its gap to the plot.
const Y_LABELS: f32 = 56.;
/// From 100,000 (in minor units) the value labels use the compact form.
const COMPACT_FROM: f64 = 10_000_000.;
const Y_GAP: f32 = 10.;
/// The scenario's dash and gap, in px along the line.
const DASH: f32 = 6.;
const GAP: f32 = 4.;

/// A value scale that always includes zero, widened to rounded ticks.
#[derive(Clone, Debug, PartialEq)]
pub struct Axis {
    pub min: f64,
    pub max: f64,
    pub step: f64,
}

impl Axis {
    /// The axis for every value drawn on one chart, in minor units.
    pub fn of(values: impl IntoIterator<Item = f64>) -> Self {
        let (lo, hi) = values
            .into_iter()
            .fold((0_f64, 0_f64), |(lo, hi), v| (lo.min(v), hi.max(v)));
        // Never a step under one whole unit of the currency.
        let raw = ((hi - lo) / 4.).max(100.);
        let magnitude = 10_f64.powf(raw.log10().floor());
        let step = magnitude
            * [1., 2., 2.5, 5., 10.]
                .into_iter()
                .find(|nice| nice * magnitude >= raw)
                .unwrap_or(10.);
        let min = (lo / step).floor() * step;
        let max = ((hi / step).ceil() * step).max(min + step);
        Self { min, max, step }
    }

    pub fn ticks(&self) -> Vec<f64> {
        let count = ((self.max - self.min) / self.step).round() as usize;
        (0..=count)
            .map(|i| self.min + self.step * i as f64)
            .collect()
    }

    /// The offset of `value` from the top of a plot `height` px tall.
    pub fn offset(&self, value: f64, height: f32) -> f32 {
        let share = ((value - self.min) / (self.max - self.min)) as f32;
        PAD + (height - PAD * 2.) * (1. - share)
    }
}

fn axis_label(text: String) -> Div {
    div()
        .font_family(theme::MONO)
        .text_size(px(10.5))
        .line_height(px(14.))
        .text_color(color("ink-2"))
        .whitespace_nowrap()
        .child(text)
}

/// A plot with its value labels on the left and `below` (the date or month
/// labels) lined up under the plot itself.
pub fn with_axes(
    plot: impl IntoElement,
    axis: &Axis,
    currency: Currency,
    height: f32,
    below: AnyElement,
) -> Div {
    // One format for every label of an axis: whole amounts, or all compact
    // once they would no longer fit the column.
    let compact = axis.max.abs().max(axis.min.abs()) >= COMPACT_FROM;
    let values = axis.ticks().into_iter().map(|tick| {
        let amount = Money {
            minor: tick as i64,
            currency,
        };
        axis_label(if compact {
            format::compact_money(amount)
        } else {
            format::whole_money(amount)
        })
        .absolute()
        .right(px(0.))
        .top(px(axis.offset(tick, height) - 7.))
    });
    div()
        .flex()
        .flex_row()
        .items_start()
        .gap(px(Y_GAP))
        .child(
            div()
                .relative()
                .w(px(Y_LABELS))
                .h(px(height))
                .flex_shrink_0()
                .children(values),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(plot)
                .child(below),
        )
}

/// Evenly spaced indices of a series, first and last included.
pub fn tick_indices(len: usize, wanted: usize) -> Vec<usize> {
    if len <= wanted || wanted < 2 {
        return (0..len).collect();
    }
    (0..wanted)
        .map(|i| (i * (len - 1) + (wanted - 1) / 2) / (wanted - 1))
        .collect()
}

/// The date labels under a line chart, each centred on its own day (the first
/// and last kept inside the plot).
pub fn date_labels(dates: &[chrono::NaiveDate]) -> AnyElement {
    let span = match (dates.first(), dates.last()) {
        (Some(first), Some(last)) => (*last - *first).num_days(),
        _ => 0,
    };
    let indices = tick_indices(dates.len(), 6);
    let count = indices.len();
    let last_index = dates.len().saturating_sub(1).max(1) as f32;
    div()
        .relative()
        .h(px(14.))
        .mx(px(PAD))
        .children(indices.into_iter().enumerate().map(|(n, i)| {
            let text = if span > 330 {
                format::month_year_short(dates[i])
            } else {
                format::day_month(dates[i])
            };
            let share = i as f32 / last_index;
            let slot = div().absolute().top(px(0.)).w(px(80.)).flex();
            let slot = if n == 0 {
                slot.left(px(0.))
            } else if n + 1 == count {
                slot.right(px(0.)).justify_end()
            } else {
                slot.left(relative(share)).ml(px(-40.)).justify_center()
            };
            slot.child(axis_label(text))
        }))
        .into_any_element()
}

/// Cuts a polyline into dashes `on` px long separated by `off` px, measured
/// along the line so the pattern does not depend on how many points it has.
fn dashes(points: &[(f32, f32)], on: f32, off: f32) -> Vec<Vec<(f32, f32)>> {
    let mut out = Vec::new();
    let mut current: Vec<(f32, f32)> = points.first().copied().into_iter().collect();
    let mut drawing = true;
    let mut left = on;
    for pair in points.windows(2) {
        let (mut from, to) = (pair[0], pair[1]);
        let mut length = (to.0 - from.0).hypot(to.1 - from.1);
        while length > left {
            let share = left / length;
            let cut = (
                from.0 + (to.0 - from.0) * share,
                from.1 + (to.1 - from.1) * share,
            );
            if drawing {
                current.push(cut);
                out.push(std::mem::take(&mut current));
            } else {
                current = vec![cut];
            }
            length -= left;
            from = cut;
            drawing = !drawing;
            left = if drawing { on } else { off };
        }
        left -= length;
        if drawing {
            current.push(to);
        }
    }
    if drawing && current.len() > 1 {
        out.push(current);
    }
    out
}

/// One grid rule per tick of the axis.
fn grid(axis: &Axis, frame: Bounds<Pixels>, window: &mut Window) {
    let height: f32 = frame.size.height.into();
    for tick in axis.ticks() {
        let y = frame.origin.y + px(axis.offset(tick, height));
        window.paint_quad(fill(
            gpui::bounds(point(frame.origin.x, y), size(frame.size.width, px(1.))),
            color("rule").opacity(0.6),
        ));
    }
}

/// Maps values onto the canvas in window coordinates (the paint phase does
/// not translate the origin), the first value on the left.
fn project_values(values: &[f64], axis: &Axis, frame: Bounds<Pixels>) -> Vec<Point<Pixels>> {
    let width: f32 = frame.size.width.into();
    let height: f32 = frame.size.height.into();
    let inner_w = (width - PAD * 2.).max(1.);
    let n = values.len().max(1) as f32;
    values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let x = PAD + inner_w * (i as f32 / (n - 1.).max(1.));
            let y = axis.offset(*v, height);
            point(frame.origin.x + px(x), frame.origin.y + px(y))
        })
        .collect()
}

/// The polyline as a closed strip `width` px thick, so it paints as a fill.
fn line_strip(points: &[Point<Pixels>], width: f32) -> Vec<Point<Pixels>> {
    let half = width / 2.;
    let mut left = Vec::with_capacity(points.len());
    let mut right = Vec::with_capacity(points.len());
    for (i, p) in points.iter().enumerate() {
        let prev = points.get(i.wrapping_sub(1)).unwrap_or(p);
        let next = points.get(i + 1).unwrap_or(p);
        let x: f32 = p.x.into();
        let y: f32 = p.y.into();
        let dx = f32::from(next.x) - f32::from(prev.x);
        let dy = f32::from(next.y) - f32::from(prev.y);
        let len = (dx * dx + dy * dy).sqrt();
        let (nx, ny) = if len > 0. {
            (-dy / len * half, dx / len * half)
        } else {
            (0., half)
        };
        left.push(point(px(x + nx), px(y + ny)));
        right.push(point(px(x - nx), px(y - ny)));
    }
    left.extend(right.into_iter().rev());
    left
}

fn octagon(center: Point<Pixels>, radius: f32) -> Vec<Point<Pixels>> {
    let r = px(radius);
    (0..8)
        .map(|i| {
            let angle = std::f32::consts::TAU * (i as f32 / 8.) + std::f32::consts::FRAC_PI_8;
            point(center.x + r * angle.cos(), center.y + r * angle.sin())
        })
        .collect()
}

fn fill_path(points: &[Point<Pixels>], window: &mut Window, color: Hsla) {
    let mut path = PathBuilder::fill();
    path.add_polygon(points, true);
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

pub fn balance_chart(points: &[BalancePoint], currency: Currency) -> Div {
    let dates: Vec<chrono::NaiveDate> = points.iter().map(|p| p.date).collect();
    let values: Vec<f64> = points.iter().map(|p| p.balance.minor as f64).collect();
    let axis = Axis::of(values.iter().copied());
    let height = 180.;
    with_axes(
        line_plot(values, None, None, axis.clone(), height),
        &axis,
        currency,
        height,
        date_labels(&dates),
    )
}

/// The projection chart: the base line with its area, the zero rule when the
/// balance goes negative, an optional dashed scenario line and the selected
/// day marked, both lines on one axis. Values are in minor units.
pub fn series_chart(
    dates: &[chrono::NaiveDate],
    values: &[f64],
    scenario: Option<&[f64]>,
    selected: Option<usize>,
    currency: Currency,
    height: f32,
) -> Div {
    let axis = Axis::of(values.iter().chain(scenario.unwrap_or_default()).copied());
    with_axes(
        line_plot(
            values.to_vec(),
            scenario.map(<[f64]>::to_vec),
            selected,
            axis.clone(),
            height,
        ),
        &axis,
        currency,
        height,
        date_labels(dates),
    )
}

fn line_plot(
    values: Vec<f64>,
    scenario: Option<Vec<f64>>,
    selected: Option<usize>,
    axis: Axis,
    height: f32,
) -> Canvas<()> {
    // The canvas closures are 'static, so they own their series.
    canvas(
        |_, _, _| {},
        move |frame, (), window, _cx| {
            let pts = project_values(&values, &axis, frame);
            if pts.len() < 2 {
                return;
            }
            grid(&axis, frame, window);
            let zero_y = frame.origin.y + px(axis.offset(0., f32::from(frame.size.height)));
            // The zero rule, in `broken`, when the line crosses it.
            if axis.min < 0. {
                window.paint_quad(fill(
                    gpui::bounds(
                        point(frame.origin.x, zero_y),
                        size(frame.size.width, px(1.)),
                    ),
                    color("broken"),
                ));
            }
            // The area between the line and zero, `live` at a low opacity.
            let mut area = PathBuilder::fill();
            area.move_to(point(pts[0].x, zero_y));
            for p in &pts {
                area.line_to(*p);
            }
            area.line_to(point(pts[pts.len() - 1].x, zero_y));
            area.close();
            if let Ok(path) = area.build() {
                window.paint_path(path, color("live").opacity(0.12));
            }
            // The base line.
            fill_path(&line_strip(&pts, 2.), window, color("live"));
            // The last point.
            fill_path(&octagon(pts[pts.len() - 1], 3.5), window, color("live"));
            // The scenario as a dashed line in `held`, on the same axis.
            if let Some(scenario) = &scenario {
                let line: Vec<(f32, f32)> = project_values(scenario, &axis, frame)
                    .iter()
                    .map(|p| (p.x.into(), p.y.into()))
                    .collect();
                for dash in dashes(&line, DASH, GAP) {
                    let dash: Vec<Point<Pixels>> =
                        dash.into_iter().map(|(x, y)| point(px(x), px(y))).collect();
                    // Segment by segment, so a corner inside a dash stays sharp.
                    for segment in dash.windows(2) {
                        fill_path(&line_strip(segment, 1.8), window, color("held"));
                    }
                }
            }
            // The selected day: a vertical rule and a bigger dot.
            if let Some(i) = selected
                && let Some(p) = pts.get(i)
            {
                window.paint_quad(fill(
                    gpui::bounds(
                        point(p.x - px(0.5), frame.origin.y + px(PAD)),
                        size(px(1.), frame.size.height - px(PAD * 2.)),
                    ),
                    color("edge"),
                ));
                fill_path(&octagon(*p, 4.5), window, color("live"));
            }
        },
    )
    .w_full()
    .h(px(height))
}

/// The subscription-cost chart: the actual charges of each month as `live`
/// bars and the normalized monthly equivalent as a `held` line. Values are
/// in minor units.
pub fn cost_chart(actual: &[f64], normalized: &[f64], axis: Axis, height: f32) -> Canvas<Vec<f64>> {
    let actual = actual.to_vec();
    let normalized = normalized.to_vec();
    canvas(
        move |_frame, _window, _cx| actual.clone(),
        move |frame, actual, window, _cx| {
            if actual.is_empty() {
                return;
            }
            let width: f32 = frame.size.width.into();
            let height: f32 = frame.size.height.into();
            let at = |v: f64| frame.origin.y + px(axis.offset(v, height));
            grid(&axis, frame, window);
            let n = actual.len() as f32;
            let slot = (width - PAD * 2.) / n;
            let bar_w = (slot * 0.4).min(14.);
            for (i, v) in actual.iter().enumerate() {
                let cx = frame.origin.x + px(PAD + slot * (i as f32 + 0.5));
                let h = (at(0.) - at(*v)).max(px(0.5));
                window.paint_quad(fill(
                    gpui::bounds(point(cx - px(bar_w / 2.), at(*v)), size(px(bar_w), h)),
                    color("live").opacity(0.45),
                ));
            }
            if !normalized.is_empty() {
                let pts: Vec<Point<Pixels>> = normalized
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let x = if normalized.len() > 1 {
                            PAD + (width - PAD * 2.) * (i as f32 / (normalized.len() - 1) as f32)
                        } else {
                            width / 2.
                        };
                        point(frame.origin.x + px(x), at(*v))
                    })
                    .collect();
                if pts.len() >= 2 {
                    fill_path(&line_strip(&pts, 1.6), window, color("held"));
                }
            }
        },
    )
    .w_full()
    .h(px(height))
}

/// One month of the analysis bars: income, expense and net, in minor units.
#[derive(Clone, Debug)]
pub struct BarGroup {
    pub income: f64,
    pub expense: f64,
    pub net: f64,
}

/// The analysis chart: two bars per group (income in `added`, expense in
/// `broken`) and the net as a `live` line. Values are in minor units.
pub fn bars_axis(groups: &[BarGroup]) -> Axis {
    Axis::of(groups.iter().flat_map(|g| [g.income, g.expense, g.net]))
}

pub fn bars_chart(groups: &[BarGroup], axis: Axis, height: f32) -> Canvas<Vec<BarGroup>> {
    let groups = groups.to_vec();
    canvas(
        move |_frame, _window, _cx| groups.clone(),
        move |frame, groups, window, _cx| {
            if groups.is_empty() {
                return;
            }
            let width: f32 = frame.size.width.into();
            let height: f32 = frame.size.height.into();
            let at = |v: f64| frame.origin.y + px(axis.offset(v, height));
            grid(&axis, frame, window);
            // The zero rule when the net goes negative.
            if axis.min < 0. {
                window.paint_quad(fill(
                    gpui::bounds(point(frame.origin.x, at(0.)), size(px(width), px(1.))),
                    color("edge"),
                ));
            }
            let n = groups.len() as f32;
            let slot = (width - PAD * 2.) / n;
            let bar_w = (slot * 0.32).min(9.);
            for (i, g) in groups.iter().enumerate() {
                let cx = frame.origin.x + px(PAD + slot * (i as f32 + 0.5));
                for (offset, value, token, opacity) in [
                    (-(bar_w + 2.) / 2., g.income, "added", 0.75),
                    ((bar_w + 2.) / 2., g.expense, "broken", 0.7),
                ] {
                    let top = at(value);
                    let zero = at(0.);
                    let (top, h) = if top <= zero {
                        (top, zero - top)
                    } else {
                        (zero, top - zero)
                    };
                    let h = h.max(px(0.5));
                    window.paint_quad(fill(
                        gpui::bounds(
                            point(cx + px(offset) - px(bar_w / 2.), top),
                            size(px(bar_w), h),
                        ),
                        color(token).opacity(opacity),
                    ));
                }
            }
            // The net line.
            let pts: Vec<Point<Pixels>> = groups
                .iter()
                .enumerate()
                .map(|(i, g)| {
                    point(
                        frame.origin.x + px(PAD + slot * (i as f32 + 0.5)),
                        at(g.net),
                    )
                })
                .collect();
            if pts.len() >= 2 {
                fill_path(&line_strip(&pts, 1.6), window, color("live"));
            }
        },
    )
    .w_full()
    .h(px(height))
}

#[cfg(test)]
mod tests {
    use super::{Axis, dashes, tick_indices};

    #[test]
    fn both_series_of_a_chart_share_one_axis() {
        // The projection and its scenario: the lower one must widen the axis
        // of both, never be rescaled on its own.
        let base = [421_357., 846_307.];
        let scenario = [-35_000., 811_307.];
        let axis = Axis::of(base.into_iter().chain(scenario));
        assert!(axis.min <= -35_000. && axis.max >= 846_307.);
        assert!(axis.offset(421_357., 280.) < axis.offset(386_357., 280.));
    }

    #[test]
    fn ticks_are_rounded_and_include_zero() {
        let axis = Axis::of([421_357., 846_307.]);
        assert_eq!(axis.ticks(), [0., 250_000., 500_000., 750_000., 1_000_000.]);
        assert!(Axis::of([-1_000., 3_000.]).ticks().contains(&0.));
        let empty = Axis::of([]);
        assert!(empty.max > empty.min);
    }

    #[test]
    fn dashes_are_measured_along_the_line_not_per_point() {
        let sparse = [(0., 0.), (25., 0.)];
        let dense: Vec<(f32, f32)> = (0..=25).map(|x| (x as f32, 0.)).collect();
        let ends = |line: &[(f32, f32)]| -> Vec<(f32, f32)> {
            dashes(line, 6., 4.)
                .iter()
                .map(|d| (d[0].0.round(), d[d.len() - 1].0.round()))
                .collect()
        };
        assert_eq!(ends(&sparse), [(0., 6.), (10., 16.), (20., 25.)]);
        assert_eq!(ends(&dense), ends(&sparse));
    }

    #[test]
    fn date_ticks_keep_the_first_and_last_day() {
        assert_eq!(tick_indices(91, 6), [0, 18, 36, 54, 72, 90]);
        assert_eq!(tick_indices(3, 6), [0, 1, 2]);
    }
}
