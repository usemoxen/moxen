//! GPUI views and the Moxen design tokens for Moxen Finances, shared by the
//! standalone app (`moxen-finances`) and, later, the desktop bundle.
//!
//! The design tokens are read from the desktop's pinned copy
//! (`src/desktop/design-system/tokens.json`) by relative path, so there is
//! one source of truth. Views read all data through the [`data::FinancesData`]
//! trait; [`demo::DemoData`] is the fictional implementation used until the
//! `core`/`store` crates plug in behind it.

pub mod assets;
pub mod data;
pub mod demo;
pub mod format;
pub mod kit;
pub mod language;
pub mod model;
pub mod shell;
mod sidebar;
pub mod theme;
mod title_bar;
pub mod views;
