//! The designer: projects and templates, drafts and publishing, versions,
//! edit locks between designers, project scope.

use serde_json::{json, Value};

use crate::common::*;

fn project(c: &Client, id: &str) -> Value {
    c.get_json(&format!("/api/projects/{id}"))
}

fn layers(t: &Value) -> usize {
    t["layers"].as_array().map_or(0, |l| l.len())
}

fn draft<'a>(p: &'a Value, tid: &str) -> Option<&'a Value> {
    p["drafts"]
        .as_array()
        .and_then(|d| d.iter().find(|t| t["id"] == tid))
}

#[test]
fn a_designer_drafts_publishes_and_goes_back_to_a_version() {
    let w = World::new();
    let d = &w.designer;
    let pid = create_project(d, "Sports night");
    assert!(d
        .get_json("/api/projects")
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == pid.as_str() && p["name"] == "Sports night"));
    let p = project(d, &pid);
    // A new project starts with one published template, empty.
    assert_eq!(p["templates"].as_array().unwrap().len(), 1);
    let tid = p["templates"][0]["id"].as_str().unwrap().to_string();
    let zone = p["zones"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(layers(&p["templates"][0]), 0);
    assert_eq!(p["templates"][0]["revision"], 1);

    // Saved: a draft. What goes on air is still the published one.
    d.put(
        &format!("/api/projects/{pid}/templates/{tid}"),
        content_template(&tid, "Score", &zone),
    )
    .expect(204, "save a draft");
    let p = project(d, &pid);
    assert_eq!(layers(&p["templates"][0]), 0, "published unchanged");
    assert_eq!(layers(draft(&p, &tid).expect("a draft")), 2);
    d.put(
        &format!("/api/projects/{pid}/templates/other-id"),
        content_template(&tid, "Score", &zone),
    )
    .expect(400, "the id of the address and of the body differ");

    // The operator, at a station, cannot take the draft yet.
    let (_, station) = declare_station(&w.admin, "Gallery");
    at_station(&w.operator, &station, || {
        w.operator
            .put("/api/channels/main/project", json!({ "projectId": pid }))
            .expect(204, "load");
        w.operator
            .post(
                "/api/channels/main/command",
                json!({ "action": "take", "templateId": tid }),
            )
            .expect(400, "an empty published template");
    });

    // Published: revision 2, no draft left, a version kept.
    let r = d.post_empty(&format!("/api/projects/{pid}/templates/{tid}/publish"));
    r.expect(200, "publish");
    assert_eq!(r.json()["revision"], 2);
    let p = project(d, &pid);
    assert_eq!(layers(&p["templates"][0]), 2);
    assert!(draft(&p, &tid).is_none());
    let versions = d.get_json(&format!("/api/projects/{pid}/versions"));
    assert!(
        versions.to_string().contains("Published"),
        "a version at each publish: {versions}"
    );
    at_station(&w.operator, &station, || {
        let r = w.operator.post(
            "/api/channels/main/command",
            json!({ "action": "take", "templateId": tid, "data": { "name": "Final score" } }),
        );
        r.expect(200, "the published template goes on air");
        assert_eq!(on_air(&r.json())[0].1["data"]["name"], "Final score");
    });
    // Publishing again with nothing new: the same revision.
    let r = d.post_empty(&format!("/api/projects/{pid}/templates/{tid}/publish"));
    r.expect(200, "publish without changes");
    assert_eq!(r.json()["revision"], 2);
    d.post_empty(&format!("/api/projects/{pid}/templates/nope/publish"))
        .expect(404, "no such template");

    // A draft dropped: back to what is on air.
    let mut changed = content_template(&tid, "Score v3", &zone);
    changed["layers"].as_array_mut().unwrap().pop();
    d.put(&format!("/api/projects/{pid}/templates/{tid}"), changed)
        .expect(204, "change");
    d.delete(&format!("/api/projects/{pid}/templates/{tid}/draft"))
        .expect(204, "discard");
    let p = project(d, &pid);
    assert!(draft(&p, &tid).is_none());
    assert_eq!(p["templates"][0]["name"], "Score");

    // A new template: a draft only, never published (discarding makes no
    // sense: it is deleted instead).
    d.put(
        &format!("/api/projects/{pid}/templates/strap"),
        content_template("strap", "Strap", &zone),
    )
    .expect(204, "new template");
    d.delete(&format!("/api/projects/{pid}/templates/strap/draft"))
        .expect(400, "never published");
    // Publishing the project publishes every draft.
    let r = d.post_empty(&format!("/api/projects/{pid}/publish"));
    r.expect(200, "publish all");
    let names: Vec<String> = r
        .json()
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Strap"]);
    assert_eq!(project(d, &pid)["templates"].as_array().unwrap().len(), 2);
    let r = d.post_empty(&format!("/api/projects/{pid}/publish"));
    assert_eq!(r.json(), json!([]), "nothing left to publish");

    // A version by hand, a change, then back to the version.
    let v = d.post(
        &format!("/api/projects/{pid}/versions"),
        json!({ "note": "Before the rename" }),
    );
    v.expect(200, "keep a version");
    let vid = v.json()["id"].as_str().unwrap().to_string();
    d.put(
        &format!("/api/projects/{pid}"),
        json!({ "name": "Renamed", "width": 1280, "height": 720,
                "frameRate": { "num": 25, "den": 1 } }),
    )
    .expect(204, "project settings");
    let p = project(d, &pid);
    assert_eq!(
        (p["name"].clone(), p["width"].clone()),
        (json!("Renamed"), json!(1280))
    );
    d.put(
        &format!("/api/projects/{pid}"),
        json!({ "name": "Bad", "width": 0, "height": 720, "frameRate": { "num": 25, "den": 1 } }),
    )
    .expect(400, "an impossible format");
    d.post_empty(&format!("/api/projects/{pid}/versions/{vid}/restore"))
        .expect(204, "restore");
    let p = project(d, &pid);
    assert_eq!(
        (p["name"].clone(), p["width"].clone()),
        (json!("Sports night"), json!(1920))
    );
    let versions = d.get_json(&format!("/api/projects/{pid}/versions"));
    assert!(
        versions.to_string().contains("Before restoring"),
        "{versions}"
    );
    d.post_empty(&format!("/api/projects/{pid}/versions/nope/restore"))
        .expect(404, "no such version");

    // A project keeps one template at least.
    d.delete(&format!("/api/projects/{pid}/templates/strap"))
        .expect(204, "delete a template");
    d.delete(&format!("/api/projects/{pid}/templates/{tid}"))
        .expect(409, "the last template");

    // Duplicated, then the copy deleted.
    let r = d.post(
        "/api/projects",
        json!({ "name": "Sports night (copy)", "from": pid }),
    );
    r.expect(200, "duplicate");
    let copy = r.json()["id"].as_str().unwrap().to_string();
    assert_ne!(copy, pid);
    assert_eq!(project(d, &copy)["templates"][0]["name"], "Score");
    d.delete(&format!("/api/projects/{copy}"))
        .expect(204, "delete the copy");
    d.get(&format!("/api/projects/{copy}"))
        .expect(404, "deleted");
    d.delete(&format!("/api/projects/{copy}"))
        .expect(404, "already deleted");
    assert!(d
        .get_json("/api/projects")
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["id"] != copy.as_str()));
    // The demo projects.
    let examples = d.get_json("/api/examples");
    let first = examples[0]["id"].as_str().unwrap().to_string();
    let r = d.post_empty(&format!("/api/examples/{first}"));
    r.expect(200, "from an example");
    assert!(r.json()["templates"].as_u64().unwrap() > 1);
    d.post_empty("/api/examples/no-such-example")
        .expect(404, "unknown example");
}

#[test]
fn a_template_is_edited_by_one_designer_at_a_time_and_can_be_taken_over() {
    let w = World::new();
    create_user(
        &w.admin,
        "designer2",
        "designer",
        json!({ "displayName": "Bea" }),
    );
    let a = &w.designer;
    let b = browser(&w.server, "designer2");
    let (pid, tid, zone) = (&w.show.project, &w.show.template, &w.show.zone);
    let lock = format!("/api/projects/{pid}/templates/{tid}/lock");
    let save = format!("/api/projects/{pid}/templates/{tid}");

    let r = a.post(&lock, json!({}));
    r.expect(200, "A opens the template");
    assert_eq!(r.json()["granted"], true);
    let locks = b.get_json(&format!("/api/projects/{pid}/locks"));
    assert_eq!(locks[tid.as_str()]["userName"], "designer", "{locks}");

    // B sees it held, and cannot save over A.
    let r = b.post(&lock, json!({}));
    r.expect(200, "B asks");
    assert_eq!(r.json()["granted"], false);
    assert_eq!(r.json()["lock"]["userName"], "designer");
    let r = b.put(&save, content_template(tid, "B's version", zone));
    r.expect(409, "B saves while A edits");
    assert!(r.text().contains("designer is editing"), "{}", r.text());
    a.put(&save, content_template(tid, "A's version", zone))
        .expect(204, "A saves");
    // A second tab of A is read only too.
    let tab = a.new_tab();
    assert_eq!(tab.post(&lock, json!({})).json()["granted"], false);
    tab.put(&save, content_template(tid, "Tab", zone))
        .expect(409, "another tab");

    // B takes it over: A is now the one refused.
    let r = b.post(&lock, json!({ "force": true }));
    r.expect(200, "take over");
    assert_eq!(r.json()["granted"], true);
    assert_eq!(r.json()["lock"]["userName"], "Bea");
    let r = a.put(&save, content_template(tid, "A again", zone));
    r.expect(409, "A lost the lock");
    assert!(r.text().contains("Bea is editing"), "{}", r.text());
    assert_eq!(a.post(&lock, json!({})).json()["granted"], false);
    b.put(&save, content_template(tid, "B's version", zone))
        .expect(204, "B saves");
    let p = w.admin.get_json(&format!("/api/projects/{pid}"));
    let d = p["drafts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tid.as_str())
        .unwrap();
    assert_eq!(d["name"], "B's version");

    // Releasing: only the holder's tab does it; then A gets it back.
    a.delete(&lock).expect(204, "A's release is nothing");
    assert_eq!(a.post(&lock, json!({})).json()["granted"], false);
    b.delete(&lock).expect(204, "B closes the template");
    assert!(b
        .get_json(&format!("/api/projects/{pid}/locks"))
        .as_object()
        .unwrap()
        .is_empty());
    assert_eq!(a.post(&lock, json!({})).json()["granted"], true);

    // Who may not design takes no lock.
    w.operator.post(&lock, json!({})).expect(403, "operator");
    w.viewer.post(&lock, json!({})).expect(403, "viewer");
    // Automation (no designer tab) is not held back by a lock.
    let key = a.post("/api/keys", json!({ "name": "CI" })).json()["secret"]
        .as_str()
        .unwrap()
        .to_string();
    a.with_key(&key)
        .put(&save, content_template(tid, "From CI", zone))
        .expect(204, "an API key saves");
}

#[test]
fn a_scoped_designer_sees_and_changes_only_their_projects() {
    let w = World::new();
    let mine = make_show(&w.admin, "Morning show");
    let other = &w.show;
    // An own data source of the other project.
    w.admin
        .post(
            "/api/data/sources",
            json!({ "id": "", "name": "Secret feed", "type": "push", "project": other.project }),
        )
        .expect(200, "a source of the other project");
    create_user(
        &w.admin,
        "morning",
        "designer",
        json!({ "projects": [mine.project] }),
    );
    let d = browser(&w.server, "morning");
    let list = d.get_json("/api/projects");
    let ids: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [mine.project.as_str()]);

    let o = &other.project;
    for path in [
        format!("/api/projects/{o}"),
        format!("/api/projects/{o}/export"),
        format!("/api/projects/{o}/versions"),
        format!("/api/projects/{o}/locks"),
        format!("/api/projects/{o}/media"),
        format!(
            "/api/projects/{o}/templates/{}/thumbnail.png",
            other.template
        ),
    ] {
        d.get(&path)
            .expect(404, "a project out of scope is not there");
    }
    let writes: Vec<(&str, String, Value)> = vec![
        (
            "PUT",
            format!("/api/projects/{o}"),
            json!({ "name": "Mine now", "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 } }),
        ),
        (
            "PUT",
            format!("/api/projects/{o}/templates/{}", other.template),
            content_template(&other.template, "X", &other.zone),
        ),
        ("POST", format!("/api/projects/{o}/publish"), json!({})),
        ("PUT", format!("/api/projects/{o}/rundown"), json!([])),
        (
            "PUT",
            format!("/api/projects/{o}/playlists"),
            json!([{ "id": "main", "name": "Main" }]),
        ),
        (
            "POST",
            format!("/api/projects/{o}/templates/{}/lock", other.template),
            json!({}),
        ),
        ("DELETE", format!("/api/projects/{o}"), Value::Null),
    ];
    for (method, path, body) in &writes {
        let r = d.request(method, path, (!body.is_null()).then_some(body));
        assert!(
            r.status == 403 || r.status == 404,
            "{method} {path}: refused, got {} {}",
            r.status,
            r.text()
        );
    }
    w.admin
        .get(&format!("/api/projects/{o}"))
        .expect(200, "the other project is untouched");
    assert_eq!(
        w.admin.get_json(&format!("/api/projects/{o}"))["name"],
        "Evening news"
    );
    d.post("/api/projects", json!({ "name": "Copy", "from": o }))
        .expect(404, "duplicating a project out of scope");
    // Its data: the shared ones and those of its projects only.
    let sources = d.get_json("/api/data/sources");
    assert!(
        !sources.to_string().contains("Secret feed"),
        "another project's source: {sources}"
    );

    // Its own project: as any designer.
    d.put(
        &format!(
            "/api/projects/{}/templates/{}?publish=true",
            mine.project, mine.template
        ),
        content_template(&mine.template, "Morning strap", &mine.zone),
    )
    .expect(204, "edit own project");
    d.put(
        &format!("/api/projects/{}", mine.project),
        json!({ "name": "Morning show HD", "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 } }),
    )
    .expect(204, "rename own project");
    // On a channel, the other project is not shown to them.
    let (_, station) = declare_station(&w.admin, "Gallery");
    w.admin
        .put("/api/channels/main/project", json!({ "projectId": o }))
        .expect(204, "the other project on air");
    d.get("/api/channels/main/preview.png")
        .expect(404, "the picture of a project out of scope");
    at_station(&d, &station, || {
        d.post(
            "/api/channels/main/command",
            json!({ "action": "take", "templateId": other.template }),
        )
        .expect(404, "driving a project out of scope");
        d.put("/api/channels/main/project", json!({ "projectId": o }))
            .expect(403, "loading a project out of scope");
        d.put(
            "/api/channels/main/project",
            json!({ "projectId": mine.project }),
        )
        .expect(204, "loading its own project");
    });
}

/// A designer limited to some projects creates a new one: it should be
/// theirs to see (they made it).
#[test]
#[ignore = "BUG: a project scoped designer cannot see the project they just created"]
fn a_scoped_designer_sees_the_project_they_create() {
    let w = World::new();
    create_user(
        &w.admin,
        "morning",
        "designer",
        json!({ "projects": [w.show.project] }),
    );
    let d = browser(&w.server, "morning");
    let id = create_project(&d, "Brand new");
    d.get(&format!("/api/projects/{id}"))
        .expect(200, "the project just created");
    assert!(d
        .get_json("/api/projects")
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == id.as_str()));
}
