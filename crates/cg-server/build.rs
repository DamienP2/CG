// The web app (web/dist) is embedded into the binary. Make sure the folder
// exists so the server still compiles before `npm run build`; it then serves
// a page explaining how to build the UI.
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(&dist);
    }
    println!("cargo:rerun-if-changed=../../web/dist");
}
