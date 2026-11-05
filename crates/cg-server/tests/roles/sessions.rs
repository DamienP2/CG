//! Signing in and out, one computer at a time, wrong passwords, requests
//! from other sites, personal playlists.

use std::time::Duration;

use serde_json::{json, Value};

use crate::common::*;

#[test]
fn a_new_sign_in_closes_the_session_on_the_other_computer() {
    let w = World::new();
    let first = &w.designer;
    first.get("/api/projects").expect(200, "signed in");
    let key = w
        .admin
        .post(
            "/api/keys",
            json!({ "name": "Deck", "userId": w.id("designer") }),
        )
        .json()["secret"]
        .as_str()
        .unwrap()
        .to_string();
    let second = w.server.remote("designer-laptop");
    let r = second.login("designer", PASSWORD);
    r.expect(200, "sign in on another computer");
    let token = r.json()["token"].as_str().unwrap().to_string();
    first
        .get("/api/projects")
        .expect(401, "the first computer is out");
    assert!(first.whoami().is_none());
    second.get("/api/projects").expect(200, "the second is in");
    // The token of the sign-in is also a bearer token (automation).
    let bearer = w.server.remote("script").with_key(&token);
    bearer.get("/api/projects").expect(200, "bearer token");
    // Back on the first: the second is out.
    first.login("designer", PASSWORD).expect(200, "again");
    second
        .get("/api/projects")
        .expect(401, "the second is out now");
    bearer.get("/api/projects").expect(401, "its token too");
    // Other people, and the person's API keys, are not concerned.
    w.operator.get("/api/projects").expect(200, "another user");
    first
        .with_key(&key)
        .get("/api/projects")
        .expect(200, "an API key outlives sign-ins");
}

#[test]
fn signing_out_ends_the_session() {
    let w = World::new();
    let token = w.viewer.cookie("cg_session").expect("a session cookie");
    w.viewer.logout();
    assert!(w.viewer.cookie("cg_session").is_none(), "cookie cleared");
    w.viewer.get("/api/projects").expect(401, "signed out");
    w.server
        .remote("old-token")
        .with_key(&token)
        .get("/api/projects")
        .expect(401, "the old token");
    // Signing out twice, or without a session, is harmless.
    w.viewer.logout();
    w.server.remote("nobody").logout();
    assert!(w.viewer.get_json("/api/auth/state")["user"].is_null());
    w.viewer.login("viewer", PASSWORD).expect(200, "back in");
}

#[test]
fn wrong_passwords_are_refused_then_slowed_down() {
    let w = World::new();
    let c = w.server.remote("guesser");
    let wrong = c.login("operator", "not-the-password");
    wrong.expect(401, "wrong password");
    let unknown = c.login("nobody", "not-the-password");
    unknown.expect(401, "unknown user");
    assert_eq!(wrong.text(), unknown.text(), "the same answer for both");
    // Five tries, then the next waits.
    for _ in 0..4 {
        c.login("operator", "still-wrong").expect(401, "wrong");
    }
    let r = c.login("operator", "still-wrong");
    r.expect(429, "too many tries");
    assert!(r.text().contains("too many tries"), "{}", r.text());
    c.login("operator", PASSWORD)
        .expect(429, "even the right password waits");
    // The account is not locked for the others.
    w.operator
        .get("/api/projects")
        .expect(200, "the operator's session");
    let other = w.server.remote("colleague");
    other.login("viewer", PASSWORD).expect(200, "another user");
    // After the wait, the right password gets in.
    eventually(Duration::from_secs(10), "the wait to end", || {
        let r = c.login("operator", PASSWORD);
        assert!(r.status == 200 || r.status == 429, "{}", r.text());
        (r.status == 200).then_some(())
    });
    assert_eq!(c.whoami().as_deref(), Some("operator"));
}

#[test]
fn pages_of_other_sites_cannot_act_with_a_session() {
    let w = World::new();
    let d = &w.designer;
    let count = |c: &Client| c.get_json("/api/projects").as_array().unwrap().len();
    let before = count(d);
    d.set_origin(Some("http://evil.example"));
    let r = d.post("/api/projects", json!({ "name": "Planted" }));
    r.expect(403, "a page of another site");
    assert!(r.text().contains("another site"), "{}", r.text());
    d.set_origin(Some("null"));
    d.post("/api/projects", json!({ "name": "Planted" }))
        .expect(403, "a sandboxed page");
    // Another port of the same machine is another site.
    d.set_origin(Some(&format!("http://{REMOTE_HOST}:1")));
    d.post("/api/projects", json!({ "name": "Planted" }))
        .expect(403, "another port");
    // The browser says so itself.
    d.set_origin(None);
    let r = d
        .try_request(
            "POST",
            "/api/projects/import",
            Some((b"{}", "application/json")),
            &[("Sec-Fetch-Site", "cross-site")],
        )
        .unwrap();
    r.expect(403, "Sec-Fetch-Site: cross-site");
    // Reading is not changing.
    d.set_origin(Some("http://evil.example"));
    d.get("/api/projects").expect(200, "a read");
    d.set_origin(Some(&format!("http://{REMOTE_HOST}:{}", w.server.port)));
    assert_eq!(count(d), before, "nothing was created");

    // The web app itself, and automation without a browser, pass.
    d.post("/api/projects", json!({ "name": "Real" }))
        .expect(200, "same site");
    let key = w
        .admin
        .post(
            "/api/keys",
            json!({ "name": "Script", "userId": w.id("designer") }),
        )
        .json()["secret"]
        .as_str()
        .unwrap()
        .to_string();
    let script = d.with_key(&key);
    script.set_origin(Some("http://evil.example"));
    script
        .post("/api/projects", json!({ "name": "By key" }))
        .expect(200, "an API key is not a cookie");
}

#[test]
fn the_machine_of_the_server_is_not_a_user() {
    let w = World::new();
    // The tray app on the server reads its status without an account.
    let tray = w.server.local();
    let r = tray.get("/api/system/tray");
    r.expect(200, "tray on the server");
    assert!(r.json()["version"].is_string());
    // From another computer: nobody, admins included.
    w.admin
        .get("/api/system/tray")
        .expect(403, "tray from another computer");
    // A name that only leads to the machine is not the machine.
    let rebound = w.server.with_host("evil.example", "rebinding");
    rebound.get("/api/system/tray").expect(403, "DNS rebinding");
}

fn playlists(p: &Value) -> Vec<String> {
    p["playlists"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_str().unwrap().to_string())
        .collect()
}

fn items(p: &Value) -> Vec<String> {
    p["rundown"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_personal_playlist_is_seen_by_its_owner_and_the_admins_only() {
    let w = World::new();
    create_user(&w.admin, "operator2", "operator", json!({}));
    let a = &w.operator;
    let b = browser(&w.server, "operator2");
    let pid = &w.show.project;
    let path = format!("/api/projects/{pid}");

    // A makes a personal playlist ("owner": theirs, whatever was sent).
    a.put(
        &format!("{path}/playlists"),
        json!([{ "id": "main", "name": "Main" },
               { "id": "mine", "name": "My cues", "owner": "someone-else" }]),
    )
    .expect(204, "a personal playlist");
    let mut rundown = a.get_json(&path)["rundown"].as_array().unwrap().clone();
    rundown.push(
        json!({ "id": "secret", "name": "Secret cue", "templateId": w.show.template,
                         "playlist": "mine", "data": { "name": "Surprise guest" } }),
    );
    a.put(&format!("{path}/rundown"), json!(rundown))
        .expect(204, "A's rundown");
    let seen_by_a = a.get_json(&path);
    assert_eq!(playlists(&seen_by_a), ["main", "mine"]);
    let own = &seen_by_a["playlists"][1];
    assert_eq!(own["owner"], w.id("operator"), "the owner is A");
    assert!(items(&seen_by_a).contains(&"secret".to_string()));

    // B, the viewer, a designer: neither the playlist nor its graphics.
    for other in [&b, &w.viewer, &w.designer] {
        let p = other.get_json(&path);
        assert_eq!(playlists(&p), ["main"]);
        assert!(!items(&p).contains(&"secret".to_string()));
        let export = other.get(&format!("{path}/export"));
        assert!(!export.text().contains("Surprise guest"), "export");
    }
    // The admins see everything.
    assert_eq!(playlists(&w.admin.get_json(&path)), ["main", "mine"]);
    // Automation sees the shared rundown only.
    let status = w.viewer.get_json("/api/v1/status");
    assert!(!status.to_string().contains("Secret cue"), "{status}");

    // B rewrites the rundown and the playlists: A's stay as they are.
    let mut theirs = b.get_json(&path)["rundown"].as_array().unwrap().clone();
    theirs.push(
        json!({ "id": "b1", "name": "B's", "templateId": w.show.template,
                        "playlist": "main", "data": {} }),
    );
    b.put(&format!("{path}/rundown"), json!(theirs))
        .expect(204, "B's rundown");
    b.put(
        &format!("{path}/playlists"),
        json!([{ "id": "main", "name": "Main" }, { "id": "sport", "name": "Sport" }]),
    )
    .expect(204, "B's playlists");
    let all = w.admin.get_json(&path);
    assert_eq!(playlists(&all), ["main", "sport", "mine"]);
    let ids = items(&all);
    assert!(
        ids.contains(&"secret".into()) && ids.contains(&"b1".into()),
        "{ids:?}"
    );
    // B cannot touch A's, not even by its id.
    b.put(
        &format!("{path}/playlists"),
        json!([{ "id": "main", "name": "Main" }, { "id": "mine", "name": "Taken", "owner": "x" }]),
    )
    .expect(403, "another's personal playlist");
    b.put(
        &format!("{path}/rundown"),
        json!([{ "id": "sneak", "name": "Sneak", "templateId": w.show.template,
                 "playlist": "mine", "data": {} }]),
    )
    .expect(204, "a graphic for A's list is dropped");
    let all = w.admin.get_json(&path);
    assert!(
        !items(&all).contains(&"sneak".into()),
        "not put in A's list"
    );
    assert!(items(&all).contains(&"secret".into()), "A's graphic stays");
    // A duplicate made by a designer leaves A's list out.
    let r = w
        .designer
        .post("/api/projects", json!({ "name": "Copy", "from": pid }));
    r.expect(200, "duplicate");
    let copy = w.admin.get_json(&format!(
        "/api/projects/{}",
        r.json()["id"].as_str().unwrap()
    ));
    assert!(!copy.to_string().contains("Surprise guest"), "{copy}");
    // A shared playlist stays shared.
    b.put(
        &format!("{path}/playlists"),
        json!([{ "id": "main", "name": "Main", "owner": "me" }, { "id": "sport", "name": "Sport" }]),
    )
    .expect(400, "a shared playlist made personal");
    // A shares theirs: everyone sees it.
    a.put(
        &format!("{path}/playlists"),
        json!([{ "id": "main", "name": "Main" }, { "id": "sport", "name": "Sport" },
               { "id": "mine", "name": "Cues for all" }]),
    )
    .expect(204, "shared");
    let p = b.get_json(&path);
    assert!(playlists(&p).contains(&"mine".into()));
    assert!(items(&p).contains(&"secret".into()));
}
