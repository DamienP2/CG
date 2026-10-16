//! Show projects, stored one JSON file per project in `<data>/projects/`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cg_core::Project;
use serde::Serialize;

pub struct Library {
    dir: PathBuf,
    projects: BTreeMap<String, Arc<Project>>,
}

/// What lists and pickers need, without the templates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: cg_core::FrameRate,
    pub templates: usize,
    pub rundown: usize,
}

impl From<&Project> for ProjectSummary {
    fn from(p: &Project) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            description: p.description.clone(),
            width: p.width,
            height: p.height,
            frame_rate: p.frame_rate,
            templates: p.templates.len(),
            rundown: p.rundown.len(),
        }
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Library {
    /// Loads every project. A pre-0.2 `project.json` becomes the first
    /// project; an empty library gets the demo project.
    pub fn load(data_dir: &Path) -> std::io::Result<Self> {
        let dir = data_dir.join("projects");
        std::fs::create_dir_all(&dir)?;
        let mut lib = Self {
            dir,
            projects: BTreeMap::new(),
        };
        for entry in std::fs::read_dir(&lib.dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read(&path).map(|b| serde_json::from_slice::<Project>(&b)) {
                Ok(Ok(mut p)) if valid_id(&p.id) => {
                    // Pre-zone projects: one zone per playout layer used.
                    if p.ensure_zones() {
                        tracing::info!(id = p.id, "project migrated to zones");
                        lib.save(p)?;
                    } else {
                        lib.projects.insert(p.id.clone(), Arc::new(p));
                    }
                }
                Ok(Ok(_)) => tracing::error!(?path, "project with an invalid id ignored"),
                Ok(Err(e)) => tracing::error!(?path, "invalid project: {e}"),
                Err(e) => tracing::error!(?path, "cannot read project: {e}"),
            }
        }
        let legacy = data_dir.join("project.json");
        if legacy.exists() {
            match std::fs::read(&legacy).map(|b| serde_json::from_slice::<Project>(&b)) {
                Ok(Ok(mut p)) => {
                    p.ensure_zones();
                    if !valid_id(&p.id) {
                        p.id = cg_core::new_id();
                    }
                    if !lib.projects.contains_key(&p.id) {
                        tracing::info!(
                            id = p.id,
                            "migrating project.json into the project library"
                        );
                        lib.save(p)?;
                    }
                    let _ = std::fs::rename(&legacy, data_dir.join("project.json.migrated"));
                }
                _ => tracing::error!("cannot migrate project.json (left in place)"),
            }
        }
        if lib.projects.is_empty() {
            lib.save(cg_core::sample::demo_project())?;
        }
        Ok(lib)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Project>> {
        self.projects.get(id).cloned()
    }

    pub fn list(&self) -> impl Iterator<Item = &Arc<Project>> {
        self.projects.values()
    }

    pub fn first_id(&self) -> Option<String> {
        self.projects.keys().next().cloned()
    }

    pub fn save(&mut self, project: Project) -> std::io::Result<Arc<Project>> {
        if !valid_id(&project.id) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid project id",
            ));
        }
        let path = self.dir.join(format!("{}.json", project.id));
        let tmp = path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(&project).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(&tmp, &path)?;
        let p = Arc::new(project);
        self.projects.insert(p.id.clone(), p.clone());
        Ok(p)
    }

    pub fn delete(&mut self, id: &str) -> std::io::Result<bool> {
        if self.projects.remove(id).is_none() {
            return Ok(false);
        }
        let path = self.dir.join(format!("{id}.json"));
        match std::fs::remove_file(path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_project_json_and_roundtrips() {
        let dir = std::env::temp_dir().join(format!("cg-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut p = cg_core::sample::demo_project();
        p.id = "my-show".into();
        std::fs::write(dir.join("project.json"), serde_json::to_vec(&p).unwrap()).unwrap();

        let mut lib = Library::load(&dir).unwrap();
        assert!(lib.get("my-show").is_some());
        assert!(!dir.join("project.json").exists());
        let mut copy = (*lib.get("my-show").unwrap()).clone();
        copy.id = "copy".into();
        lib.save(copy).unwrap();
        assert_eq!(Library::load(&dir).unwrap().list().count(), 2);
        assert!(lib.delete("copy").unwrap());
        assert_eq!(Library::load(&dir).unwrap().list().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
