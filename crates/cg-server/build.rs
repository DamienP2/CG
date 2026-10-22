use std::path::Path;

fn main() {
    // The web app (web/dist) is embedded into the binary. Make sure the folder
    // exists so the server still compiles before `npm run build`; it then serves
    // a page explaining how to build the UI.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dist = dir.join("../../web/dist");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(&dist);
    }
    println!("cargo:rerun-if-changed=../../web/dist");
    examples(dir);
}

/// The example projects: every `examples/ex-*.json` is embedded, in name
/// order (src/examples.rs includes the list written here).
fn examples(dir: &Path) {
    let src = dir.join("examples");
    println!("cargo:rerun-if-changed=examples");
    let mut files: Vec<_> = std::fs::read_dir(&src)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    name.starts_with("ex-") && name.ends_with(".json")
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out = String::from("&[\n");
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
        out.push_str(&format!(
            "    include_str!({:?}),\n",
            f.display().to_string()
        ));
    }
    out.push_str("]\n");
    let dest = Path::new(&std::env::var("OUT_DIR").unwrap()).join("examples.rs");
    std::fs::write(dest, out).expect("examples list written");
}
