//! End-to-end tests of the server as its users: the real `strata-server`
//! binary on a fresh data folder, driven over HTTP by browsers signed in as
//! an admin, a designer, an operator and a viewer (and by API keys).
//!
//! - `matrix`: every write route (and the admin-only reads) against every
//!   role: allowed → 2xx, refused → 403.
//! - `admin`, `designer`, `operator`, `viewer`: what each role does in a
//!   day of work, and that the result shows (a GET after the change).
//! - `sessions`: sign-in, one computer at a time, disabled accounts, rate
//!   limit, cross-site requests, API keys, personal playlists.
//!
//! A check that fails because the server does something it should not is
//! kept, asserting the right behavior, and marked `#[ignore = "BUG: …"]`.

mod common;

#[path = "roles/admin.rs"]
mod admin;
#[path = "roles/designer.rs"]
mod designer;
#[path = "roles/matrix.rs"]
mod matrix;
#[path = "roles/operator.rs"]
mod operator;
#[path = "roles/sessions.rs"]
mod sessions;
#[path = "roles/viewer.rs"]
mod viewer;
