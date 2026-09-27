//! Expense Wise desktop shell.
//!
//! The desktop app is a native window around the Expense Wise web app: the
//! ledger, API and database stay on the server. On launch the bundled connect
//! page (`src/index.html`) checks the saved server address and navigates the
//! window to it; the web app then runs exactly as it does in a browser, so
//! session cookies stay first-party to that origin.

use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager, Runtime, Url, Webview,
};

/// First-run server address. Override at build time with
/// `EXPENSEWISE_SERVER_URL=https://books.example.com pnpm desktop:build`.
const DEFAULT_SERVER_URL: &str = match option_env!("EXPENSEWISE_SERVER_URL") {
    Some(url) => url,
    None => "http://localhost:3100",
};

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    server_url: Option<String>,
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings<R: Runtime>(app: &AppHandle<R>) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_settings<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

/// Accepts `books.example.com` or a full URL; only http(s) servers.
fn parse_server_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    let candidate = if input.contains("://") { input.to_string() } else { format!("http://{input}") };
    let url = Url::parse(&candidate).map_err(|_| "That doesn't look like a server address.".to_string())?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        _ => Err("Use an http:// or https:// address.".to_string()),
    }
}

/// The bundled connect page, as the webview addresses it on this platform.
fn connect_page_url(query: &str) -> Url {
    let base = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    let mut url = Url::parse(base).expect("static url");
    url.set_query(Some(query));
    url
}

/// Only the bundled page may drive these commands, never the remote web app.
fn ensure_local<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    let local = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
    if local { Ok(()) } else { Err("Not allowed from this page.".to_string()) }
}

#[tauri::command]
fn get_server_url<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Result<String, String> {
    ensure_local(&webview)?;
    Ok(load_settings(&app).server_url.unwrap_or_else(|| DEFAULT_SERVER_URL.to_string()))
}

#[tauri::command]
fn connect<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, url: String) -> Result<(), String> {
    ensure_local(&webview)?;
    let url = parse_server_url(&url)?;
    let origin = url.origin().ascii_serialization();
    save_settings(&app, &Settings { server_url: Some(origin) })?;
    webview.navigate(url).map_err(|e| e.to_string())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let change = MenuItem::with_id(app, "change-server", "Change server…", true, None::<&str>)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit"))?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&reload, &change, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&file, &edit])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else { return };
            match event.id().as_ref() {
                "reload" => {
                    let _ = window.eval("window.location.reload()");
                }
                "change-server" => {
                    let _ = window.navigate(connect_page_url("change=1"));
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![get_server_url, connect])
        .run(tauri::generate_context!())
        .expect("error while running Expense Wise");
}
