//! AES-256-GCM file vault for at-rest encryption of connection secrets.
//!
//! A machine-specific 256-bit key is generated once and stored in `vault.key`
//! under the app config dir (`%APPDATA%\wrolp-terminal` on Windows). Each secret
//! is encrypted with a fresh random 12-byte nonce; the nonce + ciphertext is
//! base64-encoded and stored in `connections.json` instead of the plaintext.
//!
//! This is the cross-platform fallback described in `task/ENCRYPT-PLAN.md`. The
//! OS keyring (Windows Credential Manager / macOS Keychain / libsecret) is the
//! preferred store when available; this file vault is used whenever the keyring
//! cannot be reached.

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

/// Load the vault key, generating and persisting it on first use.
pub fn load_or_create_key() -> Result<[u8; 32], String> {
  let path = key_path().ok_or_else(|| "cannot resolve config dir".to_string())?;

  if path.exists() {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() == 32 {
      let mut key = [0u8; 32];
      key.copy_from_slice(&bytes);
      return Ok(key);
    }
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
