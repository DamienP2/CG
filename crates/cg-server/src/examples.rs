//! The example projects: complete, on-air ready channel packages (news,
//! sport, elections, weather, gaming…), embedded in the server. Each one
//! is `examples/ex-NN-slug.json`, `{"meta": ExampleInfo, "project": Project}`,
//! written by tools/examples/*.py; build.rs lists them.

use cg_core::Project;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleInfo {
    pub id: String,
    pub name: String,
    /// News, Sport, Elections, Weather, Finance, Entertainment, Gaming…
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub description: String,
    /// The template shown on the example's card (default: the first one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// Name and description in English (the main ones are in French).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub en: Option<Translation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Translation {
    pub name: String,
    pub description: String,
}

/// An example as listed: its card plus what it contains.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleSummary {
    #[serde(flatten)]
    pub info: ExampleInfo,
    /// Names of its templates.
    pub templates: Vec<String>,
    /// Its formats besides 16:9 ("9:16"…).
    pub formats: Vec<String>,
}

#[derive(Deserialize)]
struct ExampleFile {
    meta: ExampleInfo,
    project: Project,
}

const FILES: &[&str] = include!(concat!(env!("OUT_DIR"), "/examples.rs"));

fn all() -> impl Iterator<Item = ExampleFile> {
    FILES
        .iter()
        .filter_map(|j| match serde_json::from_str::<ExampleFile>(j) {
            Ok(d) => Some(d),
            Err(e) => {
                tracing::error!("bad example project: {e}");
                None
            }
        })
}

pub fn list() -> Vec<ExampleSummary> {
    all()
        .map(|d| ExampleSummary {
            templates: d.project.templates.iter().map(|t| t.name.clone()).collect(),
            formats: d.project.formats.iter().map(|f| f.name.clone()).collect(),
            info: d.meta,
        })
        .collect()
}

/// A copy of an example, ready to be saved as a new project.
pub fn project(id: &str) -> Option<Project> {
    all().find(|d| d.meta.id == id).map(|d| d.project)
}

/// The example and the template of its card.
pub fn cover(id: &str) -> Option<(Project, cg_core::Template)> {
    let d = all().find(|d| d.meta.id == id)?;
    let t = d
        .meta
        .cover
        .as_deref()
        .and_then(|c| d.project.template(c))
        .or(d.project.templates.first())?
        .clone();
    Some((d.project, t))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Share of the pixels of a frame that are not fully transparent.
    fn coverage(frame: &cg_render::Frame) -> f64 {
        let px = &frame.data;
        let n = px.len() / 4;
        let painted = px.chunks_exact(4).filter(|p| p[3] > 0).count();
        painted as f64 / n.max(1) as f64
    }

    #[test]
    fn every_example_loads_and_renders() {
        let examples: Vec<(String, ExampleFile)> = FILES
            .iter()
            .map(|j| {
                let d: ExampleFile = serde_json::from_str(j).unwrap_or_else(|e| {
                    let id = j.get(..200).unwrap_or(j);
                    panic!("an example parses: {e}\n{id}")
                });
                (d.meta.id.clone(), d)
            })
            .collect();
        assert_eq!(examples.len(), FILES.len());
        let mut ids: Vec<&str> = examples.iter().map(|(id, _)| id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), examples.len(), "example ids are unique");
        let mut renderer =
            cg_render::Renderer::new(std::env::temp_dir().join("strata-example-test"));
        for (id, d) in &examples {
            let p = &d.project;
            assert_eq!(&p.id, id, "the project id is the example id");
            let zones: Vec<&str> = p.zones.iter().map(|z| z.id.as_str()).collect();
            assert!(!p.templates.is_empty(), "{id}: no template");
            if let Some(c) = &d.meta.cover {
                assert!(p.template(c).is_some(), "{id}: cover {c} is not a template");
            }
            for r in &p.rundown {
                assert!(
                    p.template(&r.template_id).is_some(),
                    "{id}: item {} without template",
                    r.name
                );
                assert!(
                    zones.contains(&r.zone.as_str()),
                    "{id}: item {} in an unknown zone",
                    r.name
                );
                assert!(
                    r.playlist.is_empty() || p.playlists.iter().any(|pl| pl.id == r.playlist),
                    "{id}: item {} in an unknown playlist",
                    r.name
                );
            }
            for t in &p.templates {
                assert!(
                    zones.contains(&t.zone.as_str()),
                    "{id}: template {} in an unknown zone",
                    t.name
                );
                assert!(
                    t.markers.iter().any(|m| m.kind == cg_core::MarkerKind::Out),
                    "{id}: template {} has no on-air point",
                    t.name
                );
                // The graphics sit in their zone (they are cut to it on air).
                let zone = p.zones.iter().find(|z| z.id == t.zone).unwrap();
                let area = zone.area(cg_core::MAIN_FORMAT, false);
                for l in t.layers.iter().filter(|l| l.parent.is_none()) {
                    let n = |prop: cg_core::Prop| {
                        l.props
                            .get(&prop)
                            .and_then(|v| v.as_number())
                            .unwrap_or(0.0)
                    };
                    let (x, y, w, h) = (
                        n(cg_core::Prop::X),
                        n(cg_core::Prop::Y),
                        n(cg_core::Prop::Width),
                        n(cg_core::Prop::Height),
                    );
                    let (ax, ay) = (area.x * p.width as f64, area.y * p.height as f64);
                    let (aw, ah) = (area.width * p.width as f64, area.height * p.height as f64);
                    assert!(
                        x >= ax - 2.0
                            && y >= ay - 2.0
                            && x + w <= ax + aw + 2.0
                            && y + h <= ay + ah + 2.0,
                        "{id}: {} / {} out of its zone {}",
                        t.name,
                        l.name,
                        zone.name
                    );
                }
                let data = t.default_data();
                let hold = t.hold_frame();
                for f in std::iter::once(cg_core::MAIN_FORMAT)
                    .chain(p.formats.iter().map(|f| f.id.as_str()))
                {
                    let frame = renderer.render_template(p, t, f, hold, &data);
                    let png = frame.to_png();
                    assert!(png.len() > 100, "{id}: {} renders", t.name);
                    // STRATA_EXAMPLES_PNG=dir: every template on air, to look at.
                    if let Some(dir) = std::env::var_os("STRATA_EXAMPLES_PNG") {
                        let dir = std::path::Path::new(&dir);
                        std::fs::create_dir_all(dir).unwrap();
                        std::fs::write(dir.join(format!("{id}__{}__{f}.png", t.id)), &png).unwrap();
                    }
                    // On air, the graphic shows something.
                    assert!(
                        coverage(&frame) > 0.0005,
                        "{id}: {} ({f}) is empty on air",
                        t.name
                    );
                }
            }
        }
    }
}
