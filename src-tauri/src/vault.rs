//! AES-256-GCM file vault for at-rest encryption of connection secrets.
//!
//! A machine-specific 256-bit key is generated once and stored in `vault.key`
//! under the app config dir (`%APPDATA%\wrolp-terminal` on Windows). Each secret
//! is encrypted with a fresh random 12-byte nonce; the nonce + ciphertext is
//! base64-encoded and stored in `connections.json` instead of the plaintext.
//!
//! Secrets are encrypted at rest with a machine-specific AES-256-GCM key stored
//! in `vault.key`. No OS keyring (Windows Credential Manager / macOS Keychain /
//! libsecret) is used; the encrypted blob is written next to the data it
//! protects.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use std::path::PathBuf;

const KEY_FILE_NAME: &str = "vault.key";
const NONCE_LEN: usize = 12;

fn data_dir() -> Option<PathBuf> {
  dirs::config_dir().map(|p| p.join("wrolp-terminal"))
}

fn key_path() -> Option<PathBuf> {
  data_dir().map(|p| p.join(KEY_FILE_NAME))
}

fn read_key_file(path: &std::path::Path) -> Option<[u8; 32]> {
  let bytes = std::fs::read(path).ok()?;
  if bytes.len() != 32 {
    return None;
  }
  let mut key = [0u8; 32];
  key.copy_from_slice(&bytes);
  Some(key)
}

/// When the user opted into "vault.key follows data" (data_root.json
/// `key_follows`) and the configured data dir already carries a `vault.key`
/// (copied during a migration), that local key is authoritative — it keeps a
/// relocated data dir self-contained/portable. Otherwise the machine-anchored
/// default key is used (old behaviour). A malformed local key is ignored in
/// favour of the default, never generated in place.
fn preferred_key_path() -> Option<PathBuf> {
  let anchor = crate::data_root::read_anchor()?;
  if !anchor.key_follows {
    return None;
  }
  let dir = anchor.dir?;
  if dir.trim().is_empty() {
    return None;
  }
  let candidate = PathBuf::from(dir).join(KEY_FILE_NAME);
  candidate.is_file().then_some(candidate)
}

/// Load the vault key, generating and persisting it on first use. New keys are
/// always created in the machine-anchored default data dir; a key that follows
/// the configured data dir is only ever *read* (it was copied there by the
/// migration, never invented on the spot).
pub fn load_or_create_key() -> Result<[u8; 32], String> {
  if let Some(path) = preferred_key_path() {
    if let Some(key) = read_key_file(&path) {
      return Ok(key);
    }
  }
  let path = key_path().ok_or_else(|| "cannot resolve config dir".to_string())?;
  if let Some(key) = read_key_file(&path) {
    return Ok(key);
  }

  // Generate a new random key and store it with restricted permissions.
  let mut key = [0u8; 32];
  rand::thread_rng().fill_bytes(&mut key);
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  std::fs::write(&path, &key).map_err(|e| e.to_string())?;
  restrict_file_perms(&path);
  Ok(key)
}

#[cfg(windows)]
fn restrict_file_perms(_path: &std::path::Path) {
  // %APPDATA% is already per-user; the key file lives inside it, so it is not
  // readable by other local accounts. Tightening via icacls is possible but
  // skipped to avoid brittle shell calls.
}

#[cfg(not(windows))]
fn restrict_file_perms(path: &std::path::Path) {
  use std::os::unix::fs::PermissionsExt;
  let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

fn encrypt(key: &[u8; 32], plaintext: &str) -> Result<String, String> {
  let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
  let mut nonce = [0u8; NONCE_LEN];
  rand::thread_rng().fill_bytes(&mut nonce);
  let ct = cipher
    .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
    .map_err(|e| e.to_string())?;

  // Blob layout: nonce (12 bytes) || ciphertext
  let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
  blob.extend_from_slice(&nonce);
  blob.extend_from_slice(&ct);
  Ok(B64.encode(blob))
}

fn decrypt(key: &[u8; 32], blob: &str) -> Result<String, String> {
  let raw = B64.decode(blob).map_err(|e| e.to_string())?;
  if raw.len() < NONCE_LEN {
    return Err("cipher blob too short".to_string());
  }
  let (nonce, ct) = raw.split_at(NONCE_LEN);
  let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
  let pt = cipher
    .decrypt(Nonce::from_slice(nonce), ct)
    .map_err(|e| e.to_string())?;
  String::from_utf8(pt).map_err(|e| e.to_string())
}

/// Encrypt a plaintext secret, loading/creating the vault key as needed.
pub fn seal_secret(plaintext: &str) -> Result<String, String> {
  let key = load_or_create_key()?;
  encrypt(&key, plaintext)
}

/// Decrypt a vault blob back to plaintext.
pub fn open_secret(blob: &str) -> Result<String, String> {
  let key = load_or_create_key()?;
  decrypt(&key, blob)
}
