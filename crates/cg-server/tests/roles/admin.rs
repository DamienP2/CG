//! The admin: first sign-in, accounts and their rights, channels and
//! settings, production stations, API keys.

use std::time::Duration;

use serde_json::{json, Value};

use crate::common::*;

/// The admin's user record as sent back to edit it (no password: kept).
fn edit(u: &Value) -> Value {
    json!({
        "username": u["username"],
        "displayName": u["displayName"],
        "role": u["role"],
        "projects": u["projects"],
        "channels": u["channels"],
        "disabled": u["disabled"],
    })
}

fn user(admin: &Client, username: &str) -> Value {
    admin
        .get_json("/api/users")
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["username"] == username)
        .cloned()
        .unwrap_or_else(|| panic!("no user {username}"))
}

#[test]
fn the_first_admin_is_created_on_the_server_itself_only() {
    let server = Server::start();
    let remote = server.remote("stranger");
    let st = remote.get_json("/api/auth/state");
    assert_eq!(st["needsSetup"], true);
    assert!(st["user"].is_null());
    // Nothing without signing in.
    remote.get("/api/projects").expect(401, "anonymous");
    remote
        .post("/api/projects", json!({ "name": "x" }))
        .expect(401, "anonymous write");
    // From another computer: refused, even before anyone exists.
    remote
        .post(
            "/api/auth/setup",
            json!({ "username": "boss", "password": PASSWORD }),
        )
        .expect(403, "setup from another computer");
    // A site whose name leads to this machine is not the machine either.
    let local = server.local();
    local.set_origin(Some("http://evil.example"));
    local
        .post(
            "/api/auth/setup",
            json!({ "username": "boss", "password": PASSWORD }),
        )
        .expect(403, "setup from a page of another site");
    local.set_origin(Some(&format!("http://127.0.0.1:{}", server.port)));
    local
        .post(
            "/api/auth/setup",
            json!({ "username": "boss", "password": "short" }),
        )
        .expect(400, "a password of 8 characters at least");
    let r = local.post(
        "/api/auth/setup",
        json!({ "username": "boss", "password": PASSWORD, "displayName": "The Boss" }),
    );
    r.expect(200, "setup on the server");
    assert_eq!(r.json()["user"]["role"], "admin");
    assert!(local.cookie("cg_session").is_some(), "signed in at once");
    assert_eq!(local.whoami().as_deref(), Some("boss"));
    // Only once.
    server
        .local()
        .post(
            "/api/auth/setup",
            json!({ "username": "second", "password": PASSWORD }),
        )
        .expect(409, "a second first admin");
    assert_eq!(remote.get_json("/api/health")["needsSetup"], false);
    assert_eq!(remote.get_json("/api/auth/state")["needsSetup"], false);
    // The admin signs in from anywhere then.
    remote.login("boss", PASSWORD).expect(200, "remote login");
    assert_eq!(remote.whoami().as_deref(), Some("boss"));
}

/// `strata-server user …` works on the data of a running server.
#[test]
fn the_command_line_sees_and_changes_the_accounts_of_a_running_server() {
    let w = World::new();
    let cli = |args: &[&str]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_strata-server"))
            .arg("user")
            .args(args)
            .arg("--data-dir")
            .arg(w.server.data_dir())
            .env_remove("CG_DATA_DIR")
            .output()
            .expect("run the command line");
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned()
                + &String::from_utf8_lossy(&out.stderr),
        )
    };
    let (ok, list) = cli(&["list"]);
    assert!(ok, "{list}");
    for name in ["admin", "designer", "operator", "viewer"] {
        assert!(list.contains(name), "{name} listed: {list}");
    }
    // Deleted from the command line: the running server lets them go.
    let (ok, out) = cli(&["delete", "viewer"]);
    assert!(ok, "{out}");
    eventually(Duration::from_secs(10), "the session to end", || {
        (w.viewer.get("/api/projects").status == 401).then_some(())
    });
    w.server
        .remote("viewer")
        .login("viewer", PASSWORD)
        .expect(401, "deleted account");
    assert!(w
        .admin
        .get_json("/api/users")
        .as_array()
        .unwrap()
        .iter()
        .all(|u| u["username"] != "viewer"));
    // Never the last admin.
    let (ok, out) = cli(&["delete", "admin"]);
    assert!(!ok, "the last admin cannot go: {out}");
    w.admin.get("/api/users").expect(200, "admin still there");
}

#[test]
fn the_admin_manages_accounts_and_their_rights_apply_at_once() {
    let w = World::new();
    let users = w.admin.get_json("/api/users");
    let roles: Vec<(String, String)> = users
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            (
                u["username"].as_str().unwrap().to_string(),
                u["role"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    for r in ROLES {
        assert!(roles.contains(&(r.to_string(), r.to_string())), "{roles:?}");
    }
    // No password hashes sent.
    assert!(!users.to_string().contains("argon2"), "{users}");
    // Names are unique (whatever the case); passwords long enough; names simple.
    w.admin
        .post(
            "/api/users",
            json!({ "username": "Designer", "password": PASSWORD, "role": "viewer" }),
        )
        .expect(400, "duplicate name");
    w.admin
        .post(
            "/api/users",
            json!({ "username": "shorty", "password": "1234567", "role": "viewer" }),
        )
        .expect(400, "short password");
    w.admin
        .post(
            "/api/users",
            json!({ "username": "two words", "password": PASSWORD, "role": "viewer" }),
        )
        .expect(400, "a name with a space");
    w.admin
        .post(
            "/api/users",
            json!({ "username": "chief", "password": PASSWORD, "role": "superuser" }),
        )
        .expect(422, "unknown role");

    // An operator made a designer: the same session gets the new rights.
    w.operator
        .post("/api/projects", json!({ "name": "Mine" }))
        .expect(403, "operators do not create projects");
    let mut op = edit(&user(&w.admin, "operator"));
    op["role"] = json!("designer");
    op["displayName"] = json!("Olivia (designer now)");
    let r = w
        .admin
        .put(&format!("/api/users/{}", w.id("operator")), op.clone());
    r.expect(200, "promote");
    assert_eq!(r.json()["role"], "designer");
    assert_eq!(w.operator.whoami().as_deref(), Some("operator"));
    w.operator
        .post("/api/projects", json!({ "name": "Mine" }))
        .expect(200, "promoted, same session");
    assert_eq!(
        user(&w.admin, "operator")["displayName"],
        "Olivia (designer now)"
    );
    // And back to viewer: refused at once.
    op["role"] = json!("viewer");
    w.admin
        .put(&format!("/api/users/{}", w.id("operator")), op)
        .expect(200, "demote");
    w.operator
        .put(
            &format!("/api/projects/{}/rundown", w.show.project),
            json!([]),
        )
        .expect(403, "a viewer now");

    // The only active admin stays one, and stays.
    let me = user(&w.admin, "admin");
    let mut demoted = edit(&me);
    demoted["role"] = json!("designer");
    w.admin
        .put(&format!("/api/users/{}", w.id("admin")), demoted)
        .expect(400, "the last admin demoted");
    let mut off = edit(&me);
    off["disabled"] = json!(true);
    w.admin
        .put(&format!("/api/users/{}", w.id("admin")), off)
        .expect(400, "the last admin disabled");
    w.admin
        .delete(&format!("/api/users/{}", w.id("admin")))
        .expect(400, "deleting oneself");
    w.admin.get("/api/users").expect(200, "still admin");

    // A second admin: then the first may step down.
    create_user(&w.admin, "deputy", "admin", json!({}));
    let deputy = browser(&w.server, "deputy");
    let mut down = edit(&me);
    down["role"] = json!("designer");
    deputy
        .put(&format!("/api/users/{}", w.id("admin")), down)
        .expect(200, "another admin demotes the first");
    w.admin.get("/api/users").expect(403, "no longer an admin");

    // A deleted account: its session and keys end with it.
    let key = w
        .designer
        .post("/api/keys", json!({ "name": "Stream Deck" }))
        .json()["secret"]
        .as_str()
        .unwrap()
        .to_string();
    let deck = w.designer.with_key(&key);
    deck.get("/api/projects").expect(200, "the key works");
    deputy
        .delete(&format!("/api/users/{}", w.id("designer")))
        .expect(204, "delete the designer");
    w.designer.get("/api/projects").expect(401, "session ended");
    deck.get("/api/projects").expect(401, "key ended");
    assert!(deputy
        .get_json("/api/keys")
        .as_array()
        .unwrap()
        .iter()
        .all(|k| k["userId"] != w.id("designer")));
    w.server
        .remote("designer")
        .login("designer", PASSWORD)
        .expect(401, "deleted");
}

#[test]
fn disabling_an_account_or_changing_its_password_signs_it_out_everywhere() {
    let w = World::new();
    let key = w
        .operator
        .post("/api/keys", json!({ "name": "Companion" }))
        .json()["secret"]
        .as_str()
        .unwrap()
        .to_string();
    let deck = w.operator.with_key(&key);
    deck.get("/api/channels").expect(200, "the key works");

    let mut u = edit(&user(&w.admin, "operator"));
    u["disabled"] = json!(true);
    w.admin
        .put(&format!("/api/users/{}", w.id("operator")), u.clone())
        .expect(200, "disable");
    w.operator.get("/api/projects").expect(401, "session ended");
    assert!(w.operator.whoami().is_none());
    deck.get("/api/channels")
        .expect(401, "a disabled account's key");
    let again = w.server.remote("operator");
    again
        .login("operator", PASSWORD)
        .expect(401, "disabled account");
    assert!(user(&w.admin, "operator")["disabled"] == true);

    u["disabled"] = json!(false);
    w.admin
        .put(&format!("/api/users/{}", w.id("operator")), u.clone())
        .expect(200, "enable");
    again.login("operator", PASSWORD).expect(200, "enabled");
    deck.get("/api/channels").expect(200, "the key again");

    // A new password: the sessions end, the old password no longer works.
    u["password"] = json!("another-password-2");
    w.admin
        .put(&format!("/api/users/{}", w.id("operator")), u)
        .expect(200, "new password");
    again.get("/api/projects").expect(401, "signed out");
    let other = w.server.remote("operator");
    other
        .login("operator", PASSWORD)
        .expect(401, "old password");
    other
        .login("operator", "another-password-2")
        .expect(200, "new password");
}

/// The channel list is in the settings: an admin adds, renames and removes
/// channels (the engine restarts with them; sessions go on).
#[test]
fn the_admin_creates_renames_and_deletes_channels() {
    let w = World::new();
    let system = w.admin.get_json("/api/system");
    let mut config = system["config"].clone();
    assert!(config.is_object(), "the admin sees the settings");
    assert_eq!(config["channels"].as_array().unwrap().len(), 1);
    assert!(
        w.designer.get_json("/api/system")["config"].is_null(),
        "only admins see the settings"
    );

    let mut studio = config["channels"][0].clone();
    studio["id"] = json!("studio-b");
    studio["name"] = json!("Studio B");
    studio["outputs"] = json!({});
    studio["projectId"] = Value::Null;
    config["channels"][0]["name"] = json!("Main studio");
    config["channels"].as_array_mut().unwrap().push(studio);
    config["name"] = json!("Newsroom");
    w.designer
        .put("/api/system/config", config.clone())
        .expect(403, "a designer changes the settings");
    w.admin
        .put("/api/system/config", config.clone())
        .expect(202, "save the settings");

    let channels = |c: &Client| -> Option<Vec<(String, String)>> {
        let r = c.try_request("GET", "/api/channels", None, &[])?;
        (r.status == 200).then(|| {
            r.json()
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    (
                        c["id"].as_str().unwrap().to_string(),
                        c["name"].as_str().unwrap().to_string(),
                    )
                })
                .collect()
        })
    };
    let after = eventually(Duration::from_secs(30), "the new channel", || {
        channels(&w.admin).filter(|l| l.len() == 2)
    });
    assert!(
        after.contains(&("main".into(), "Main studio".into())),
        "{after:?}"
    );
    assert!(
        after.contains(&("studio-b".into(), "Studio B".into())),
        "{after:?}"
    );
    // The other people are still signed in, and see the channel too.
    assert_eq!(channels(&w.viewer).map(|l| l.len()), Some(2));
    assert_eq!(
        w.viewer.get_json("/api/auth/state")["serverName"],
        "Newsroom"
    );
    w.viewer
        .get("/api/channels/studio-b/state")
        .expect(200, "the new channel's state");

    // An operator for Studio B only.
    let mut u = edit(&user(&w.admin, "operator"));
    u["channels"] = json!(["studio-b"]);
    w.admin
        .put(&format!("/api/users/{}", w.id("operator")), u)
        .expect(200, "scope");
    assert_eq!(
        channels(&w.operator),
        Some(vec![("studio-b".into(), "Studio B".into())])
    );
    w.operator
        .get("/api/channels/main/state")
        .expect(404, "a channel out of scope");

    // Removed again.
    let mut config = w.admin.get_json("/api/system")["config"].clone();
    config["channels"]
        .as_array_mut()
        .unwrap()
        .retain(|c| c["id"] != "studio-b");
    w.admin
        .put("/api/system/config", config)
        .expect(202, "remove the channel");
    let after = eventually(Duration::from_secs(30), "the channel gone", || {
        channels(&w.admin).filter(|l| l.len() == 1)
    });
    assert_eq!(after[0].0, "main");
    w.admin
        .get("/api/channels/studio-b/state")
        .expect(404, "gone");
    assert_eq!(channels(&w.operator), Some(vec![]));
}

#[test]
fn production_stations_are_declared_renamed_and_removed_by_an_admin() {
    let w = World::new();
    // The admin's browser in the gallery becomes a station.
    assert!(w.admin.get_json("/api/station")["station"].is_null());
    let (sid, secret) = declare_station(&w.admin, "Gallery 1");
    assert_eq!(
        w.admin.get_json("/api/station")["station"]["name"],
        "Gallery 1"
    );
    let list = w.admin.get_json("/api/stations");
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], sid.as_str());
    assert!(list[0]["lastSeen"].is_number(), "seen: {list}");
    // Never the secret in the list, nor on disk.
    assert!(!list.to_string().contains(&secret));
    let file = std::fs::read_to_string(w.server.data_dir().join("stations.json")).unwrap();
    assert!(!file.contains(&secret));
    w.admin
        .post("/api/stations", json!({ "name": "Again" }))
        .expect(400, "already a station");
    w.admin
        .post("/api/stations", json!({ "name": "   " }))
        .expect(400, "a name is needed");
    w.admin
        .put(
            &format!("/api/stations/{sid}"),
            json!({ "name": "Gallery A" }),
        )
        .expect(204, "rename");
    assert_eq!(w.admin.get_json("/api/stations")[0]["name"], "Gallery A");
    w.admin
        .put("/api/stations/nope", json!({ "name": "X" }))
        .expect(404, "unknown station");

    // The operator signs in on that computer: on air from there only.
    w.admin.logout();
    let gallery = &w.admin;
    gallery
        .login("operator", PASSWORD)
        .expect(200, "operator at the station");
    assert_eq!(
        gallery.get_json("/api/station")["station"]["name"],
        "Gallery A"
    );
    gallery
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "load on air from the station");
    // One computer at a time: their session on their own computer ended.
    w.operator
        .get("/api/projects")
        .expect(401, "the operator's other session");
    // Elsewhere, no going on air (a designer at their desk).
    assert!(w.designer.get_json("/api/station")["station"].is_null());
    w.designer
        .put("/api/channels/main/project", json!({ "projectId": null }))
        .expect(403, "not from a desk");
    // A secret guessed is nothing.
    at_station(&w.designer, "0123456789abcdef", || {
        w.designer
            .put("/api/channels/main/project", json!({ "projectId": null }))
            .expect(403, "a wrong station secret");
    });
    assert_eq!(
        w.admin.get_json("/api/channels/main/state")["layers"],
        json!({}),
        "nothing changed on air"
    );

    // The admin removes it from another computer: the gallery is a station no more.
    let office = w.server.remote("admin-office");
    office.login("admin", PASSWORD).expect(200, "admin login");
    office
        .delete(&format!("/api/stations/{sid}"))
        .expect(204, "remove");
    assert!(office
        .get_json("/api/stations")
        .as_array()
        .unwrap()
        .is_empty());
    assert!(gallery.get_json("/api/station")["station"].is_null());
    gallery
        .put("/api/channels/main/project", json!({ "projectId": null }))
        .expect(403, "no longer a station");
    office
        .delete(&format!("/api/stations/{sid}"))
        .expect(404, "already removed");

    // Removed from the station itself: its browser forgets the secret too.
    let (sid2, _) = declare_station(&office, "Truck");
    assert!(office.cookie("cg_station").is_some());
    office
        .delete(&format!("/api/stations/{sid2}"))
        .expect(204, "remove from the station itself");
    assert!(office.cookie("cg_station").is_none(), "cookie cleared");
}

#[test]
fn api_keys_act_with_their_owners_rights() {
    let w = World::new();
    // Each person (but viewers) makes keys for their control surfaces.
    let r = w
        .operator
        .post("/api/keys", json!({ "name": "Stream Deck" }));
    r.expect(200, "operator key");
    let secret = r.json()["secret"].as_str().unwrap().to_string();
    let kid = r.json()["key"]["id"].as_str().unwrap().to_string();
    assert!(secret.starts_with("pcg_"), "{secret}");
    assert!(secret.starts_with(r.json()["key"]["prefix"].as_str().unwrap()));
    w.viewer
        .post("/api/keys", json!({ "name": "Mine" }))
        .expect(403, "viewers have no keys");
    w.operator
        .post("/api/keys", json!({ "name": "   " }))
        .expect(400, "a key needs a name");
    // Who sees which keys.
    let mine = w.operator.get_json("/api/keys");
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert!(
        !mine.to_string().contains(&secret),
        "never the secret again"
    );
    assert!(w
        .designer
        .get_json("/api/keys")
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(w.admin.get_json("/api/keys").as_array().unwrap().len(), 1);

    // The key is the operator: rundown yes, design no, admin no.
    let deck = w.operator.with_key(&secret);
    deck.get("/api/projects").expect(200, "read with the key");
    deck.put(
        &format!("/api/projects/{}/rundown", w.show.project),
        w.admin
            .get_json(&format!("/api/projects/{}", w.show.project))["rundown"]
            .clone(),
    )
    .expect(204, "rundown with the key");
    deck.post("/api/projects", json!({ "name": "x" }))
        .expect(403, "the key creates no project");
    deck.get("/api/users").expect(403, "the key is no admin");
    // An automation is not a person at a computer: it goes on air without a
    // production station (and in another site's page, `?key=` works).
    declare_station(&w.admin, "Gallery");
    w.admin
        .put(
            "/api/channels/main/project",
            json!({ "projectId": w.show.project }),
        )
        .expect(204, "load the show");
    let r = deck.post_empty(&format!("/api/channels/main/items/{}/take", w.show.item));
    r.expect(200, "a take from the Stream Deck");
    assert_eq!(on_air(&r.json()).len(), 1);
    let anon = w.server.remote("embed");
    anon.set_origin(None);
    anon.get(&format!("/api/channels?key={secret}"))
        .expect(200, "key in the address");
    anon.get("/api/channels?key=pcg_wrong")
        .expect(401, "a wrong key");
    // What the as-run log says: the key's name, not the person.
    let asrun = w.admin.get_json("/api/asrun");
    assert!(
        asrun.to_string().contains("Stream Deck"),
        "as-run names the key: {asrun}"
    );

    // An admin makes one for a service account and can read it again with
    // their password.
    let r = w.admin.post(
        "/api/keys",
        json!({ "name": "Newsroom", "userId": w.id("viewer") }),
    );
    r.expect(200, "admin key for the viewer");
    let vkey = r.json()["key"]["id"].as_str().unwrap().to_string();
    let vsecret = r.json()["secret"].as_str().unwrap().to_string();
    w.admin
        .post(
            &format!("/api/keys/{vkey}/reveal"),
            json!({ "password": "wrong-password" }),
        )
        .expect(403, "wrong password");
    let shown = w.admin.post(
        &format!("/api/keys/{vkey}/reveal"),
        json!({ "password": PASSWORD }),
    );
    shown.expect(200, "reveal");
    assert_eq!(shown.json()["secret"], vsecret.as_str());
    w.viewer
        .with_key(&vsecret)
        .put(
            &format!("/api/projects/{}/rundown", w.show.project),
            json!([]),
        )
        .expect(403, "a viewer's key writes nothing");

    // Deleted: the key stops working.
    w.designer
        .delete(&format!("/api/keys/{kid}"))
        .expect(403, "another's key");
    w.operator
        .delete(&format!("/api/keys/{kid}"))
        .expect(204, "own key");
    deck.get("/api/projects").expect(401, "deleted key");
    w.operator
        .delete(&format!("/api/keys/{kid}"))
        .expect(404, "already deleted");

    // The API description is there for the tools.
    let spec = w.server.remote("anyone").get("/api/openapi.json");
    spec.expect(200, "openapi");
    assert!(spec.json()["openapi"].as_str().unwrap().starts_with("3."));
    assert!(spec.json()["paths"].as_object().unwrap().len() > 10);
}
