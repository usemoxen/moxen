//! The dashboard's hand-drawn balance chart: a `canvas` element that paints
//! the area under the balance line, the line itself and its last point, plus
//! hairline grid rules — all in design tokens.

use crate::data::BalancePoint;
use crate::theme::color;
use gpui::{prelude::*, *};

const HEIGHT: f32 = 180.;
const PAD: f32 = 4.;

/// Maps the history onto the canvas in window coordinates (the paint phase
/// does not translate the origin), oldest point on the left.
fn project(points: &[BalancePoint], frame: Bounds<Pixels>) -> Vec<Point<Pixels>> {
    let width: f32 = frame.size.width.into();
    let height: f32 = frame.size.height.into();
    let inner_w = (width - PAD * 2.).max(1.);
    let inner_h = (height - PAD * 2.).max(1.);
    let min = points.iter().map(|p| p.balance.minor).min().unwrap_or(0) as f64;
    let max = points.iter().map(|p| p.balance.minor).max().unwrap_or(1) as f64;
    let span = (max - min).max(1.) as f32;
    let n = points.len().max(1) as f32;
    points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let x = PAD + inner_w * (i as f32 / (n - 1.).max(1.));
            let y = PAD + inner_h * (1. - (p.balance.minor as f64 - min) as f32 / span);
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

pub fn balance_chart(points: &[BalancePoint]) -> Canvas<Vec<Point<Pixels>>> {
    // The canvas closures are 'static, so they own a copy of the points.
    let points = points.to_vec();
    canvas(
        move |frame, _window, _cx| project(&points, frame),
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
            let mut line = PathBuilder::fill();
            line.add_polygon(&strip, true);
            if let Ok(path) = line.build() {
                window.paint_path(path, color("live"));
            }
            // The last point.
            let mut dot = PathBuilder::fill();
            dot.add_polygon(&octagon(*pts.last().unwrap(), 3.5), true);
            if let Ok(path) = dot.build() {
                window.paint_path(path, color("live"));
            }
        },
    )
    .w_full()
    .h(px(HEIGHT))
}
