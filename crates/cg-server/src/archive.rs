//! A project with its pictures and media in one zip (« full export »):
//! `project.strata.json` and, under `assets/`, every file of the server's
//! assets the project uses (`/assets/…` in any of its texts). The import
//! puts them back; a project given a new id moves its own folder with it.

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const PROJECT_FILE: &str = "project.strata.json";
const ASSETS: &str = "assets/";
/// Largest file read back from an archive.
const MAX_FILE: u64 = 1024 * 1024 * 1024;
/// All the files of an archive together, once uncompressed.
const MAX_TOTAL: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;

/// The asset paths (after `/assets/`) the project's JSON uses, wherever they are
/// (a picture's `src`, a text's inline image, a field's default…).
pub fn asset_paths(json: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = json;
    while let Some(i) = rest.find("/assets/") {
        let tail = &rest[i + "/assets/".len()..];
        let end = tail
            .find(|c: char| {
                c == '"'
                    || c == '\''
                    || c == '\\'
                    || c == ')'
                    || c == '('
                    || c.is_whitespace()
                    || c == '<'
                    || c == '>'
                    || c == '?'
                    || c == '#'
            })
            .unwrap_or(tail.len());
        let p = &tail[..end];
        if safe(p).is_some() {
            out.insert(p.to_string());
        }
        rest = &tail[end..];
    }
    out
}

/// A relative path with no way out of its folder (no `..`, not absolute).
fn safe(p: &str) -> Option<PathBuf> {
    if p.is_empty() || p.contains('\0') {
        return None;
    }
    let path = Path::new(p);
    path.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then(|| path.to_path_buf())
}

/// The zip: the project, then each asset file it uses that exists.
pub fn export(project_json: &[u8], assets: &Path) -> Result<Vec<u8>, String> {
    let e = |x: zip::result::ZipError| x.to_string();
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().large_file(true);
    z.start_file(PROJECT_FILE, opts).map_err(e)?;
    z.write_all(project_json).map_err(|x| x.to_string())?;
    let text = String::from_utf8_lossy(project_json);
    for rel in asset_paths(&text) {
        let Some(p) = safe(&rel) else { continue };
        let file = assets.join(p);
        if !file.is_file() {
            continue;
        }
        let bytes = std::fs::read(&file).map_err(|x| x.to_string())?;
        z.start_file(format!("{ASSETS}{rel}"), opts).map_err(e)?;
        z.write_all(&bytes).map_err(|x| x.to_string())?;
    }
    Ok(z.finish().map_err(e)?.into_inner())
}

/// What an archive holds: the project's JSON, and its files (paths under the assets folder).
pub struct Unpacked {
    pub project: String,
    pub files: Vec<(PathBuf, Vec<u8>)>,
}

pub fn unpack(bytes: &[u8]) -> Result<Unpacked, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("invalid archive: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err("too many files in this archive".into());
    }
    let mut project = None;
    let mut files = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().map_err(|e| e.to_string())?.into_owned();
        let mut out = Vec::new();
        (&mut f)
            .take(MAX_FILE.min(MAX_TOTAL - total))
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        total += out.len() as u64;
        if total >= MAX_TOTAL {
            return Err("this archive is too large once uncompressed".into());
        }
        if name == PROJECT_FILE
            || (project.is_none() && name.ends_with(".strata.json") && !name.contains('/'))
        {
            project = Some(
                String::from_utf8(out).map_err(|_| "the project is not UTF-8 text".to_string())?,
            );
        } else if let Some(rel) = name.strip_prefix(ASSETS).and_then(safe) {
            files.push((rel, out));
        }
    }
    Ok(Unpacked {
        project: project.ok_or("no project in this archive")?,
        files,
    })
}

/// Puts the archive's files in the assets folder: the project's own folder
/// (`projects/<id>/`, moved to `new_id`) is written; any other file only when
/// it is not there yet (a shared picture already on this server is kept).
pub fn restore(
    files: &[(PathBuf, Vec<u8>)],
    assets: &Path,
    old_id: &str,
    new_id: &str,
) -> Result<usize, String> {
    let own = Path::new("projects").join(old_id);
    let mut n = 0;
    for (rel, bytes) in files {
        let (dest, overwrite) = match rel.strip_prefix(&own) {
            Ok(r) => (assets.join("projects").join(new_id).join(r), true),
            Err(_) => (assets.join(rel), false),
        };
        if !overwrite && dest.exists() {
            continue;
        }
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_assets_a_project_uses() {
        let json = r#"{"src":"/assets/projects/ab/logo.png","text":"<img src=\"/assets/lib/x.svg\"> and (/assets/a b.png)","bad":"/assets/../etc/passwd"}"#;
        let p = asset_paths(json);
        assert!(p.contains("projects/ab/logo.png"));
        assert!(p.contains("lib/x.svg"));
        assert!(!p.iter().any(|x| x.contains("..")));
    }

    #[test]
    fn round_trip_moves_the_project_folder() {
        let dir = std::env::temp_dir().join(format!("strata-archive-{}", std::process::id()));
        let assets = dir.join("assets");
        std::fs::create_dir_all(assets.join("projects/old")).unwrap();
        std::fs::write(assets.join("projects/old/logo.png"), b"png").unwrap();
        let json =
            br#"{"id":"old","src":"/assets/projects/old/logo.png","x":"/assets/missing.png"}"#;
        let zip = export(json, &assets).unwrap();
        let u = unpack(&zip).unwrap();
        assert_eq!(u.project.as_bytes(), json);
        assert_eq!(u.files.len(), 1);
        let to = dir.join("other");
        assert_eq!(restore(&u.files, &to, "old", "new").unwrap(), 1);
        assert_eq!(
            std::fs::read(to.join("projects/new/logo.png")).unwrap(),
            b"png"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
