use crate::{Runtime, send_control, shutdown_service};
use base64::{engine::general_purpose::STANDARD,Engine};
use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPOSITORY: &str = "Nocturne-Ai-Labs/civitai-studio";
const RELEASES: &str = "https://api.github.com/repos/Nocturne-Ai-Labs/civitai-studio/releases?per_page=30";
const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
pub const PUBLIC_KEY: &str = include_str!("../updater-public-key.txt");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub version: String, pub platform: String, pub channel: String, pub supported: bool,
    pub status: String, pub available_version: Option<String>, pub notes: Option<String>,
    pub published_at: Option<String>, pub downloaded_bytes: u64, pub total_bytes: Option<u64>,
    pub message: String, pub release_url: Option<String>, pub checked_at: Option<String>, pub can_retry: bool,
}
#[derive(Clone)]
struct Candidate { update: Update, bytes: u64 }
struct Inner {
    view: View, candidate: Option<Candidate>, package: Option<Vec<u8>>, generation: u64, sequence: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>, last_check: Option<Instant>,
    shutdown: Option<(String, std::sync::mpsc::Sender<bool>)>, native_downloads: HashMap<String, usize>, declined_downloads: HashMap<String, usize>,
}
pub struct Updates(Mutex<Inner>);

pub fn platform() -> &'static str {
    if cfg!(windows) { "windows-x86_64" } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "darwin-aarch64" } else { "darwin-x86_64" }
    } else { "linux-x86_64" }
}
fn supported(_app: Option<&AppHandle>) -> bool {
    #[cfg(windows)] {
        let Ok(executable) = std::env::current_exe().and_then(std::fs::canonicalize) else { return false };
        let Ok(registry) = windows_registry::LOCAL_MACHINE.open("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Civitai Studio Alpha") else { return false };
        let (Ok(location), Ok(binary)) = (registry.get_string("InstallLocation"), registry.get_string("MainBinaryName")) else { return false };
        let directory = std::path::PathBuf::from(location.trim_matches('"'));
        return directory.join("uninstall.exe").is_file() && directory.join(binary).canonicalize().map(|installed| installed == executable).unwrap_or(false);
    }
    #[cfg(target_os = "macos")] {
        return std::env::current_exe().map(|path| path.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).is_some_and(|p| !p.starts_with("/Volumes") && p.extension().is_some_and(|extension| extension == "app"))).unwrap_or(false);
    }
    #[cfg(target_os = "linux")] {
        if !matches!(tauri::utils::platform::bundle_type(),Some(tauri::utils::config::BundleType::AppImage)){return false}
        let Some(app)=_app else{return false};let env=app.env();
        let (Some(image),Some(directory))=(env.appimage,env.appdir)else{return false};
        let (Ok(directory),Ok(executable))=(std::path::Path::new(&directory).canonicalize(),std::env::current_exe().and_then(std::fs::canonicalize))else{return false};
        return std::path::Path::new(&image).is_file() && executable.starts_with(directory);
    }
}
fn manual_message()->&'static str {
    if cfg!(windows){"This portable copy uses manual updates. Install the Windows installer to enable in-app updates; your account profile is kept."}
    else if cfg!(target_os="macos"){"Move Civitai Studio from its disk image into Applications before using in-app updates, or download the matching release manually."}
    else{"This package-managed or raw installation uses manual updates. Use the matching download, or the AppImage for in-app updates. Your account profile is kept."}
}
impl Updates {
    pub fn new(version: String) -> Self {
        let supported = supported(None);
        Self(Mutex::new(Inner { view: View { version, platform: platform().into(), channel: "beta".into(), supported,
            status: if supported { "idle" } else { "manual" }.into(), available_version: None, notes: None, published_at: None,
            downloaded_bytes: 0, total_bytes: None, message: if supported { "Check for a new Civitai Studio release." } else { manual_message() }.into(),
            release_url: Some(format!("https://github.com/{REPOSITORY}/releases")), checked_at: None, can_retry: false }, candidate: None, package: None,
            generation: 0, sequence: 0, task: None, last_check: None, shutdown: None, native_downloads: HashMap::new(), declined_downloads: HashMap::new() }))
    }
    pub fn snapshot(&self) -> View { self.0.lock().unwrap().view.clone() }
}
pub fn initialize(app:&AppHandle) {
    let supported=supported(Some(app));let updates=app.state::<Updates>();let mut inner=updates.0.lock().unwrap();
    inner.view.supported=supported;inner.view.status=if supported{"idle"}else{"manual"}.into();
    inner.view.message=if supported{"Check for a new Civitai Studio release."}else{manual_message()}.into();
}
fn now() -> Option<String> { time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).ok() }
fn bounded_text(value:&str,limit:usize)->String {let mut end=value.len().min(limit);while !value.is_char_boundary(end){end-=1}value[..end].to_string()}
fn push(app: &AppHandle, id: Option<&str>) {
    let record = { let updates=app.state::<Updates>(); let mut inner=updates.0.lock().unwrap(); inner.sequence += 1; json!({"desktopUpdateState":1,"sequence":inner.sequence,"id":id,"state":inner.view}) };
    let _ = send_control(app, &record);
}
fn change(app: &AppHandle, generation: u64, action: impl FnOnce(&mut Inner)) -> bool {
    let updates=app.state::<Updates>(); let mut inner=updates.0.lock().unwrap();
    if inner.generation != generation { return false } action(&mut inner); true
}
fn error(app: &AppHandle, generation: u64, message: &str) {
    if change(app,generation,|inner| { inner.view.status="error".into(); inner.view.message=message.into(); inner.view.can_retry=true; inner.package=None; }) { push(app,None); }
}
pub fn native_download_begin(app: &AppHandle, key: &str) -> bool {
    let updates=app.state::<Updates>(); let mut inner=updates.0.lock().unwrap();
    if inner.view.status=="applying" { return false }
    *inner.native_downloads.entry(key.to_string()).or_default() += 1; true
}
pub fn native_download_declined(app:&AppHandle,key:&str) {
    let updates=app.state::<Updates>();let mut inner=updates.0.lock().unwrap();
    if let Some(count)=inner.native_downloads.get_mut(key){*count=count.saturating_sub(1);if *count==0{inner.native_downloads.remove(key);}}
    *inner.declined_downloads.entry(key.into()).or_default()+=1;
}
pub fn native_download_end(app: &AppHandle, key: &str, success:bool) {
    let updates=app.state::<Updates>(); let mut inner=updates.0.lock().unwrap();
    // WebView2 can emit a failed completion even for a request declined in the
    // save dialog. Consume these first, so same-URL downloads cannot undercount.
    if !success {if let Some(count)=inner.declined_downloads.get_mut(key){*count=count.saturating_sub(1);if *count==0{inner.declined_downloads.remove(key);}return}}
    if let Some(count)=inner.native_downloads.get_mut(key) { *count=count.saturating_sub(1); if *count==0 { inner.native_downloads.remove(key); } }
}
pub fn applying(app: &AppHandle) -> bool { app.state::<Updates>().0.lock().unwrap().view.status=="applying" }
pub fn cancel_on_exit(app: &AppHandle) { if let Some(task)=app.state::<Updates>().0.lock().unwrap().task.take() { task.abort(); } }

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Request { desktop_update_request: u8, id: String, action: String }
pub fn control(app: &AppHandle, value: Value) {
    if value.get("desktopUpdateShutdownReady").and_then(Value::as_u64)==Some(1) {
        let updates=app.state::<Updates>(); let inner=updates.0.lock().unwrap();
        if let Some((id,reply))=&inner.shutdown { if value.get("id").and_then(Value::as_str)==Some(id) { let _=reply.send(value.get("ok").and_then(Value::as_bool)==Some(true)); } }
        return
    }
    let Ok(request)=serde_json::from_value::<Request>(value) else { return };
    if request.desktop_update_request!=1 || request.id.len()!=36 || !request.id.bytes().all(|b| b.is_ascii_hexdigit() || b==b'-') { return }
    let updates=app.state::<Updates>();
    let mut inner=updates.0.lock().unwrap();
    if request.action=="cancel" {
        if inner.view.status=="applying" { drop(inner); push(app,Some(&request.id)); return }
        inner.generation+=1; if let Some(task)=inner.task.take() { task.abort(); }
        inner.package=None; inner.view.downloaded_bytes=0; inner.view.total_bytes=None;
        inner.view.status=if inner.candidate.is_some() && inner.view.supported {"available"} else if inner.view.supported {"idle"} else {"manual"}.into();
        inner.view.message="Update download cancelled. You can keep using Studio.".into(); drop(inner);push(app,Some(&request.id));return
    }
    if ["checking","downloading","applying"].contains(&inner.view.status.as_str()) { drop(inner);if request.action=="apply" {let _=send_control(app,&json!({"desktopUpdateResume":1,"id":request.id}));}push(app,Some(&request.id));return }
    if !["check","download","apply"].contains(&request.action.as_str()) { return }
    if request.action=="check" && (inner.view.status=="ready" || inner.last_check.is_some_and(|at| at.elapsed()<Duration::from_secs(if inner.view.status=="error"{5}else{30}))) { drop(inner);push(app,Some(&request.id));return }
    if request.action=="download" && (!inner.view.supported || inner.candidate.is_none()) { drop(inner);push(app,Some(&request.id));return }
    if request.action=="apply" && (!inner.view.supported || inner.view.status!="ready" || inner.package.is_none()) { drop(inner);let _=send_control(app,&json!({"desktopUpdateResume":1,"id":request.id}));push(app,Some(&request.id));return }
    if request.action=="apply" && !inner.native_downloads.is_empty() { inner.view.message="Finish your desktop downloads before restarting to update.".into();drop(inner);let _=send_control(app,&json!({"desktopUpdateResume":1,"id":request.id}));push(app,Some(&request.id));return }
    inner.generation+=1;let generation=inner.generation;
    match request.action.as_str() {
        "check"=>{inner.last_check=Some(Instant::now());inner.candidate=None;inner.package=None;inner.view.available_version=None;inner.view.notes=None;inner.view.published_at=None;inner.view.downloaded_bytes=0;inner.view.total_bytes=None;inner.view.status="checking".into();inner.view.message="Checking for updates…".into();inner.view.can_retry=false;},
        "download"=>{inner.view.status="downloading".into();inner.view.message="Downloading and verifying the update…".into();inner.view.downloaded_bytes=0;inner.view.total_bytes=inner.candidate.as_ref().map(|c|c.bytes);inner.view.can_retry=false;},
        "apply"=>{inner.view.status="applying".into();inner.view.message="Preparing a safe restart…".into();inner.view.can_retry=false;}, _=>{}
    }
    drop(inner); push(app,Some(&request.id));
    let handle=app.clone();let action=request.action;let id=request.id;
    let task=tauri::async_runtime::spawn(async move { match action.as_str() {
        "check"=>{if let Err(message)=check(&handle,generation).await { error(&handle,generation,&message); }},
        "download"=>{if let Err(message)=download(&handle,generation).await { error(&handle,generation,&message); }},
        "apply"=>{let _=tauri::async_runtime::spawn_blocking(move || apply(&handle,generation,&id)).await;}, _=>{}
    }});
    change(app,generation,|inner|inner.task=Some(task));
}

fn asset_url(value: &str, tag: &str) -> Option<Url> {
    let url=Url::parse(value).ok()?;
    if url.scheme()!="https" || url.host_str()!=Some("github.com") || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return None }
    let prefix=format!("/{REPOSITORY}/releases/download/{tag}/");
    let name=url.path().strip_prefix(&prefix)?;
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) { return None } Some(url)
}
fn package_name(version:&str)->String {
    let (name,extension)=if cfg!(windows){("windows-x64","-setup.exe")}else if cfg!(target_os="macos"){(if cfg!(target_arch="aarch64"){"macos-apple-silicon"}else{"macos-intel"},".app.tar.gz")}else{("linux-x64",".AppImage")};
    format!("Civitai-Studio-{version}-{name}{extension}")
}
fn verify_package(candidate:&Candidate,bytes:&[u8])->Result<(),String> {
    candidate.update.verify(bytes).map_err(|_|"The update signature or signed version could not be verified. Nothing was installed.")?;
    // The trusted Minisign comment is authenticated by verify() above. Binding
    // its filename also rejects cross-platform same-version payload replay.
    let decoded=STANDARD.decode(&candidate.update.signature).map_err(|_|"The update signature is invalid.")?;
    let text=std::str::from_utf8(&decoded).map_err(|_|"The update signature is invalid.")?;
    let signed_file=text.lines().find_map(|line|line.strip_prefix("trusted comment: ")).and_then(|comment|comment.split('\t').find_map(|field|field.strip_prefix("file:")));
    if signed_file!=Some(package_name(&candidate.update.version).as_str()){return Err("The signed package belongs to a different platform.".into())}
    let format=if cfg!(windows){bytes.starts_with(b"MZ")}else if cfg!(target_os="macos"){bytes.starts_with(&[0x1f,0x8b,8])}else{bytes.starts_with(b"\x7fELF")&&bytes.get(4)==Some(&2)&&bytes.get(5)==Some(&1)&&bytes.get(8..11)==Some(b"AI\x02")&&bytes.get(18..20)==Some(&[62,0])};
    if !format{return Err("The update package format does not match this platform.".into())}Ok(())
}
fn client(download: bool) -> Result<Client,String> {
    let policy=reqwest::redirect::Policy::custom(|attempt| {
        let url=attempt.url();
        if attempt.previous().len()>=5 || url.scheme()!="https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || !matches!(url.host_str(),Some("github.com"|"release-assets.githubusercontent.com"|"objects.githubusercontent.com")) { attempt.error("Unexpected update redirect") } else { attempt.follow() }
    });
    Client::builder().no_proxy().https_only(true).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(if download {600} else {30})).user_agent(concat!("Civitai-Studio/",env!("CARGO_PKG_VERSION"))).redirect(if download {policy} else {reqwest::redirect::Policy::none()}).build().map_err(|_|"Update networking is unavailable.".into())
}
async fn read_limited(mut response:reqwest::Response, limit:u64)->Result<Vec<u8>,String> {
    if !response.status().is_success() { return Err(if response.status().as_u16()==403 || response.status().as_u16()==429 {"GitHub is limiting update checks. Please try again later."} else {"The update service is unavailable. Please try again."}.into()) }
    if response.content_length().is_some_and(|n|n>limit) { return Err("Update metadata exceeded its safety limit.".into()) }
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"The update connection was interrupted.")? { if bytes.len() as u64+chunk.len() as u64>limit {return Err("Update metadata exceeded its safety limit.".into())} bytes.extend_from_slice(&chunk) } Ok(bytes)
}
async fn check(app:&AppHandle,generation:u64)->Result<(),String> {
    let current=Version::parse(&app.package_info().version.to_string()).map_err(|_|"Studio version is unavailable.")?;
    let response=client(false)?.get(RELEASES).send().await.map_err(|_|"Could not reach GitHub. Check your connection and try again.")?;
    let releases:Value=serde_json::from_slice(&read_limited(response,2*1024*1024).await?).map_err(|_|"GitHub returned invalid update information.")?;
    let mut candidates:Vec<(Version,&Value)>=releases.as_array().ok_or("GitHub returned invalid update information.")?.iter().filter_map(|release|{
        if release.get("draft").and_then(Value::as_bool)!=Some(false) { return None }
        let tag=release.get("tag_name")?.as_str()?;if tag.len()>81{return None}let version=Version::parse(tag.strip_prefix('v')?).ok()?;
        if version<=current || (!version.pre.is_empty() && !version.pre.as_str().starts_with("beta.")) { return None }
        if !release.get("assets")?.as_array()?.iter().any(|a| a.get("name").and_then(Value::as_str)==Some("latest.json") && a.get("state").and_then(Value::as_str)==Some("uploaded")) { return None }
        Some((version,release))
    }).collect();candidates.sort_by(|a,b|b.0.cmp(&a.0));
    let Some((version,release))=candidates.first() else {
        change(app,generation,|inner|{inner.view.status=if inner.view.supported {"upToDate"} else {"manual"}.into();inner.view.message="You have the latest available Civitai Studio version.".into();inner.view.checked_at=now();inner.view.can_retry=false;inner.view.available_version=None;});push(app,None);return Ok(())
    };
    let tag=format!("v{version}");let assets=release["assets"].as_array().ok_or("Release assets are unavailable.")?;
    let metadata=assets.iter().find(|a|a["name"]=="latest.json").ok_or("Update information is unavailable.")?;
    let endpoint=asset_url(metadata["browser_download_url"].as_str().unwrap_or(""),&tag).ok_or("The update metadata URL is invalid.")?;
    let response=client(true)?.get(endpoint.clone()).timeout(Duration::from_secs(30)).send().await.map_err(|_|"Could not load update information. Please try again.")?;
    let manifest:Value=serde_json::from_slice(&read_limited(response,64*1024).await?).map_err(|_|"The update metadata is invalid.")?;
    if manifest["version"].as_str()!=Some(version.to_string().as_str()) {return Err("The announced update version does not match its release.".into())}
    let target=manifest["platforms"][platform()].as_object().ok_or("This release has no update for your platform.")?;
    let download=asset_url(target.get("url").and_then(Value::as_str).unwrap_or(""),&tag).ok_or("The update download URL is invalid.")?;
    if download.path_segments().and_then(|segments|segments.last())!=Some(package_name(&version.to_string()).as_str()){return Err("The update filename does not match this platform.".into())}
    let signature=target.get("signature").and_then(Value::as_str).ok_or("The update signature is missing.")?;
    if signature.is_empty() || signature.len()>4096 { return Err("The update signature is invalid.".into()) }
    let asset=assets.iter().find(|a|a["browser_download_url"].as_str()==Some(download.as_str()) && a["state"]=="uploaded").ok_or("The update is not a published release asset.")?;
    let bytes=asset["size"].as_u64().filter(|n|*n>0 && *n<=MAX_PACKAGE).ok_or("The update package size is invalid.")?;
    let cleanup=app.clone();
    let updater=app.updater_builder().target(platform()).no_proxy().endpoints(vec![endpoint]).map_err(|_|"The signed update endpoint is invalid.")?.on_before_exit(move || {
        if let Ok(mut service)=cleanup.state::<Runtime>().0.lock() { service.take(); }
    }).build().map_err(|_|"The signed updater is unavailable.")?;
    let update=updater.restore_update(manifest.clone()).map_err(|_|"The signed update metadata could not be verified.")?.ok_or("The release does not contain a newer update.")?;
    if update.download_url!=download || update.version!=version.to_string() { return Err("The update does not match the selected release.".into()) }
    change(app,generation,|inner|{inner.candidate=Some(Candidate{update,bytes});inner.view.status=if inner.view.supported {"available"} else {"manual"}.into();inner.view.available_version=Some(version.to_string());inner.view.notes=manifest["notes"].as_str().map(|s|bounded_text(s,4096));inner.view.published_at=manifest["pub_date"].as_str().map(|s|bounded_text(s,50));inner.view.release_url=Some(format!("https://github.com/{REPOSITORY}/releases/tag/{tag}"));inner.view.message=if inner.view.supported {"A new version is available. Download it when you're ready."} else {"A new version is available. Use the matching manual download for this installation."}.into();inner.view.checked_at=now();inner.view.can_retry=false;});push(app,None);Ok(())
}
async fn download(app:&AppHandle,generation:u64)->Result<(),String> {
    let candidate=app.state::<Updates>().0.lock().unwrap().candidate.clone().ok_or("Check for an update first.")?;
    let mut response=client(true)?.get(candidate.update.download_url.clone()).send().await.map_err(|_|"The download could not start. Check your connection and try again.")?;
    if !response.status().is_success() || response.content_length().is_some_and(|size|size!=candidate.bytes) { return Err("The update download does not match the release package.".into()) }
    let mut package=Vec::new();let mut last=Instant::now();
    while let Some(chunk)=response.chunk().await.map_err(|_|"The update download was interrupted. Please try again.")? {
        if package.len() as u64+chunk.len() as u64>candidate.bytes || package.len() as u64+chunk.len() as u64>MAX_PACKAGE { return Err("The update exceeded its expected size.".into()) }
        package.extend_from_slice(&chunk);
        if last.elapsed()>Duration::from_millis(150) { if !change(app,generation,|inner|inner.view.downloaded_bytes=package.len() as u64) {return Ok(())} push(app,None);last=Instant::now(); }
    }
    if package.len() as u64!=candidate.bytes { return Err("The update download was incomplete. Please try again.".into()) }
    verify_package(&candidate,&package)?;
    if change(app,generation,|inner|{inner.package=Some(package);inner.view.status="ready".into();inner.view.downloaded_bytes=candidate.bytes;inner.view.total_bytes=Some(candidate.bytes);inner.view.message="Update verified. Restart when you're ready to apply it.".into();}) { push(app,None); } Ok(())
}
fn apply(app:&AppHandle,generation:u64,id:&str) {
    let (send,receive)=std::sync::mpsc::channel();
    if !change(app,generation,|inner|inner.shutdown=Some((id.into(),send))) { return }
    let shutdown=send_control(app,&json!({"desktopUpdateShutdown":1,"id":id})).is_ok() && receive.recv_timeout(Duration::from_secs(10))==Ok(true);
    change(app,generation,|inner|inner.shutdown=None);
    if !shutdown {
        let _=send_control(app,&json!({"desktopUpdateResume":1,"id":id}));
        change(app,generation,|inner|{inner.view.status="ready".into();inner.view.message="Finish active saves or downloads, then try Restart to update again.".into();});push(app,None);return
    }
    let package={let updates=app.state::<Updates>();let mut inner=updates.0.lock().unwrap();inner.candidate.clone().zip(inner.package.take())};
    let Some((candidate,bytes))=package else { recover(app,"The verified update is no longer available. Please download it again.");return };
    if verify_package(&candidate,&bytes).is_err() { recover(app,"The update could not be verified again. Nothing was installed.");return }
    if shutdown_service(app).is_err() { recover(app,"Studio could not finish shutting down safely. The update was not installed.");return }
    if candidate.update.install(&bytes).is_err() { recover(app,"The update could not be installed. Studio will reopen so you can try again or download it manually.");return }
    #[cfg(not(windows))] app.restart();
}
fn recover(app:&AppHandle,message:&str) {
    // Restart must never race the existing service's database/profile lock.
    let _=shutdown_service(app);
    rfd::MessageDialog::new().set_title("Civitai Studio update").set_description(message).set_level(rfd::MessageLevel::Warning).show();
    app.restart();
}
