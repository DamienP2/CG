//! Route × role matrices: each allowed role gets a 2xx, every other a 403.
//! Each call prepares what it needs (as the admin) so an allowed call can
//! succeed; the refused roles are run first.

use serde_json::{json, Value};

use crate::common::*;

fn pid(w: &World) -> &str {
    &w.show.project
}

fn project(w: &World) -> Value {
    w.admin.get_json(&format!("/api/projects/{}", pid(w)))
}

/// A key of `owner`, made by the admin: its id.
fn key_of(w: &World, owner: &str) -> String {
    let r = w.admin.post(
        "/api/keys",
        json!({ "name": w.unique("key"), "userId": owner }),
    );
    r.expect(200, "admin makes a key");
    r.json()["key"]["id"].as_str().unwrap().to_string()
}

/// A station declared by the admin (from a browser that then forgets it).
fn station_id(w: &World) -> String {
    off_station(&w.admin, || {
        let r = w
            .admin
            .post("/api/stations", json!({ "name": w.unique("Desk ") }));
        r.expect(200, "declare a station");
        r.json()["id"].as_str().unwrap().to_string()
    })
}

/// A shared push data source made by the admin: its id.
fn push_source(w: &World) -> String {
    let r = w.admin.post(
        "/api/data/sources",
        json!({ "id": "", "name": w.unique("Scores "), "type": "push", "format": "json" }),
    );
    r.expect(200, "admin makes a data source");
    r.json()["id"].as_str().unwrap().to_string()
}

fn png() -> Vec<u8> {
    // A 1×1 PNG.
    vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]
}

/// Bytes that look like a TrueType font (its magic number).
fn font() -> Vec<u8> {
    let mut b = vec![0u8, 1, 0, 0];
    b.extend(std::iter::repeat_n(0u8, 60));
    b
}

#[test]
fn matrix_admin_only_routes() {
    let w = World::new();
    let rows = vec![
        row("GET /api/users", ADMIN, |_, c, _| c.get("/api/users")),
        row("POST /api/users", ADMIN, |w, c, _| {
            c.post(
                "/api/users",
                json!({ "username": w.unique("new"), "password": PASSWORD, "role": "viewer" }),
            )
        }),
        row("PUT /api/users/{id}", ADMIN, |w, c, _| {
            c.put(
                &format!("/api/users/{}", w.id("viewer")),
                json!({ "username": "viewer", "role": "viewer", "displayName": w.unique("Vic ") }),
            )
        }),
        row("DELETE /api/users/{id}", ADMIN, |w, c, role| {
            let id = if role == "admin" {
                create_user(&w.admin, &w.unique("leaving"), "viewer", json!({}))["id"]
                    .as_str()
                    .unwrap()
                    .to_string()
            } else {
                w.id("viewer").to_string()
            };
            c.delete(&format!("/api/users/{id}"))
        }),
        row("POST /api/keys (for another user)", ADMIN, |w, c, role| {
            let other = if role == "viewer" {
                "operator"
            } else {
                "viewer"
            };
            c.post(
                "/api/keys",
                json!({ "name": "service", "userId": w.id(other) }),
            )
        }),
        row(
            "DELETE /api/keys/{id} (another user's)",
            ADMIN,
            |w, c, role| {
                let other = if role == "viewer" {
                    "operator"
                } else {
                    "viewer"
                };
                let id = key_of(w, w.id(other));
                c.delete(&format!("/api/keys/{id}"))
            },
        ),
        row("POST /api/keys/{id}/reveal", ADMIN, |w, c, _| {
            let id = key_of(w, w.id("operator"));
            c.post(
                &format!("/api/keys/{id}/reveal"),
                json!({ "password": PASSWORD }),
            )
        }),
        row("GET /api/stations", ADMIN, |_, c, _| c.get("/api/stations")),
        row("POST /api/stations", ADMIN, |w, c, _| {
            off_station(c, || {
                c.post("/api/stations", json!({ "name": w.unique("Gallery ") }))
            })
        }),
        row("PUT /api/stations/{id}", ADMIN, |w, c, _| {
            let id = station_id(w);
            c.put(&format!("/api/stations/{id}"), json!({ "name": "Renamed" }))
        }),
        row("DELETE /api/stations/{id}", ADMIN, |w, c, _| {
            let id = station_id(w);
            c.delete(&format!("/api/stations/{id}"))
        }),
        row("GET /api/system/health", ADMIN, |_, c, _| {
            c.get("/api/system/health")
        }),
        row("GET /api/system/health/journal", ADMIN, |_, c, _| {
            c.get("/api/system/health/journal")
        }),
        row("POST /api/system/health/seen", ADMIN, |_, c, _| {
            c.post_empty("/api/system/health/seen")
        }),
        row("GET /api/system/logs", ADMIN, |_, c, _| {
            c.get("/api/system/logs")
        }),
        row("GET /api/system/time", ADMIN, |_, c, _| {
            c.get("/api/system/time")
        }),
        row("GET /api/hardware", ADMIN, |_, c, _| c.get("/api/hardware")),
        row("GET /api/security/tls", ADMIN, |_, c, _| {
            c.get("/api/security/tls")
        }),
        row("GET /api/system/update", ADMIN, |_, c, _| {
            c.get("/api/system/update")
        }),
        row("PUT /api/system/update/settings", ADMIN, |_, c, _| {
            c.put(
                "/api/system/update/settings",
                json!({ "repo": "example/strata", "autoCheck": false }),
            )
        }),
        row("GET /api/mos/status", ADMIN, |_, c, _| {
            c.get("/api/mos/status")
        }),
        // Allowed calls not made: they would change the machine, restart or
        // stop the server, or reach the Internet.
        refusals("PUT /api/system/config", ADMIN, |_, c, _| {
            c.put("/api/system/config", json!({}))
        }),
        refusals("POST /api/system/time/sync", ADMIN, |_, c, _| {
            c.post_empty("/api/system/time/sync")
        }),
        refusals("POST /api/security/tls/self-signed", ADMIN, |_, c, _| {
            c.post_empty("/api/security/tls/self-signed")
        }),
        refusals("POST /api/security/sso/test", ADMIN, |_, c, _| {
            c.post(
                "/api/security/sso/test",
                json!({ "issuer": "https://login.example.invalid" }),
            )
        }),
        refusals("POST /api/system/update/check", ADMIN, |_, c, _| {
            c.post_empty("/api/system/update/check")
        }),
        refusals("POST /api/system/update/install", ADMIN, |_, c, _| {
            c.post("/api/system/update/install", json!({}))
        }),
        refusals("POST /api/system/update/rollback", ADMIN, |_, c, _| {
            c.post_empty("/api/system/update/rollback")
        }),
        refusals("POST /api/system/restart", ADMIN, |_, c, _| {
            c.post_empty("/api/system/restart")
        }),
        refusals("POST /api/system/restart-server", ADMIN, |_, c, _| {
            c.post_empty("/api/system/restart-server")
        }),
        refusals("PUT /api/system/network", ADMIN, |_, c, _| {
            c.put("/api/system/network", json!({}))
        }),
        refusals("POST /api/iconlib/libraries/check", ADMIN, |_, c, _| {
            c.post_empty("/api/iconlib/libraries/check")
        }),
        // The server's own machine only (the tray app): nobody from another
        // computer, not even an admin.
        row("POST /api/system/stop (remote)", &[], |_, c, _| {
            c.post_empty("/api/system/stop")
        }),
        row("GET /api/system/tray (remote)", &[], |_, c, _| {
            c.get("/api/system/tray")
        }),
    ];
    run_matrix(&w, &rows);
}

#[test]
fn matrix_design_routes() {
    let w = World::new();
    let rows = vec![
        row("POST /api/projects", DESIGN, |w, c, _| {
            c.post("/api/projects", json!({ "name": w.unique("Show ") }))
        }),
        row("POST /api/examples/{id}", DESIGN, |_, c, _| {
            c.post_empty("/api/examples/ex-01-journal-televise")
        }),
        row("POST /api/projects/import", DESIGN, |w, c, _| {
            let p = w
                .admin
                .get_json(&format!("/api/projects/{}/export", pid(w)));
            c.post("/api/projects/import", p)
        }),
        row("PUT /api/projects/{id}", DESIGN, |w, c, _| {
            c.put(
                &format!("/api/projects/{}", pid(w)),
                json!({ "name": "Evening news", "width": 1920, "height": 1080,
                        "frameRate": { "num": 50, "den": 1 } }),
            )
        }),
        row("DELETE /api/projects/{id}", DESIGN, |w, c, _| {
            let id = create_project(&w.admin, &w.unique("Old show "));
            c.delete(&format!("/api/projects/{id}"))
        }),
        row(
            "PUT /api/projects/{id}/templates/{tid}",
            DESIGN,
            |w, c, _| {
                c.put(
                    &format!("/api/projects/{}/templates/{}", pid(w), w.show.template),
                    content_template(&w.show.template, "Lower third", &w.show.zone),
                )
            },
        ),
        row(
            "POST /api/projects/{id}/templates/{tid}/publish",
            DESIGN,
            |w, c, _| {
                c.post_empty(&format!(
                    "/api/projects/{}/templates/{}/publish",
                    pid(w),
                    w.show.template
                ))
            },
        ),
        row(
            "DELETE /api/projects/{id}/templates/{tid}/draft",
            DESIGN,
            |w, c, _| {
                w.admin
                    .put(
                        &format!("/api/projects/{}/templates/{}", pid(w), w.show.template),
                        content_template(&w.show.template, "Lower third v2", &w.show.zone),
                    )
                    .expect(204, "a draft");
                c.delete(&format!(
                    "/api/projects/{}/templates/{}/draft",
                    pid(w),
                    w.show.template
                ))
            },
        ),
        row(
            "DELETE /api/projects/{id}/templates/{tid}",
            DESIGN,
            |w, c, _| {
                let tid = w.unique("extra");
                w.admin
                    .put(
                        &format!("/api/projects/{}/templates/{tid}", pid(w)),
                        content_template(&tid, "Extra", &w.show.zone),
                    )
                    .expect(204, "another template");
                c.delete(&format!("/api/projects/{}/templates/{tid}", pid(w)))
            },
        ),
        row(
            "POST /api/projects/{id}/templates/{tid}/lock",
            DESIGN,
            |w, c, _| {
                let path = format!(
                    "/api/projects/{}/templates/{}/lock",
                    pid(w),
                    w.show.template
                );
                let r = c.post(&path, json!({}));
                if r.is_success() {
                    assert_eq!(r.json()["granted"], true, "{}", r.text());
                    c.delete(&path).expect(204, "unlock");
                }
                r
            },
        ),
        row("PUT /api/projects/{id}/zones", DESIGN, |w, c, _| {
            let zones = project(w)["zones"].clone();
            c.put(&format!("/api/projects/{}/zones", pid(w)), zones)
        }),
        row("PUT /api/projects/{id}/formats", DESIGN, |w, c, _| {
            c.put(&format!("/api/projects/{}/formats", pid(w)), json!([]))
        }),
        row("PUT /api/projects/{id}/guides", DESIGN, |w, c, _| {
            c.put(&format!("/api/projects/{}/guides", pid(w)), json!({}))
        }),
        row("PUT /api/projects/{id}/logic", DESIGN, |w, c, _| {
            c.put(&format!("/api/projects/{}/logic", pid(w)), json!({}))
        }),
        row("PUT /api/projects/{id}/design-order", DESIGN, |w, c, _| {
            c.put(
                &format!("/api/projects/{}/design-order", pid(w)),
                json!([w.show.template]),
            )
        }),
        row("POST /api/projects/{id}/publish", DESIGN, |w, c, _| {
            c.post_empty(&format!("/api/projects/{}/publish", pid(w)))
        }),
        row("POST /api/projects/{id}/versions", DESIGN, |w, c, _| {
            c.post(
                &format!("/api/projects/{}/versions", pid(w)),
                json!({ "note": "before the show" }),
            )
        }),
        row(
            "POST /api/projects/{id}/versions/{vid}/restore",
            DESIGN,
            |w, c, _| {
                let r = w.admin.post(
                    &format!("/api/projects/{}/versions", pid(w)),
                    json!({ "note": "kept" }),
                );
                r.expect(200, "a version");
                let vid = r.json()["id"].as_str().unwrap().to_string();
                c.post_empty(&format!("/api/projects/{}/versions/{vid}/restore", pid(w)))
            },
        ),
        row("PUT /api/projects/{id}/colors", DESIGN, |w, c, _| {
            c.put(
                &format!("/api/projects/{}/colors", pid(w)),
                json!({ "colors": [] }),
            )
        }),
        row("PUT /api/projects/{id}/logic-flows", DESIGN, |w, c, _| {
            c.put(
                &format!("/api/projects/{}/logic-flows", pid(w)),
                json!({ "flows": [] }),
            )
        }),
        row("PUT /api/colors", DESIGN, |_, c, _| {
            c.put("/api/colors", json!([]))
        }),
        row("PUT /api/logic-flows", DESIGN, |_, c, _| {
            c.put("/api/logic-flows", json!([]))
        }),
        row("PUT /api/folders", DESIGN, |_, c, _| {
            c.put(
                "/api/folders",
                json!({ "folders": ["Sport"], "assign": {} }),
            )
        }),
        row("POST /api/template-library", DESIGN, |w, c, _| {
            c.post(
                "/api/template-library",
                json!({ "project": pid(w), "template": w.show.template }),
            )
        }),
        row("DELETE /api/template-library/{id}", DESIGN, |w, c, _| {
            let r = w.admin.post(
                "/api/template-library",
                json!({ "project": pid(w), "template": w.show.template, "name": w.unique("Kept ") }),
            );
            r.expect(200, "a library entry");
            let id = r.json()["entry"]["id"].as_str().unwrap().to_string();
            c.delete(&format!("/api/template-library/{id}"))
        }),
        row("DELETE /api/media/{name}", DESIGN, |w, c, _| {
            let name = format!("{}.png", w.unique("shared"));
            w.admin
                .raw("PUT", &format!("/api/media/{name}"), &png(), "image/png")
                .expect(200, "upload");
            c.delete(&format!("/api/media/{name}"))
        }),
        row(
            "DELETE /api/projects/{id}/media/{name}",
            DESIGN,
            |w, c, _| {
                let name = format!("{}.png", w.unique("own"));
                let path = format!("/api/projects/{}/media/{name}", pid(w));
                w.admin
                    .raw("PUT", &path, &png(), "image/png")
                    .expect(200, "upload");
                c.delete(&path)
            },
        ),
        row("PUT /api/fonts/{name}", DESIGN, |w, c, _| {
            let name = format!("{}.ttf", w.unique("Brand"));
            let r = c.raw("PUT", &format!("/api/fonts/{name}"), &font(), "font/ttf");
            if r.is_success() {
                c.delete(&format!("/api/fonts/{name}"))
                    .expect(204, "remove the font");
            }
            r
        }),
        row("DELETE /api/fonts/{name}", DESIGN, |w, c, _| {
            let name = format!("{}.ttf", w.unique("Brand"));
            w.admin
                .raw("PUT", &format!("/api/fonts/{name}"), &font(), "font/ttf")
                .expect(200, "upload a font");
            let r = c.delete(&format!("/api/fonts/{name}"));
            if !r.is_success() {
                w.admin.delete(&format!("/api/fonts/{name}"));
            }
            r
        }),
        row("POST /api/data/sources (shared)", DESIGN, |w, c, _| {
            c.post(
                "/api/data/sources",
                json!({ "id": "", "name": w.unique("Feed "), "type": "push" }),
            )
        }),
        row("PUT /api/data/sources/{id}", DESIGN, |w, c, _| {
            let id = push_source(w);
            c.put(
                &format!("/api/data/sources/{id}"),
                json!({ "id": id, "name": "Renamed", "type": "push" }),
            )
        }),
        row("DELETE /api/data/sources/{id}", DESIGN, |w, c, _| {
            let id = push_source(w);
            c.delete(&format!("/api/data/sources/{id}"))
        }),
        row("POST /api/data/test", DESIGN, |_, c, _| {
            c.post(
                "/api/data/test",
                json!({ "id": "t", "name": "Try", "type": "push" }),
            )
        }),
        row("POST /api/import/analyze", DESIGN, |_, c, _| {
            let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="10" y="10" width="100" height="50" fill="#ff0000"/></svg>"##;
            c.raw(
                "POST",
                "/api/import/analyze?name=logo.svg",
                svg,
                "image/svg+xml",
            )
        }),
    ];
    run_matrix(&w, &rows);
}

#[test]
fn matrix_rundown_media_and_self_service_routes() {
    let w = World::new();
    let rows = vec![
        row("PUT /api/projects/{id}/rundown", OPERATE, |w, c, _| {
            let rundown = project(w)["rundown"].clone();
            c.put(&format!("/api/projects/{}/rundown", pid(w)), rundown)
        }),
        row("PUT /api/projects/{id}/playlists", OPERATE, |w, c, _| {
            c.put(
                &format!("/api/projects/{}/playlists", pid(w)),
                json!([{ "id": "main", "name": "Main" }]),
            )
        }),
        row(
            "PUT /api/projects/{id}/social/follow",
            OPERATE,
            |w, c, _| {
                c.put(
                    &format!("/api/projects/{}/social/follow", pid(w)),
                    json!({ "sources": [] }),
                )
            },
        ),
        row("POST /api/simulate", OPERATE, |w, c, _| {
            c.post(
                "/api/simulate",
                json!({ "channelId": "main", "projectId": pid(w) }),
            )
        }),
        row("PUT /api/assets/{name}", OPERATE, |w, c, _| {
            c.raw(
                "PUT",
                &format!("/api/assets/{}.png", w.unique("photo")),
                &png(),
                "image/png",
            )
        }),
        row("PUT /api/media/{name}", OPERATE, |w, c, _| {
            c.raw(
                "PUT",
                &format!("/api/media/{}.png", w.unique("photo")),
                &png(),
                "image/png",
            )
        }),
        row("PUT /api/projects/{id}/media/{name}", OPERATE, |w, c, _| {
            c.raw(
                "PUT",
                &format!("/api/projects/{}/media/{}.png", pid(w), w.unique("photo")),
                &png(),
                "image/png",
            )
        }),
        row("PUT /api/data/sources/{id}/value", OPERATE, |w, c, _| {
            let id = push_source(w);
            c.raw(
                "PUT",
                &format!("/api/data/sources/{id}/value"),
                br#"{"home": 2, "away": 1}"#,
                "application/json",
            )
        }),
        row("POST /api/keys (own)", ADMIN, |w, c, _| {
            c.post("/api/keys", json!({ "name": w.unique("Stream Deck ") }))
        }),
        refusals("POST /api/render", OPERATE, |w, c, _| {
            c.post(
                "/api/render",
                json!({ "projectId": pid(w), "templateId": w.show.template,
                        "width": 640, "height": 360, "frameRate": { "num": 25, "den": 1 } }),
            )
        }),
        // Everyone, for themselves.
        row("PUT /api/me/lang", EVERYONE, |_, c, _| {
            c.put("/api/me/lang", json!({ "lang": "en" }))
        }),
        row("PUT /api/me/theme", EVERYONE, |_, c, _| {
            c.put("/api/me/theme", json!({ "theme": "light" }))
        }),
        row("PUT /api/me/shortcuts", EVERYONE, |_, c, _| {
            c.put("/api/me/shortcuts", json!({ "bindings": null }))
        }),
        row("PATCH /api/me/display", EVERYONE, |_, c, _| {
            c.patch("/api/me/display", json!({ "rundownColumns": 3 }))
        }),
        row("DELETE /api/keys/{id} (own)", EVERYONE, |w, c, role| {
            let id = key_of(w, w.id(role));
            c.delete(&format!("/api/keys/{id}"))
        }),
        // A fetch may cost (paid services): not for viewers.
        row("POST /api/data/sources/{id}/refresh", OPERATE, |w, c, _| {
            let id = push_source(w);
            c.post_empty(&format!("/api/data/sources/{id}/refresh"))
        }),
        row(
            "DELETE /api/projects/{id}/templates/{tid}/lock (not held)",
            DESIGN,
            |w, c, _| {
                c.delete(&format!(
                    "/api/projects/{}/templates/{}/lock",
                    pid(w),
                    w.show.template
                ))
            },
        ),
    ];
    run_matrix(&w, &rows);
}

/// Who may go on air, from a production station.
#[test]
fn matrix_channel_routes_on_a_production_station() {
    let w = World::new();
    let (_, secret) = declare_station(&w.admin, "Gallery 1");
    let pid = w.show.project.clone();
    w.admin
        .put("/api/channels/main/project", json!({ "projectId": pid }))
        .expect(204, "load the show");
    // Every browser is on the station here.
    for role in ["designer", "operator", "viewer"] {
        w.client(role).set_cookie("cg_station", &secret);
    }
    let rows = vec![
        row("PUT /api/channels/{id}/project", OPERATE, |w, c, _| {
            c.put(
                "/api/channels/main/project",
                json!({ "projectId": w.show.project }),
            )
        }),
        row(
            "POST /api/channels/{id}/command (take)",
            OPERATE,
            |w, c, _| {
                c.post(
                    "/api/channels/main/command",
                    json!({ "action": "take", "templateId": w.show.template,
                        "data": { "name": "Breaking" } }),
                )
            },
        ),
        row(
            "POST /api/channels/{id}/command (clear)",
            OPERATE,
            |_, c, _| c.post("/api/channels/main/command", json!({ "action": "clear" })),
        ),
        row("POST /api/channels/{id}/undo", OPERATE, |w, c, role| {
            if role != "viewer" {
                c.post(
                    "/api/channels/main/command",
                    json!({ "action": "take", "templateId": w.show.template }),
                )
                .expect(200, "something to undo");
            }
            c.post_empty("/api/channels/main/undo")
        }),
        row(
            "POST /api/channels/{id}/items/{item}/take",
            OPERATE,
            |w, c, _| c.post_empty(&format!("/api/channels/main/items/{}/take", w.show.item)),
        ),
        row(
            "POST /api/channels/{id}/items/{item}/out",
            OPERATE,
            |w, c, _| c.post_empty(&format!("/api/channels/main/items/{}/out", w.show.item)),
        ),
        row(
            "PUT /api/channels/{id}/zones/{zone}/lock",
            OPERATE,
            |w, c, _| {
                let path = format!("/api/channels/main/zones/{}/lock", w.show.zone);
                let r = c.put(&path, json!({}));
                if r.is_success() {
                    c.delete(&path).expect(204, "free the zone");
                }
                r
            },
        ),
        row(
            "DELETE /api/channels/{id}/zones/{zone}/lock (own)",
            OPERATE,
            |w, c, role| {
                let path = format!("/api/channels/main/zones/{}/lock", w.show.zone);
                if role != "viewer" {
                    c.put(&path, json!({})).expect(204, "hold the zone");
                }
                c.delete(&path)
            },
        ),
        row(
            "DELETE /api/channels/{id}/zones/{zone}/lock (another's)",
            ADMIN,
            |w, c, role| {
                let path = format!("/api/channels/main/zones/{}/lock", w.show.zone);
                let holder = if role == "operator" {
                    &w.designer
                } else {
                    &w.operator
                };
                holder.put(&path, json!({})).expect(204, "hold the zone");
                let r = c.delete(&path);
                if !r.is_success() {
                    holder.delete(&path).expect(204, "free the zone");
                }
                r
            },
        ),
        row("POST /api/channels/{id}/schedule", OPERATE, |w, c, _| {
            c.post(
                "/api/channels/main/schedule",
                json!({ "action": "out", "zone": w.show.zone,
                        "when": { "kind": "in", "secs": 3600 } }),
            )
        }),
        row(
            "PATCH /api/channels/{id}/schedule/{sid}",
            OPERATE,
            |w, c, _| {
                let sid = scheduled(w);
                c.patch(
                    &format!("/api/channels/main/schedule/{sid}"),
                    json!({ "enabled": false }),
                )
            },
        ),
        row(
            "DELETE /api/channels/{id}/schedule/{sid}",
            OPERATE,
            |w, c, _| {
                let sid = scheduled(w);
                c.delete(&format!("/api/channels/main/schedule/{sid}"))
            },
        ),
        row("POST /api/v1/{channel}/take/{item}", OPERATE, |w, c, _| {
            c.post_empty(&format!("/api/v1/main/take/{}", w.show.item))
        }),
        row("POST /api/v1/{channel}/out", OPERATE, |_, c, _| {
            c.post_empty("/api/v1/main/out")
        }),
    ];
    // A take gives its zone to whoever took it: the next person would be
    // refused (409) until they take the zone over. Freed (by the admin)
    // before each call.
    run_matrix_with(&w, &rows, |w| {
        w.admin
            .delete(&format!("/api/channels/main/zones/{}/lock", w.show.zone))
            .expect(204, "the admin frees the zone");
    });
}

/// A take programmed in an hour, by the admin: its id.
fn scheduled(w: &World) -> String {
    let r = w.admin.post(
        "/api/channels/main/schedule",
        json!({ "action": "out", "zone": w.show.zone, "when": { "kind": "in", "secs": 3600 } }),
    );
    r.expect(201, "program an out");
    r.json()["id"].as_str().unwrap().to_string()
}

/// What every signed-in role reads (the program, the projects, the lists).
#[test]
fn matrix_reads_for_everyone() {
    let w = World::new();
    let rows = vec![
        row("GET /api/auth/state", EVERYONE, |_, c, _| {
            c.get("/api/auth/state")
        }),
        row("GET /api/projects", EVERYONE, |_, c, _| {
            c.get("/api/projects")
        }),
        row("GET /api/projects/{id}", EVERYONE, |w, c, _| {
            c.get(&format!("/api/projects/{}", pid(w)))
        }),
        row("GET /api/projects/{id}/export", EVERYONE, |w, c, _| {
            c.get(&format!("/api/projects/{}/export", pid(w)))
        }),
        row("GET /api/projects/{id}/locks", EVERYONE, |w, c, _| {
            c.get(&format!("/api/projects/{}/locks", pid(w)))
        }),
        row("GET /api/projects/{id}/versions", EVERYONE, |w, c, _| {
            c.get(&format!("/api/projects/{}/versions", pid(w)))
        }),
        row("GET /api/projects/{id}/media", EVERYONE, |w, c, _| {
            c.get(&format!("/api/projects/{}/media", pid(w)))
        }),
        row(
            "GET /api/projects/{id}/templates/{tid}/thumbnail.png",
            EVERYONE,
            |w, c, _| {
                c.get(&format!(
                    "/api/projects/{}/templates/{}/thumbnail.png?w=64",
                    pid(w),
                    w.show.template
                ))
            },
        ),
        row("GET /api/projects/{id}/social", EVERYONE, |w, c, _| {
            c.get(&format!("/api/projects/{}/social", pid(w)))
        }),
        row("GET /api/channels", EVERYONE, |_, c, _| {
            c.get("/api/channels")
        }),
        row("GET /api/channels/{id}/state", EVERYONE, |_, c, _| {
            c.get("/api/channels/main/state")
        }),
        row("GET /api/channels/{id}/preview.png", EVERYONE, |_, c, _| {
            c.get("/api/channels/main/preview.png")
        }),
        row("GET /api/channels/{id}/undo", EVERYONE, |_, c, _| {
            c.get("/api/channels/main/undo")
        }),
        row("GET /api/channels/{id}/locks", EVERYONE, |_, c, _| {
            c.get("/api/channels/main/locks")
        }),
        row("GET /api/channels/{id}/schedule", EVERYONE, |_, c, _| {
            c.get("/api/channels/main/schedule")
        }),
        row("GET /api/v1/status", EVERYONE, |_, c, _| {
            c.get("/api/v1/status")
        }),
        row("GET /api/v1/{channel}/status", EVERYONE, |_, c, _| {
            c.get("/api/v1/main/status")
        }),
        row("GET /api/examples", EVERYONE, |_, c, _| {
            c.get("/api/examples")
        }),
        row("GET /api/fonts", EVERYONE, |_, c, _| c.get("/api/fonts")),
        row("GET /api/assets", EVERYONE, |_, c, _| c.get("/api/assets")),
        row("GET /api/media", EVERYONE, |_, c, _| c.get("/api/media")),
        row("GET /api/colors", EVERYONE, |_, c, _| c.get("/api/colors")),
        row("GET /api/logic-flows", EVERYONE, |_, c, _| {
            c.get("/api/logic-flows")
        }),
        row("GET /api/folders", EVERYONE, |_, c, _| {
            c.get("/api/folders")
        }),
        row("GET /api/template-library", EVERYONE, |_, c, _| {
            c.get("/api/template-library")
        }),
        row("GET /api/data/sources", EVERYONE, |_, c, _| {
            c.get("/api/data/sources")
        }),
        row("GET /api/keys", EVERYONE, |_, c, _| c.get("/api/keys")),
        row("GET /api/me/shortcuts", EVERYONE, |_, c, _| {
            c.get("/api/me/shortcuts")
        }),
        row("GET /api/me/display", EVERYONE, |_, c, _| {
            c.get("/api/me/display")
        }),
        row("GET /api/system", EVERYONE, |_, c, _| c.get("/api/system")),
        row("GET /api/system/metrics", EVERYONE, |_, c, _| {
            c.get("/api/system/metrics")
        }),
        row("GET /api/asrun", EVERYONE, |_, c, _| c.get("/api/asrun")),
        row("GET /api/timecode", EVERYONE, |_, c, _| {
            c.get("/api/timecode")
        }),
        row("GET /api/outputs/status", EVERYONE, |_, c, _| {
            c.get("/api/outputs/status")
        }),
        row("GET /api/station", EVERYONE, |_, c, _| {
            c.get("/api/station")
        }),
        row("GET /api/openapi.json", EVERYONE, |_, c, _| {
            c.get("/api/openapi.json")
        }),
    ];
    run_matrix(&w, &rows);
}
