//! The operator: the rundown and its data, on air from a production
//! station, a simulation anywhere else, channels and projects in scope.

use std::time::Duration;

use serde_json::{json, Value};

use crate::common::*;

fn state(c: &Client, channel: &str) -> Value {
    c.get_json(&format!("/api/channels/{channel}/state"))
}

/// The graphic on air in the show's zone (layer 10), if any.
fn showing(state: &Value) -> Option<Value> {
    on_air(state).into_iter().next().map(|(_, v)| v)
}

#[test]
fn an_operator_prepares_the_rundown_and_its_data_but_designs_nothing() {
    let w = World::new();
    let op = &w.operator;
    let pid = &w.show.project;
    // Design is not theirs.
    op.post("/api/projects", json!({ "name": "Mine" }))
        .expect(403, "create a project");
    op.put(
        &format!("/api/projects/{pid}/templates/{}", w.show.template),
        content_template(&w.show.template, "Changed", &w.show.zone),
    )
    .expect(403, "edit a template");
    op.post_empty(&format!("/api/projects/{pid}/publish"))
        .expect(403, "publish");
    op.delete(&format!("/api/projects/{pid}"))
        .expect(403, "delete the project");
    op.put(&format!("/api/projects/{pid}/zones"), json!([]))
        .expect(403, "zones");

    // The rundown is: two graphics in a new shared playlist.
    op.put(
        &format!("/api/projects/{pid}/playlists"),
        json!([{ "id": "main", "name": "Main" }, { "id": "sport", "name": "Sport" }]),
    )
    .expect(204, "add a playlist");
    let base = w.admin.get_json(&format!("/api/projects/{pid}"))["rundown"].clone();
    let mut mine = base.as_array().unwrap().clone();
    mine.push(
        json!({ "id": "goal", "name": "Goal", "templateId": w.show.template,
                      "playlist": "sport", "data": { "name": "Mbappé 2-1" } }),
    );
    // Meanwhile a designer adds another one from the same rundown: both stay.
    let mut theirs = base.as_array().unwrap().clone();
    theirs.push(
        json!({ "id": "weather", "name": "Weather", "templateId": w.show.template,
                        "playlist": "main", "data": { "name": "Sunny" } }),
    );
    w.designer
        .put(
            &format!("/api/projects/{pid}/rundown"),
            json!({ "base": base, "rundown": theirs }),
        )
        .expect(204, "designer's change");
    op.put(
        &format!("/api/projects/{pid}/rundown"),
        json!({ "base": base, "rundown": mine }),
    )
    .expect(204, "operator's change");
    let p = w.viewer.get_json(&format!("/api/projects/{pid}"));
    let ids: Vec<&str> = p["rundown"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    for id in [w.show.item.as_str(), "goal", "weather"] {
        assert!(ids.contains(&id), "{id} in {ids:?}");
    }
    assert!(p["playlists"].to_string().contains("Sport"));
    op.put(
        &format!("/api/projects/{pid}/playlists"),
        json!([{ "id": "main", "name": "" }]),
    )
    .expect(400, "a playlist needs a name");

    // Data: a push source the designer made, fed by the operator.
    let r = w.designer.post(
        "/api/data/sources",
        json!({ "id": "", "name": "Score", "type": "push" }),
    );
    r.expect(200, "designer makes a source");
    let sid = r.json()["id"].as_str().unwrap().to_string();
    op.raw(
        "PUT",
        &format!("/api/data/sources/{sid}/value"),
        br#"{"home": 2, "away": 1}"#,
        "application/json",
    )
    .expect(204, "push a value");
    assert_eq!(
        w.viewer.get_json(&format!("/api/data/sources/{sid}/value")),
        json!({ "home": 2, "away": 1 })
    );
    let r = op.post("/api/data/lookup", json!({ "source": sid, "path": "home" }));
    r.expect(200, "look a value up");
    assert_eq!(r.json()["value"], "2");
    op.put(
        &format!("/api/data/sources/{sid}"),
        json!({ "id": sid, "name": "Mine", "type": "push" }),
    )
    .expect(403, "the source itself is the designer's");
    // A fetched source's credentials: for who may change it only.
    let r = w.designer.post(
        "/api/data/sources",
        json!({ "id": "", "name": "Wire", "type": "json", "url": "http://127.0.0.1:9/feed",
                "headers": { "Authorization": "Bearer s3cret-token" } }),
    );
    r.expect(200, "a source with a token");
    assert!(w
        .designer
        .get_json("/api/data/sources")
        .to_string()
        .contains("s3cret-token"));
    let seen = op.get_json("/api/data/sources");
    assert!(seen.to_string().contains("Wire"), "{seen}");
    assert!(!seen.to_string().contains("s3cret-token"), "{seen}");
    // A picture for an image field.
    let r = op.raw(
        "PUT",
        &format!("/api/projects/{pid}/media/guest.png"),
        b"\x89PNG\r\n\x1a\n",
        "image/png",
    );
    r.expect(200, "upload a picture");
    let media = w.viewer.get_json(&format!("/api/projects/{pid}/media"));
    assert!(media.to_string().contains("guest.png"), "{media}");
    op.delete(&format!("/api/projects/{pid}/media/guest.png"))
        .expect(403, "removing media is the designer's");
}

#[test]
fn an_operator_at_a_production_station_runs_the_show() {
    let w = World::new();
    // The admin declares the gallery's computer, then the operator signs in there.
    let (_, _secret) = declare_station(&w.admin, "Gallery 1");
    w.admin.logout();
    let gallery = &w.admin;
    gallery
        .login("operator", PASSWORD)
        .expect(200, "operator at the gallery");
    let (pid, item, zone) = (&w.show.project, &w.show.item, &w.show.zone);

    gallery
        .put("/api/channels/main/project", json!({ "projectId": pid }))
        .expect(204, "load the show");
    let ch = &w.viewer.get_json("/api/channels")[0];
    assert_eq!(ch["projectId"], pid.as_str(), "everyone sees it loaded");

    // Take: the rundown's values, on air, then holding.
    let r = gallery.post_empty(&format!("/api/channels/main/items/{item}/take"));
    r.expect(200, "take");
    let g = showing(&r.json()).expect("on air");
    assert_eq!(g["rundownId"], item.as_str());
    assert_eq!(g["data"]["name"], "Alice Martin");
    eventually(Duration::from_secs(10), "the graphic to hold", || {
        showing(&state(&w.viewer, "main")).filter(|g| g["phase"] == "holding")
    });
    // The zone is the operator's now.
    let locks = w.viewer.get_json("/api/channels/main/locks");
    assert_eq!(locks[0]["zone"], zone.as_str());
    assert_eq!(locks[0]["userId"], w.id("operator"));

    // Update: new values on air.
    gallery
        .post(
            &format!("/api/channels/main/items/{item}/update"),
            json!({ "data": { "name": "Alice Martin, minister" } }),
        )
        .expect(200, "update");
    assert_eq!(
        showing(&state(&w.viewer, "main")).unwrap()["data"]["name"],
        "Alice Martin, minister"
    );
    // A command of the web app (same as the buttons).
    gallery
        .post(
            "/api/channels/main/command",
            json!({ "action": "update", "zone": zone, "data": { "name": "Bob" } }),
        )
        .expect(200, "update command");
    assert_eq!(
        showing(&state(&w.viewer, "main")).unwrap()["data"]["name"],
        "Bob"
    );

    // Out: it leaves, then nothing is on air.
    gallery
        .post_empty(&format!("/api/channels/main/items/{item}/out"))
        .expect(200, "out");
    eventually(Duration::from_secs(10), "the graphic to leave", || {
        on_air(&state(&w.viewer, "main")).is_empty().then_some(())
    });
    // Undo brings the last action back.
    let steps = gallery.get_json("/api/channels/main/undo");
    assert!(!steps.as_array().unwrap().is_empty(), "{steps}");
    gallery
        .post_empty("/api/channels/main/undo")
        .expect(200, "undo");
    assert!(showing(&state(&w.viewer, "main")).is_some(), "back on air");
    gallery
        .post("/api/channels/main/command", json!({ "action": "clear" }))
        .expect(200, "clear");
    assert!(on_air(&state(&w.viewer, "main")).is_empty());
    gallery
        .post_empty(&format!("/api/channels/main/items/{item}/dance"))
        .expect(404, "unknown action");
    gallery
        .post_empty("/api/channels/main/items/nope/take")
        .expect(404, "unknown item");

    // The as-run log names the operator.
    let asrun = admin_view(&w).get_json("/api/asrun");
    assert!(asrun.to_string().contains("operator"), "{asrun}");

    // Another operator at the same station: the zone is held (409) until
    // they take it over; then the first is the one held back.
    w.designer
        .set_cookie("cg_station", &gallery.cookie("cg_station").unwrap());
    gallery
        .post_empty(&format!("/api/channels/main/items/{item}/take"))
        .expect(200, "take again");
    let r = w
        .designer
        .post_empty(&format!("/api/channels/main/items/{item}/out"));
    r.expect(409, "a zone another operator holds");
    w.designer
        .put(&format!("/api/channels/main/zones/{zone}/lock"), json!({}))
        .expect(204, "take the zone");
    gallery
        .post_empty(&format!("/api/channels/main/items/{item}/out"))
        .expect(409, "the zone was taken over");
    gallery
        .delete(&format!("/api/channels/main/zones/{zone}/lock"))
        .expect(403, "freeing another's zone");
    w.designer
        .delete(&format!("/api/channels/main/zones/{zone}/lock"))
        .expect(204, "free it");

    // A take programmed in a second fires by itself.
    let r = gallery.post(
        "/api/channels/main/schedule",
        json!({ "action": "out", "zone": zone, "when": { "kind": "in", "secs": 1 } }),
    );
    r.expect(201, "program an out");
    let listed = w.viewer.get_json("/api/channels/main/schedule");
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    eventually(Duration::from_secs(15), "the programmed out", || {
        on_air(&state(&w.viewer, "main")).is_empty().then_some(())
    });
    gallery
        .post(
            "/api/channels/main/schedule",
            json!({ "action": "take", "zone": zone, "when": { "kind": "in", "secs": 60 } }),
        )
        .expect(400, "a take needs a graphic");
}

/// The admin, signed in again on a browser of their own.
fn admin_view(w: &World) -> Client {
    let c = w.server.remote("admin-2");
    c.login("admin", PASSWORD).expect(200, "admin");
    c
}

#[test]
fn off_a_production_station_an_operator_drives_their_own_simulation() {
    let w = World::new();
    let (pid, tid, item, zone) = (
        &w.show.project,
        &w.show.template,
        &w.show.item,
        &w.show.zone,
    );
    declare_station(&w.admin, "Gallery");
    w.admin
        .put("/api/channels/main/project", json!({ "projectId": pid }))
        .expect(204, "load on air");
    w.admin
        .post_empty(&format!("/api/channels/main/items/{item}/take"))
        .expect(200, "on air");
    let before = state(&w.viewer, "main");
    w.admin
        .delete(&format!("/api/channels/main/zones/{zone}/lock"))
        .expect(204, "free the zone");

    // The real channel: refused from a desk.
    let op = &w.operator;
    let refused = [
        (
            "PUT",
            "/api/channels/main/project".to_string(),
            Some(json!({ "projectId": pid })),
        ),
        (
            "POST",
            "/api/channels/main/command".to_string(),
            Some(json!({ "action": "clear" })),
        ),
        ("POST", format!("/api/channels/main/items/{item}/out"), None),
        ("POST", "/api/channels/main/undo".to_string(), None),
        (
            "PUT",
            format!("/api/channels/main/zones/{zone}/lock"),
            Some(json!({})),
        ),
        (
            "POST",
            "/api/channels/main/schedule".to_string(),
            Some(json!({ "action": "out", "zone": zone, "when": { "kind": "in", "secs": 60 } })),
        ),
    ];
    for (method, path, body) in &refused {
        let r = op.request(method, path, body.as_ref());
        r.expect(403, "not a production station");
        assert!(r.text().contains("production station"), "{}", r.text());
    }

    // Their simulation of it instead.
    let r = op.post(
        "/api/simulate",
        json!({ "channelId": "main", "projectId": pid }),
    );
    r.expect(200, "simulate");
    assert_eq!(r.json()["simulation"], true);
    let sim = r.json()["channelId"].as_str().unwrap().to_string();
    assert_eq!(sim, format!("sim~{}~main", w.id("operator")));
    let r = op.post(
        &format!("/api/channels/{sim}/command"),
        json!({ "action": "take", "templateId": tid, "data": { "name": "Rehearsal" } }),
    );
    r.expect(200, "take in the simulation");
    assert_eq!(showing(&r.json()).unwrap()["data"]["name"], "Rehearsal");
    // On air nothing changed.
    let now = state(&w.viewer, "main");
    assert_eq!(
        showing(&now).unwrap()["data"],
        showing(&before).unwrap()["data"],
        "the real channel is untouched"
    );
    assert!(w
        .viewer
        .get_json("/api/channels")
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["id"] != sim.as_str()));
    let steps = op.get_json(&format!("/api/channels/{sim}/undo"));
    assert_eq!(steps.as_array().unwrap().len(), 1, "{steps}");
    let r = op.post_empty(&format!("/api/channels/{sim}/undo"));
    r.expect(200, "undo in the simulation");
    assert!(on_air(&r.json()).is_empty());
    let asrun = w.admin.get_json("/api/asrun");
    assert!(
        !asrun.to_string().contains("Rehearsal"),
        "a simulation is not in the as-run log"
    );

    // Nobody else sees or drives it.
    for other in [&w.designer, &w.admin] {
        other
            .post(
                &format!("/api/channels/{sim}/command"),
                json!({ "action": "clear" }),
            )
            .expect(404, "another person's simulation");
        other
            .get(&format!("/api/channels/{sim}/undo"))
            .expect(404, "another person's simulation");
    }
    // A designer gets their own.
    let r = w.designer.post(
        "/api/simulate",
        json!({ "channelId": "main", "projectId": pid }),
    );
    assert_eq!(
        r.json()["channelId"],
        format!("sim~{}~main", w.id("designer"))
    );
    // A project without output: in its own format.
    let r = op.post("/api/simulate", json!({ "projectId": pid }));
    r.expect(200, "simulate without a channel");
    let free = r.json()["channelId"].as_str().unwrap().to_string();
    assert_eq!(free, format!("sim~{}~-", w.id("operator")));
    op.post(
        &format!("/api/channels/{free}/command"),
        json!({ "action": "take", "templateId": tid }),
    )
    .expect(200, "take without output");
    // Viewers rehearse nothing; at the station, the operator is on air.
    w.viewer
        .post(
            "/api/simulate",
            json!({ "channelId": "main", "projectId": pid }),
        )
        .expect(403, "viewer");
    let station = w.admin.cookie("cg_station").unwrap();
    at_station(op, &station, || {
        let r = op.post(
            "/api/simulate",
            json!({ "channelId": "main", "projectId": pid }),
        );
        assert_eq!(
            r.json(),
            json!({ "channelId": "main", "simulation": false })
        );
    });
}

/// The state of one's own simulation, like any channel's.
#[test]
#[ignore = "BUG: GET /api/channels/{sim}/state answers 404 for the simulation's owner"]
fn the_state_of_a_simulation_reads_like_a_channel() {
    let w = World::new();
    let pid = &w.show.project;
    let r = w.operator.post(
        "/api/simulate",
        json!({ "channelId": "main", "projectId": pid }),
    );
    let sim = r.json()["channelId"].as_str().unwrap().to_string();
    w.operator
        .post(
            &format!("/api/channels/{sim}/command"),
            json!({ "action": "take", "templateId": w.show.template }),
        )
        .expect(200, "take in the simulation");
    let st = w.operator.get(&format!("/api/channels/{sim}/state"));
    st.expect(200, "the simulation's state");
    assert_eq!(on_air(&st.json()).len(), 1);
    w.designer
        .get(&format!("/api/channels/{sim}/state"))
        .expect(404, "not another's");
}

/// QUESTION: the rundown item routes (`items/{item}/{action}`, made for
/// control surfaces and newsrooms) do not reach a simulation, while
/// `command` and `undo` do. Current behavior asserted.
#[test]
fn rundown_item_routes_do_not_reach_a_simulation() {
    let w = World::new();
    let r = w.operator.post(
        "/api/simulate",
        json!({ "channelId": "main", "projectId": w.show.project }),
    );
    let sim = r.json()["channelId"].as_str().unwrap().to_string();
    let r = w
        .operator
        .post_empty(&format!("/api/channels/{sim}/items/{}/take", w.show.item));
    r.expect(404, "an item take in one's simulation (current behavior)");
    // The same take as a command works there.
    let r = w.operator.post(
        &format!("/api/channels/{sim}/command"),
        json!({ "action": "take", "templateId": w.show.template,
                "rundownId": w.show.item, "data": { "name": "Alice Martin" } }),
    );
    r.expect(200, "the same take as a command");
    assert_eq!(showing(&r.json()).unwrap()["data"]["name"], "Alice Martin");
}

/// People go on air from a production station only, whatever the route:
/// the control API (`/api/v1`) too, when a person's session calls it.
#[test]
#[ignore = "BUG: /api/v1/{channel}/… lets a signed-in person drive a real channel off a production station"]
fn the_control_api_does_not_bypass_production_stations() {
    let w = World::new();
    declare_station(&w.admin, "Gallery");
    w.admin
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "load");
    let r = w
        .operator
        .post_empty(&format!("/api/v1/main/take/{}", w.show.item));
    r.expect(403, "a take from a desk through /api/v1");
    assert!(on_air(&state(&w.viewer, "main")).is_empty());
}

#[test]
fn an_operator_drives_only_the_channels_and_projects_in_scope() {
    let w = World::new();
    let (_, station) = declare_station(&w.admin, "Gallery");
    let other = make_show(&w.admin, "Late show");
    create_user(
        &w.admin,
        "late",
        "operator",
        json!({ "projects": [other.project] }),
    );
    create_user(
        &w.admin,
        "elsewhere",
        "operator",
        json!({ "channels": ["studio-z"] }),
    );
    let late = browser(&w.server, "late");
    let elsewhere = browser(&w.server, "elsewhere");

    // Channels out of scope: not listed, not there.
    assert_eq!(elsewhere.get_json("/api/channels"), json!([]));
    elsewhere
        .get("/api/channels/main/state")
        .expect(404, "channel out of scope");
    at_station(&elsewhere, &station, || {
        elsewhere
            .put(
                "/api/channels/main/project",
                json!({ "projectId": w.show.project }),
            )
            .expect(404, "load on a channel out of scope");
        elsewhere
            .post("/api/channels/main/command", json!({ "action": "clear" }))
            .expect(404, "command on a channel out of scope");
    });
    elsewhere
        .post(
            "/api/simulate",
            json!({ "channelId": "main", "projectId": w.show.project }),
        )
        .expect(404, "simulate a channel out of scope");
    elsewhere
        .post("/api/simulate", json!({ "projectId": w.show.project }))
        .expect(200, "a simulation without output is theirs");
    let st = elsewhere.get_json("/api/v1/status");
    assert!(!st.to_string().contains("\"main\""), "{st}");

    // Projects out of scope: not loaded, not driven, not seen on air.
    at_station(&late, &station, || {
        late.put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(403, "load a project out of scope");
        late.put(
            "/api/channels/main/project",
            json!({ "projectId": other.project }),
        )
        .expect(204, "load its own project");
        late.post_empty(&format!("/api/channels/main/items/{}/take", other.item))
            .expect(200, "take");
    });
    w.admin
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "the admin loads the other show");
    at_station(&late, &station, || {
        late.post("/api/channels/main/command", json!({ "action": "clear" }))
            .expect(404, "driving a project out of scope");
        late.post_empty(&format!("/api/channels/main/items/{}/take", w.show.item))
            .expect(404, "an item of a project out of scope");
        late.post_empty(&format!("/api/v1/main/take/{}", w.show.item))
            .expect(404, "the control API too");
    });
    late.get("/api/channels/main/preview.png")
        .expect(404, "the picture of a project out of scope");
    late.put(
        &format!("/api/projects/{}/rundown", w.show.project),
        json!([]),
    )
    .expect(403, "the rundown of a project out of scope");
    late.post(
        "/api/simulate",
        json!({ "channelId": "main", "projectId": w.show.project }),
    )
    .expect(403, "simulate a project out of scope");
}

/// An operator limited to one project does not see the takes programmed
/// for another one on the channel; they should not be able to remove or
/// switch them off either.
#[test]
#[ignore = "BUG: DELETE/PATCH /api/channels/{id}/schedule/{sid} let an operator change takes programmed for a project out of their scope"]
fn programmed_takes_of_a_project_out_of_scope_stay_out_of_reach() {
    let w = World::new();
    let (_, station) = declare_station(&w.admin, "Gallery");
    let other = make_show(&w.admin, "Late show");
    create_user(
        &w.admin,
        "late",
        "operator",
        json!({ "projects": [other.project] }),
    );
    let late = browser(&w.server, "late");
    w.admin
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "load");
    let r = w.admin.post(
        "/api/channels/main/schedule",
        json!({ "action": "out", "zone": w.show.zone, "when": { "kind": "in", "secs": 3600 } }),
    );
    r.expect(201, "the admin programs an out");
    let sid = r.json()["id"].as_str().unwrap().to_string();
    assert_eq!(late.get_json("/api/channels/main/schedule"), json!([]));
    at_station(&late, &station, || {
        let r = late.patch(
            &format!("/api/channels/main/schedule/{sid}"),
            json!({ "enabled": false }),
        );
        assert!(
            r.status == 404 || r.status == 403,
            "switch off: {}",
            r.status
        );
        let r = late.delete(&format!("/api/channels/main/schedule/{sid}"));
        assert!(r.status == 404 || r.status == 403, "remove: {}", r.status);
    });
    let left = w.admin.get_json("/api/channels/main/schedule");
    assert_eq!(left.as_array().unwrap().len(), 1, "{left}");
    assert_eq!(left[0]["enabled"], true);
}
