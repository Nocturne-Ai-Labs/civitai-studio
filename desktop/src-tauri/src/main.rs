#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod secrets;
mod updates;

use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::Deserialize;
use std::{fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Write}, path::Path, process::{Child, ChildStdin, Command, Stdio}, sync::{mpsc, Mutex}, time::{Duration, Instant}};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, webview::{Cookie, DownloadEvent, NewWindowResponse}};
use zeroize::Zeroizing;

struct Service { child: Child, pipe: Option<ChildStdin>, _profile_lock: File }
impl Drop for Service { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }
struct Runtime(Mutex<Option<Service>>);
#[derive(Deserialize)] struct Ready { #[serde(rename = "desktopReady")] desktop_ready: u8, port: u16 }

fn random_hex(length: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; length];
    getrandom::fill(&mut bytes).map_err(|_| "Secure randomness unavailable.")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn start_service(app: &tauri::AppHandle, profile: &Path) -> Result<(Service, u16, String, String), String> {
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
    let mut service = Service { child, pipe: Some(pipe), _profile_lock: profile_lock };
    let config = serde_json::json!({ "dataDir": profile, "encryptionKey": STANDARD.encode(&*key), "gateName": gate_name, "gate": *gate, "updater": app.state::<updates::Updates>().snapshot() });
    let mut bootstrap = Zeroizing::new(serde_json::to_vec(&config).map_err(|_| "Desktop bootstrap unavailable.")?);
    bootstrap.push(b'\n');
    let pipe=service.pipe.as_mut().ok_or("Desktop service pipe unavailable.")?;
    pipe.write_all(&bootstrap).and_then(|_| pipe.flush()).map_err(|_| "Could not initialize the desktop service.")?;
    let (send, receive) = mpsc::channel();
    let handle=app.clone();
    std::thread::spawn(move || {
        let mut reader=BufReader::new(output);
        while let Ok(Some(line))=read_record(&mut reader,4096) {
            if let Ok(ready)=serde_json::from_slice::<Ready>(&line) { let _=send.send(ready); }
            else if let Ok(value)=serde_json::from_slice::<serde_json::Value>(&line) { updates::control(&handle,value); }
        }
    });
    let ready = receive.recv_timeout(Duration::from_secs(30)).map_err(|_| "The local service did not become ready. Reopen Studio; if this persists, reinstall the release.")?;
    if ready.desktop_ready != 1 || ready.port == 0 { return Err("The desktop service returned an invalid startup response.".into()); }
    Ok((service, ready.port, gate_name, gate.to_string()))
}

// Bound records before allocation, including malformed or overlong child logs.
fn read_record(reader:&mut impl BufRead,limit:usize)->std::io::Result<Option<Vec<u8>>> {
    let mut record=Vec::new();let mut oversized=false;
    loop {
        let bytes=reader.fill_buf()?;if bytes.is_empty(){return Ok(None)}
        let end=bytes.iter().position(|byte|*byte==b'\n');let length=end.map(|n|n+1).unwrap_or(bytes.len());
        if !oversized && record.len()+length<=limit {record.extend_from_slice(&bytes[..length]);}else{oversized=true;record.clear();}
        reader.consume(length);if end.is_some(){return Ok(Some(if oversized{Vec::new()}else{record}))}
    }
}
fn send_control(app:&tauri::AppHandle,value:&serde_json::Value)->Result<(),String> {
    let mut bytes=serde_json::to_vec(value).map_err(|_|"Update response unavailable.")?;
    if bytes.len()>16383{return Err("Update response exceeded its limit.".into())}bytes.push(b'\n');
    let runtime=app.state::<Runtime>();let mut service=runtime.0.lock().map_err(|_|"Desktop service unavailable.")?;
    let pipe=service.as_mut().and_then(|service|service.pipe.as_mut()).ok_or("Desktop service disconnected.")?;
    pipe.write_all(&bytes).and_then(|_|pipe.flush()).map_err(|_|"Desktop service disconnected.".into())
}
fn shutdown_service(app:&tauri::AppHandle)->Result<(),String> {
    let mut service=app.state::<Runtime>().0.lock().map_err(|_|"Desktop service unavailable.")?.take().ok_or("Desktop service unavailable.")?;
    drop(service.pipe.take());let deadline=Instant::now()+Duration::from_secs(10);
    loop {match service.child.try_wait(){Ok(Some(status))=>return if status.success(){Ok(())}else{Err("Desktop service stopped unexpectedly.".into())},Err(_)=>return Err("Desktop service status unavailable.".into()),Ok(None)=>{}}
        if Instant::now()>=deadline{return Err("Desktop service did not stop safely.".into())}std::thread::sleep(Duration::from_millis(40));}
}

fn external_link(url: &tauri::Url) {
    if url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none() { let _ = open::that(url.as_str()); }
}

fn launch(app: &tauri::AppHandle) -> Result<(), String> {
    let profile = app.path().app_local_data_dir().map_err(|_| "Cannot find your desktop data directory.")?.join("profile-v1");
    let (service, port, gate_name, gate) = start_service(app, &profile)?;
    *app.state::<Runtime>().0.lock().map_err(|_| "Desktop state unavailable.")? = Some(service);
    let origin = format!("http://127.0.0.1:{port}");
    let navigation_origin = origin.clone();
    let download_origin = origin.clone();
    let download_handle=app.clone();
    let closing_handle=app.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse().unwrap()))
        .title(format!("Civitai Studio · {}",app.package_info().version)).inner_size(1440.0, 1000.0).min_inner_size(800.0, 600.0)
        .visible(false).data_directory(profile.join("webview"))
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" || url.origin().ascii_serialization() == navigation_origin { true }
            else { external_link(url); false }
        })
        .on_new_window(|url, _| { external_link(&url); NewWindowResponse::Deny })
        .on_download(move |_, event| {
            if let DownloadEvent::Requested { url, destination } = event {
                if url.origin().ascii_serialization() != download_origin && !url.as_str().starts_with(&format!("blob:{download_origin}/")) { return false; }
                if !updates::native_download_begin(&download_handle,url.as_str()){return false}
                let filename = destination.file_name().and_then(|name| name.to_str()).unwrap_or("civitai-download");
                if let Some(path) = rfd::FileDialog::new().set_file_name(filename).save_file() { *destination = path; true } else {updates::native_download_declined(&download_handle,url.as_str()); false}
            } else {if let DownloadEvent::Finished{url,success,..}=event{updates::native_download_end(&download_handle,url.as_str(),success);}true}
        }).build().map_err(|_| "Cannot start the desktop webview. Install Microsoft Edge WebView2 Runtime on Windows, or check the platform prerequisites in START HERE.")?;
    window.on_window_event(move |event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{if updates::applying(&closing_handle){api.prevent_close();}}});
    let cookie = Cookie::build((gate_name, gate)).domain("127.0.0.1").path("/").http_only(true).same_site(cookie::SameSite::Strict).build();
    window.set_cookie(cookie).map_err(|_| "Cannot initialize the private desktop session.")?;
    window.navigate(origin.parse().unwrap()).map_err(|_| "Cannot open the local desktop workspace.")?;
    window.show().map_err(|_| "Cannot show the desktop window.")?;
    Ok(())
}

fn main() {
    let _=rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default().manage(Runtime(Mutex::new(None)))
        .manage(updates::Updates::new(env!("CARGO_PKG_VERSION").into()))
        .plugin(tauri_plugin_updater::Builder::new().pubkey(updates::PUBLIC_KEY.trim()).build())
        .setup(|app| {
            let handle = app.handle().clone();
            updates::initialize(&handle);
            // Native WebView operations run off event callbacks to avoid the
            // Windows WebView2 synchronous callback deadlock.
            std::thread::spawn(move || { if let Err(message) = launch(&handle) {
                rfd::MessageDialog::new().set_title("Civitai Studio could not start").set_description(&message).set_level(rfd::MessageLevel::Error).show();
                handle.exit(1);
            }});
            Ok(())
        })
        .build(tauri::generate_context!()).expect("Civitai Studio desktop initialization failed")
        .run(|app, event| { if matches!(event, tauri::RunEvent::Exit) {updates::cancel_on_exit(app);if let Ok(mut service) = app.state::<Runtime>().0.lock() { service.take(); } } });
}
