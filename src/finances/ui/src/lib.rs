//! GPUI views and the Moxen design tokens for Moxen Finances, shared by the
//! standalone app (`moxen-finances`) and, later, the desktop bundle.
//!
//! The design tokens are read from the desktop's pinned copy
//! (`src/desktop/design-system/tokens.json`) by relative path, so there is
//! one source of truth. Views read all data through the [`data::FinancesData`]
//! trait and write through the plain-DTO [`commands::FinancesMutations`] trait;
//! the app plugs `moxen-finances-store` in behind both (its `StoreData`),
//! while [`demo::DemoData`] stays as the fictional source for tests and the
//! render harness (`MOXEN_FINANCES_DEMO=1`). This crate never links SQLite.

pub mod assets;
pub mod commands;
pub mod data;
pub mod demo;
pub mod dialog;
pub mod format;
pub mod kit;
pub mod language;
pub mod model;
pub mod shell;
mod sidebar;
pub mod theme;
pub mod title_bar;
pub mod views;
