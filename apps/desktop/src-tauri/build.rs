fn main() {
    // Baked in as the first-run server address (see lib.rs).
    println!("cargo:rerun-if-env-changed=FINANCEOS_SERVER_URL");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["get_server_url", "connect"])),
    )
    .expect("failed to run tauri-build");
}
