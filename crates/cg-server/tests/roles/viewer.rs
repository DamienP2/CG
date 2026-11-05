//! The viewer: sees the program and the projects, changes nothing.

use serde_json::{json, Value};

use crate::common::*;

#[test]
fn a_viewer_watches_everything_and_changes_nothing() {
    let w = World::new();
    let v = &w.viewer;
    let (pid, tid, item, zone) = (
        &w.show.project,
        &w.show.template,
        &w.show.item,
        &w.show.zone,
    );
    let (_, station) = declare_station(&w.admin, "Gallery");
    w.admin
        .put("/api/channels/main/project", json!({ "projectId": pid }))
        .expect(204, "load");
    w.admin
        .post_empty(&format!("/api/channels/main/items/{item}/take"))
        .expect(200, "on air");
    w.admin
        .delete(&format!("/api/channels/main/zones/{zone}/lock"))
        .expect(204, "free the zone");

    // What a viewer sees.
    let p = v.get_json(&format!("/api/projects/{pid}"));
    assert_eq!(p["name"], "Evening news");
    let st = v.get_json("/api/channels/main/state");
    assert_eq!(on_air(&st).len(), 1);
    let png = v.get("/api/channels/main/preview.png");
    png.expect(200, "the program picture");
    assert_eq!(png.header("content-type"), Some("image/png"));
    assert!(png.body.starts_with(b"\x89PNG"));
    let thumb = v.get(&format!(
        "/api/projects/{pid}/templates/{tid}/thumbnail.png?w=120"
    ));
    thumb.expect(200, "a thumbnail");
    assert!(thumb.body.starts_with(b"\x89PNG"));
    let export = v.get(&format!("/api/projects/{pid}/export"));
    export.expect(200, "export");
    assert!(export
        .header("content-disposition")
        .unwrap_or("")
        .contains(".strata.json"));
    assert!(v.get_json("/api/system")["config"].is_null(), "no settings");
    let me = v.get_json("/api/auth/state");
    assert_eq!(me["user"]["role"], "viewer");

    let before_project = w.admin.get_json(&format!("/api/projects/{pid}"));
    let before_state = on_air(&w.admin.get_json("/api/channels/main/state"));
    // Every change, refused — even at a production station.
    let template = content_template(tid, "Hacked", zone);
    let writes: Vec<(&str, String, Option<Value>)> = vec![
        (
            "POST",
            "/api/projects".into(),
            Some(json!({ "name": "Mine" })),
        ),
        (
            "PUT",
            format!("/api/projects/{pid}"),
            Some(
                json!({ "name": "Mine", "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 } }),
            ),
        ),
        ("DELETE", format!("/api/projects/{pid}"), None),
        (
            "PUT",
            format!("/api/projects/{pid}/templates/{tid}"),
            Some(template),
        ),
        (
            "POST",
            format!("/api/projects/{pid}/templates/{tid}/publish"),
            None,
        ),
        (
            "PUT",
            format!("/api/projects/{pid}/rundown"),
            Some(json!([])),
        ),
        (
            "PUT",
            format!("/api/projects/{pid}/playlists"),
            Some(json!([{ "id": "main", "name": "Mine" }])),
        ),
        (
            "POST",
            format!("/api/projects/{pid}/versions"),
            Some(json!({ "note": "x" })),
        ),
        (
            "PUT",
            "/api/channels/main/project".into(),
            Some(json!({ "projectId": null })),
        ),
        (
            "POST",
            "/api/channels/main/command".into(),
            Some(json!({ "action": "clear" })),
        ),
        ("POST", format!("/api/channels/main/items/{item}/out"), None),
        ("POST", "/api/channels/main/undo".into(), None),
        (
            "PUT",
            format!("/api/channels/main/zones/{zone}/lock"),
            Some(json!({})),
        ),
        (
            "POST",
            "/api/channels/main/schedule".into(),
            Some(json!({ "action": "out", "zone": zone, "when": { "kind": "in", "secs": 5 } })),
        ),
        ("POST", "/api/v1/main/clear".into(), None),
        (
            "POST",
            "/api/simulate".into(),
            Some(json!({ "channelId": "main", "projectId": pid })),
        ),
        ("POST", "/api/keys".into(), Some(json!({ "name": "Mine" }))),
        (
            "POST",
            "/api/data/sources".into(),
            Some(json!({ "id": "", "name": "Mine", "type": "push" })),
        ),
        (
            "PUT",
            "/api/folders".into(),
            Some(json!({ "folders": ["Mine"], "assign": {} })),
        ),
        ("PUT", "/api/colors".into(), Some(json!([]))),
        (
            "POST",
            "/api/stations".into(),
            Some(json!({ "name": "Mine" })),
        ),
        ("GET", "/api/users".into(), None),
    ];
    at_station(v, &station, || {
        for (method, path, body) in &writes {
            let r = v.request(method, path, body.as_ref());
            assert_eq!(
                r.status,
                403,
                "{method} {path} as a viewer: {} {}",
                r.status,
                r.text()
            );
        }
        let r = v.raw("PUT", "/api/assets/mine.png", b"\x89PNG", "image/png");
        r.expect(403, "upload");
    });
    assert_eq!(
        w.admin.get_json(&format!("/api/projects/{pid}")),
        before_project,
        "the project is as it was"
    );
    assert_eq!(
        on_air(&w.admin.get_json("/api/channels/main/state")).len(),
        before_state.len(),
        "the program is as it was"
    );
    // Their own preferences are theirs.
    v.put("/api/me/theme", json!({ "theme": "dark" }))
        .expect(200, "own theme");
    v.put("/api/me/theme", json!({ "theme": "neon" }))
        .expect(400, "unknown theme");
    assert_eq!(v.get_json("/api/auth/state")["user"]["theme"], "dark");
}

/// A person limited to some projects, on a channel playing another
/// project: its picture, programmed takes and status are hidden (404 /
/// left out). The program's state and the as-run log should be too.
#[test]
fn a_viewer_limited_to_a_project_does_not_see_another_project_on_air() {
    let w = World::new();
    let mine = make_show(&w.admin, "Late show");
    declare_station(&w.admin, "Gallery");
    w.admin
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "the other show on air");
    w.admin
        .post_empty(&format!("/api/channels/main/items/{}/take", w.show.item))
        .expect(200, "take");
    w.admin
        .post(
            "/api/channels/main/schedule",
            json!({ "action": "out", "zone": w.show.zone, "when": { "kind": "in", "secs": 3600 } }),
        )
        .expect(201, "program an out");
    create_user(
        &w.admin,
        "late",
        "viewer",
        json!({ "projects": [mine.project] }),
    );
    let v = browser(&w.server, "late");
    v.get("/api/channels/main/preview.png")
        .expect(404, "the picture of another project");
    assert_eq!(
        v.get_json("/api/channels/main/schedule"),
        json!([]),
        "programmed takes of another project"
    );
    let status = v.get_json("/api/v1/main/status");
    assert!(!status.to_string().contains("Alice Martin"), "{status}");
}

#[test]
#[ignore = "BUG: GET /api/channels/{id}/state shows the graphics and values of a project out of the user's scope"]
fn the_state_of_a_channel_hides_a_project_out_of_scope() {
    let w = World::new();
    let mine = make_show(&w.admin, "Late show");
    declare_station(&w.admin, "Gallery");
    w.admin
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "the other show on air");
    w.admin
        .post_empty(&format!("/api/channels/main/items/{}/take", w.show.item))
        .expect(200, "take");
    create_user(
        &w.admin,
        "late",
        "viewer",
        json!({ "projects": [mine.project] }),
    );
    let v = browser(&w.server, "late");
    let r = v.get("/api/channels/main/state");
    assert!(
        r.status == 404 || !r.text().contains("Alice Martin"),
        "the values of another project on air: {} {}",
        r.status,
        r.text()
    );
}

#[test]
#[ignore = "BUG: GET /api/asrun lists the graphics and values of projects out of the user's scope"]
fn the_as_run_log_hides_projects_out_of_scope() {
    let w = World::new();
    let mine = make_show(&w.admin, "Late show");
    declare_station(&w.admin, "Gallery");
    w.admin
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "the other show on air");
    w.admin
        .post_empty(&format!("/api/channels/main/items/{}/take", w.show.item))
        .expect(200, "take");
    create_user(
        &w.admin,
        "late",
        "viewer",
        json!({ "projects": [mine.project] }),
    );
    let v = browser(&w.server, "late");
    let all = w.admin.get_json("/api/asrun");
    assert!(all.to_string().contains("Alice Martin"), "logged: {all}");
    let log = v.get_json("/api/asrun");
    assert!(
        !log.to_string().contains("Alice Martin") && !log.to_string().contains("Evening news"),
        "another project's entries: {log}"
    );
}

#[test]
fn a_viewer_limited_to_nothing_sees_nothing() {
    let w = World::new();
    create_user(
        &w.admin,
        "guest",
        "viewer",
        json!({ "projects": [], "channels": [] }),
    );
    let g = browser(&w.server, "guest");
    assert_eq!(g.get_json("/api/projects"), json!([]));
    assert_eq!(g.get_json("/api/channels"), json!([]));
    g.get(&format!("/api/projects/{}", w.show.project))
        .expect(404, "a project out of scope");
    g.get("/api/channels/main/state")
        .expect(404, "a channel out of scope");
    g.get("/api/channels/main/preview.png")
        .expect(404, "a channel out of scope");
    assert_eq!(g.get_json("/api/outputs/status"), json!({}));
}
