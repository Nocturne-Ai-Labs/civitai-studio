use std::{fs::{self, OpenOptions}, io::Write, path::Path};
use zeroize::Zeroizing;

pub fn master_key(profile: &Path) -> Result<Zeroizing<Vec<u8>>, String> {
    #[cfg(windows)] { windows_key(profile) }
    #[cfg(not(windows))] { keychain_key(profile) }
}

#[cfg(windows)]
fn windows_key(profile: &Path) -> Result<Zeroizing<Vec<u8>>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN}};
    let path = profile.join("master.dpapi");
    let existing = path.exists();
    if !existing && profile.join("studio.sqlite").exists() { return Err("The protected desktop key is missing. Restore your profile backup; a new key cannot decrypt existing accounts.".into()); }
    let mut input = if existing { fs::read(&path).map_err(|_| "Cannot read the protected desktop key.")? } else {
        let mut bytes = vec![0u8; 32]; getrandom::fill(&mut bytes).map_err(|_| "Secure randomness unavailable.")?; bytes
    };
    let input_blob = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_mut_ptr() };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let ok = unsafe { if existing {
        CryptUnprotectData(&input_blob, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    } else {
        CryptProtectData(&input_blob, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    }};
    if ok == 0 { return Err("Windows could not unlock the desktop key for this account. Keep your profile and use the Windows account that created it.".into()); }
    let output_bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()); }
    if existing {
        if output_bytes.len() != 32 { return Err("The protected desktop key is invalid. Restore your profile backup.".into()); }
        Ok(Zeroizing::new(output_bytes))
    } else {
        let temporary = profile.join("master.dpapi.new");
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "Cannot create the protected desktop key.")?;
        file.write_all(&output_bytes).and_then(|_| file.sync_all()).map_err(|_| "Cannot save the protected desktop key.")?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|_| "Cannot finish saving the protected desktop key.")?;
        Ok(Zeroizing::new(input))
    }
}

#[cfg(not(windows))]
fn keychain_key(profile: &Path) -> Result<Zeroizing<Vec<u8>>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let entry = keyring::Entry::new("com.civitaistudio.alpha", "master-key-v1").map_err(|_| "Secure key storage unavailable. Unlock Keychain (macOS) or start and unlock a Secret Service keyring in your desktop session (Linux).")?;
    match entry.get_password() {
        Ok(encoded) => {
            let bytes = STANDARD.decode(encoded).map_err(|_| "The desktop key in the system keyring is invalid.")?;
            if bytes.len() != 32 { return Err("The desktop key in the system keyring is invalid.".into()); }
            Ok(Zeroizing::new(bytes))
        },
        Err(keyring::Error::NoEntry) => {
            if profile.join("studio.sqlite").exists() { return Err("The desktop key is missing from the system keyring. Restore it before opening the existing profile.".into()); }
            let mut bytes = Zeroizing::new(vec![0u8; 32]);
            getrandom::fill(&mut bytes).map_err(|_| "Secure randomness unavailable.")?;
            let encoded = Zeroizing::new(STANDARD.encode(&*bytes));
            entry.set_password(&encoded).map_err(|_| "Could not save the desktop key. Unlock Keychain (macOS) or start and unlock a Secret Service keyring (Linux). No unprotected fallback is used.")?;
            Ok(bytes)
        },
        Err(_) => Err("Cannot unlock desktop key storage. Unlock Keychain (macOS) or your Secret Service keyring (Linux), then reopen Studio.".into())
    }
}
