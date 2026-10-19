#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod secrets;

use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::Deserialize;
use std::{fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Write}, path::Path, process::{Child, ChildStdin, Command, Stdio}, sync::{mpsc, Mutex}, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, webview::{Cookie, DownloadEvent, NewWindowResponse}};
use zeroize::Zeroizing;

struct Service { child: Child, _pipe: ChildStdin, _profile_lock: File }
impl Drop for Service { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }
struct Runtime(Mutex<Option<Service>>);
#[derive(Deserialize)] struct Ready { #[serde(rename = "desktopReady")] desktop_ready: u8, port: u16 }

fn random_hex(length: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; length];
    getrandom::fill(&mut bytes).map_err(|_| "Secure randomness unavailable.")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn start_service(profile: &Path) -> Result<(Service, u16, String, String), String> {
    fs::create_dir_all(profile).map_err(|_| "Cannot create your desktop profile.")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(profile, fs::Permissions::from_mode(0o700)).map_err(|_| "Cannot protect desktop profile permissions.")?;
    }
    let profile_lock = OpenOptions::new().create(true).read(true).write(true).open(profile.join("desktop.lock")).map_err(|_| "Cannot open desktop profile lock.")?;
    profile_lock.try_lock_exclusive().map_err(|_| "Civitai Studio is already using this desktop profile. Close the other window first.")?;
    let key = secrets::master_key(profile)?;
    let gate_name = format!("studio_desktop_{}", random_hex(16)?);
    let gate = Zeroizing::new(random_hex(32)?);
    let executable = std::env::current_exe().map_err(|_| "Cannot locate the desktop application.")?;
    let directory = executable.parent().ok_or("Cannot locate desktop service.")?;
    let sidecar_name = if cfg!(windows) { "studio-service.exe" } else { "studio-service" };
    let sidecar = directory.join(sidecar_name);
    if !sidecar.is_file() { return Err("Desktop service is missing. Extract the complete ZIP or reinstall the application; keep Studio and its service together.".into()); }
    let mut command = Command::new(sidecar);
    command.current_dir(directory).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    // The compiled runtime needs system plumbing only. Never inherit developer
    // provider credentials, proxy settings, runtime preloads or .env settings.
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "LC_ALL", "SSL_CERT_DIR"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|_| "Could not start the bundled desktop service. Re-extract the release and check your security software.")?;
    let pipe = child.stdin.take().ok_or("Desktop service bootstrap pipe unavailable.")?;
    let output = child.stdout.take().ok_or("Desktop service readiness pipe unavailable.")?;
    let mut service = Service { child, _pipe: pipe, _profile_lock: profile_lock };
    let config = serde_json::json!({ "dataDir": profile, "encryptionKey": STANDARD.encode(&*key), "gateName": gate_name, "gate": *gate });
    let mut bootstrap = Zeroizing::new(serde_json::to_vec(&config).map_err(|_| "Desktop bootstrap unavailable.")?);
    bootstrap.push(b'\n');
    service._pipe.write_all(&bootstrap).and_then(|_| service._pipe.flush()).map_err(|_| "Could not initialize the desktop service.")?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        // Drain later stdout, but never echo it or include bootstrap material in
        // a diagnostic log. Only the bounded, nonsecret readiness record counts.
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            if line.len() <= 256 { if let Ok(ready) = serde_json::from_str::<Ready>(&line) { let _ = send.send(ready); } }
        }
    });
    let ready = receive.recv_timeout(Duration::from_secs(30)).map_err(|_| "The local service did not become ready. Reopen Studio; if this persists, reinstall the release.")?;
    if ready.desktop_ready != 1 || ready.port == 0 { return Err("The desktop service returned an invalid startup response.".into()); }
    Ok((service, ready.port, gate_name, gate.to_string()))
}

fn external_link(url: &tauri::Url) {
    if url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none() { let _ = open::that(url.as_str()); }
}

fn launch(app: &tauri::AppHandle) -> Result<(), String> {
    let profile = app.path().app_local_data_dir().map_err(|_| "Cannot find your desktop data directory.")?.join("profile-v1");
    let (service, port, gate_name, gate) = start_service(&profile)?;
    *app.state::<Runtime>().0.lock().map_err(|_| "Desktop state unavailable.")? = Some(service);
    let origin = format!("http://127.0.0.1:{port}");
    let navigation_origin = origin.clone();
    let download_origin = origin.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Civitai Studio · 0.1.0-beta.1").inner_size(1440.0, 1000.0).min_inner_size(800.0, 600.0)
        .visible(false).data_directory(profile.join("webview"))
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" || url.origin().ascii_serialization() == navigation_origin { true }
            else { external_link(url); false }
        })
        .on_new_window(|url, _| { external_link(&url); NewWindowResponse::Deny })
        .on_download(move |_, event| {
            if let DownloadEvent::Requested { url, destination } = event {
                if url.origin().ascii_serialization() != download_origin && !url.as_str().starts_with(&format!("blob:{download_origin}/")) { return false; }
                let filename = destination.file_name().and_then(|name| name.to_str()).unwrap_or("civitai-download");
                if let Some(path) = rfd::FileDialog::new().set_file_name(filename).save_file() { *destination = path; true } else { false }
            } else { true }
        }).build().map_err(|_| "Cannot start the desktop webview. Install Microsoft Edge WebView2 Runtime on Windows, or check the platform prerequisites in START HERE.")?;
    let cookie = Cookie::build((gate_name, gate)).domain("127.0.0.1").path("/").http_only(true).same_site(cookie::SameSite::Strict).build();
    window.set_cookie(cookie).map_err(|_| "Cannot initialize the private desktop session.")?;
    window.navigate(origin.parse().unwrap()).map_err(|_| "Cannot open the local desktop workspace.")?;
    window.show().map_err(|_| "Cannot show the desktop window.")?;
    Ok(())
}

fn main() {
    tauri::Builder::default().manage(Runtime(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            // Native WebView operations run off event callbacks to avoid the
            // Windows WebView2 synchronous callback deadlock.
            std::thread::spawn(move || { if let Err(message) = launch(&handle) {
                rfd::MessageDialog::new().set_title("Civitai Studio could not start").set_description(&message).set_level(rfd::MessageLevel::Error).show();
                handle.exit(1);
            }});
            Ok(())
        })
        .build(tauri::generate_context!()).expect("Civitai Studio desktop initialization failed")
        .run(|app, event| { if matches!(event, tauri::RunEvent::Exit) { if let Ok(mut service) = app.state::<Runtime>().0.lock() { service.take(); } } });
}
