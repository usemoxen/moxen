//! The hand-drawn canvas charts: the dashboard's balance chart, the
//! projection's daily line (with an optional dashed scenario line, a zero
//! rule and the selected day) and the analysis' monthly bars with a net
//! line — all in design tokens.

use crate::data::BalancePoint;
use crate::theme::color;
use gpui::{prelude::*, *};

const PAD: f32 = 4.;

/// Maps values onto the canvas in window coordinates (the paint phase does
/// not translate the origin), the first value on the left.
fn project_values(values: &[f64], frame: Bounds<Pixels>) -> Vec<Point<Pixels>> {
    let width: f32 = frame.size.width.into();
    let height: f32 = frame.size.height.into();
    let inner_w = (width - PAD * 2.).max(1.);
    let inner_h = (height - PAD * 2.).max(1.);
    let min = values.iter().copied().fold(f64::INFINITY, f64::min).min(0.);
    let max = values
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max)
        .max(1.);
    let span = (max - min).max(1.) as f32;
    let n = values.len().max(1) as f32;
    values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let x = PAD + inner_w * (i as f32 / (n - 1.).max(1.));
            let y = PAD + inner_h * (1. - (v - min) as f32 / span);
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

pub fn balance_chart(points: &[BalancePoint]) -> Canvas<Vec<Point<Pixels>>> {
    // The canvas closures are 'static, so they own a copy of the points.
    let points = points.to_vec();
    let values: Vec<f64> = points.iter().map(|p| p.balance.minor as f64).collect();
    canvas(
        move |frame, _window, _cx| project_values(&values, frame),
        move |frame, pts, window, _cx| {
            if pts.len() < 2 {
                return;
            }
            let width: f32 = frame.size.width.into();
            let height: f32 = frame.size.height.into();
            // Three hairline grid rules.
            for i in 0..=2 {
                let y = frame.origin.y + px(PAD + (height - PAD * 2.) * (i as f32 / 2.));
                window.paint_quad(fill(
                    gpui::bounds(point(frame.origin.x, y), size(px(width), px(1.))),
                    color("rule"),
                ));
            }
            let bottom = frame.origin.y + px(height - PAD);
            // The area under the line, `live` at a low opacity.
            let mut area = PathBuilder::fill();
            area.move_to(point(pts[0].x, bottom));
            for p in &pts {
                area.line_to(*p);
            }
            area.line_to(point(pts[pts.len() - 1].x, bottom));
            area.close();
            if let Ok(path) = area.build() {
                window.paint_path(path, color("live").opacity(0.12));
            }
            // The line itself.
            let strip = line_strip(&pts, 2.);
            fill_path(&strip, window, color("live"));
            // The last point.
            fill_path(&octagon(*pts.last().unwrap(), 3.5), window, color("live"));
        },
    )
    .w_full()
    .h(px(180.))
}

/// The projection chart: the base line with its area, the zero rule when the
/// balance goes negative, an optional dashed scenario line and the selected
/// day marked. Values are in minor units.
pub fn series_chart(
    values: &[f64],
    scenario: Option<&[f64]>,
    selected: Option<usize>,
    height: f32,
) -> Canvas<Vec<Point<Pixels>>> {
    let values = values.to_vec();
    let scenario = scenario.map(|s| s.to_vec());
    let setup_values = values.clone();
    canvas(
        move |frame, _window, _cx| project_values(&setup_values, frame),
        move |frame, pts, window, _cx| {
            if pts.len() < 2 {
                return;
            }
            let width: f32 = frame.size.width.into();
            let height: f32 = frame.size.height.into();
            // Three hairline grid rules.
            for i in 0..=2 {
                let y = frame.origin.y + px(PAD + (height - PAD * 2.) * (i as f32 / 2.));
                window.paint_quad(fill(
                    gpui::bounds(point(frame.origin.x, y), size(px(width), px(1.))),
                    color("rule"),
                ));
            }
            // The zero rule, in `broken`, when the line crosses it.
            let min = values.iter().copied().fold(f64::INFINITY, f64::min);
            let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let zero_y = |v: f64| -> f32 {
                let span = (max - min).max(1.);
                PAD + (height - PAD * 2.) * (1. - (v - min) as f32 / span as f32)
            };
            if min < 0. {
                let y = frame.origin.y + px(zero_y(0.));
                window.paint_quad(fill(
                    gpui::bounds(point(frame.origin.x, y), size(px(width), px(1.))),
                    color("broken"),
                ));
            }
            // The area between the line and the zero level (or the bottom).
            let base_y = if min < 0. {
                frame.origin.y + px(zero_y(0.))
            } else {
                frame.origin.y + px(height - PAD)
            };
            let mut area = PathBuilder::fill();
            area.move_to(point(pts[0].x, base_y));
            for p in &pts {
                area.line_to(*p);
            }
            area.line_to(point(pts[pts.len() - 1].x, base_y));
            area.close();
            if let Ok(path) = area.build() {
                window.paint_path(path, color("live").opacity(0.12));
            }
            // The base line.
            fill_path(&line_strip(&pts, 2.), window, color("live"));
            // The scenario as a dashed line in `held`.
            if let Some(scenario) = &scenario
                && let Some(spts) = (!scenario.is_empty()).then(|| project_values(scenario, frame))
            {
                for run in 0..spts.len().saturating_sub(1) {
                    // Dash: paint 5 of every 8 segments.
                    if run % 8 >= 5 {
                        continue;
                    }
                    fill_path(
                        &line_strip(&spts[run..=run + 1], 1.6),
                        window,
                        color("held"),
                    );
                }
            }
            // The selected day: a vertical rule and a bigger dot.
            if let Some(i) = selected
                && let Some(p) = pts.get(i)
            {
                window.paint_quad(fill(
                    gpui::bounds(
                        point(p.x - px(0.5), frame.origin.y + px(PAD)),
                        size(px(1.), px(height - PAD * 2.)),
                    ),
                    color("rule"),
                ));
                fill_path(&octagon(*p, 4.5), window, color("live"));
            }
            // The last point.
            fill_path(&octagon(*pts.last().unwrap(), 3.5), window, color("live"));
        },
    )
    .w_full()
    .h(px(height))
}

/// The subscription-cost chart: the actual charges of each month as `live`
/// bars and the normalized monthly equivalent as a `held` line. Values are
/// in minor units.
pub fn cost_chart(actual: &[f64], normalized: &[f64], height: f32) -> Canvas<Vec<f64>> {
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
            let max = actual
                .iter()
                .copied()
                .chain(normalized.iter().copied())
                .fold(1., f64::max)
                .max(1.);
            let y = |v: f64| -> f32 { PAD + (height - PAD * 2.) * (1. - v as f32 / max as f32) };
            let at = |v: f64| frame.origin.y + px(y(v));
            for i in 0..=2 {
                let gy = frame.origin.y + px(PAD + (height - PAD * 2.) * (i as f32 / 2.));
                window.paint_quad(fill(
                    gpui::bounds(point(frame.origin.x, gy), size(px(width), px(1.))),
                    color("rule").opacity(0.6),
                ));
            }
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
pub fn bars_chart(groups: &[BarGroup], height: f32) -> Canvas<Vec<BarGroup>> {
    let groups = groups.to_vec();
    canvas(
        move |_frame, _window, _cx| groups.clone(),
        move |frame, groups, window, _cx| {
            if groups.is_empty() {
                return;
            }
            let width: f32 = frame.size.width.into();
            let height: f32 = frame.size.height.into();
            let min = groups.iter().map(|g| g.net.min(0.)).fold(0., f64::min);
            let max = groups
                .iter()
                .map(|g| g.income.max(g.expense).max(g.net))
                .fold(1., f64::max)
                .max(1.);
            let span = (max - min).max(1.);
            // Offset from the frame's top, in px.
            let y = |v: f64| -> f32 {
                PAD + (height - PAD * 2.) * (1. - (v - min) as f32 / span as f32)
            };
            let at = |v: f64| frame.origin.y + px(y(v));
            // The zero rule when the net goes negative.
            if min < 0. {
                window.paint_quad(fill(
                    gpui::bounds(point(frame.origin.x, at(0.)), size(px(width), px(1.))),
                    color("rule"),
                ));
            }
            // Three hairline grid rules.
            for i in 0..=2 {
                let gy = frame.origin.y + px(PAD + (height - PAD * 2.) * (i as f32 / 2.));
                window.paint_quad(fill(
                    gpui::bounds(point(frame.origin.x, gy), size(px(width), px(1.))),
                    color("rule").opacity(0.6),
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
