use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use keyring::{Entry, Error as KeyringError};
use rand::RngCore;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HLOCAL, LocalFree};

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("crypto key must be exactly {KEY_LEN} bytes")]
    InvalidKeyLength,
    #[error("encryption failed")]
    Encrypt,
    #[error("decryption failed")]
    Decrypt,
    #[error("ciphertext is shorter than the required nonce length")]
    CiphertextTooShort,
    #[error("decrypted data is not valid UTF-8")]
    InvalidUtf8(#[from] std::string::FromUtf8Error),
    #[error("stored key is not valid hex")]
    InvalidStoredKey,
    #[error("secret store entry not found")]
    SecretNotFound,
    #[error("secret store error: {0}")]
    SecretStore(String),
    #[error("protected backup store error: {0}")]
    ProtectedBackup(String),
}

pub trait KeyProvider {
    fn load_key(&self) -> Result<Vec<u8>, CryptoError>;
}

trait SecretStore {
    fn read_secret(&self) -> Result<String, CryptoError>;
    fn write_secret(&self, value: &str) -> Result<(), CryptoError>;
}

trait KeyBackupStore {
    fn read_key(&self) -> Result<Vec<u8>, CryptoError>;
    fn write_key(&self, value: &[u8]) -> Result<(), CryptoError>;
}

#[derive(Debug, Clone)]
pub struct StaticKeyProvider {
    key: Vec<u8>,
}

impl StaticKeyProvider {
    pub fn new(key: impl Into<Vec<u8>>) -> Self {
        Self { key: key.into() }
    }
}

impl KeyProvider for StaticKeyProvider {
    fn load_key(&self) -> Result<Vec<u8>, CryptoError> {
        Ok(self.key.clone())
    }
}

#[derive(Debug)]
struct KeyringSecretStore {
    entry: Entry,
}

impl KeyringSecretStore {
    fn new(service: &str, account: &str) -> Result<Self, CryptoError> {
        let entry = Entry::new(service, account)
            .map_err(|error| CryptoError::SecretStore(error.to_string()))?;
        Ok(Self { entry })
    }
}

impl SecretStore for KeyringSecretStore {
    fn read_secret(&self) -> Result<String, CryptoError> {
        self.entry.get_password().map_err(map_keyring_error)
    }

    fn write_secret(&self, value: &str) -> Result<(), CryptoError> {
        self.entry
            .set_password(value)
            .map_err(|error| CryptoError::SecretStore(error.to_string()))
    }
}

#[derive(Debug)]
pub struct KeyringKeyProvider {
    store: KeyringSecretStore,
    backup: Option<DpapiKeyBackupStore>,
}

impl KeyringKeyProvider {
    pub fn new(service: &str, account: &str) -> Result<Self, CryptoError> {
        Ok(Self {
            store: KeyringSecretStore::new(service, account)?,
            backup: DpapiKeyBackupStore::new(service, account),
        })
    }
}

impl KeyProvider for KeyringKeyProvider {
    fn load_key(&self) -> Result<Vec<u8>, CryptoError> {
        load_or_generate_key(&self.store, self.backup.as_ref())
    }
}

#[derive(Debug, Clone)]
pub struct CryptoContext {
    key: [u8; KEY_LEN],
}

impl CryptoContext {
    pub fn new(key: impl AsRef<[u8]>) -> Result<Self, CryptoError> {
        let key = key.as_ref();
        if key.len() != KEY_LEN {
            return Err(CryptoError::InvalidKeyLength);
        }

        let mut bytes = [0_u8; KEY_LEN];
        bytes.copy_from_slice(key);
        Ok(Self { key: bytes })
    }

    pub fn from_provider(provider: &impl KeyProvider) -> Result<Self, CryptoError> {
        Self::new(provider.load_key()?)
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&self.key).expect("key length already validated")
    }
}

pub fn encrypt_bytes(value: &[u8], context: &CryptoContext) -> Result<Vec<u8>, CryptoError> {
    let cipher = context.cipher();
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, value)
        .map_err(|_| CryptoError::Encrypt)?;

    let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

pub fn decrypt_bytes(value: &[u8], context: &CryptoContext) -> Result<Vec<u8>, CryptoError> {
    if value.len() < NONCE_LEN {
        return Err(CryptoError::CiphertextTooShort);
    }

    let (nonce_bytes, ciphertext) = value.split_at(NONCE_LEN);
    let cipher = context.cipher();
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| CryptoError::Decrypt)
}

pub fn encrypt_string(value: &str, context: &CryptoContext) -> Result<Vec<u8>, CryptoError> {
    encrypt_bytes(value.as_bytes(), context)
}

pub fn decrypt_string(value: &[u8], context: &CryptoContext) -> Result<String, CryptoError> {
    Ok(String::from_utf8(decrypt_bytes(value, context)?)?)
}

pub fn encrypt_optional_string(
    value: &Option<String>,
    context: &CryptoContext,
) -> Result<Option<Vec<u8>>, CryptoError> {
    value
        .as_ref()
        .map(|value| encrypt_string(value, context))
        .transpose()
}

pub fn decrypt_optional_string(
    value: &Option<Vec<u8>>,
    context: &CryptoContext,
) -> Result<Option<String>, CryptoError> {
    value
        .as_ref()
        .map(|value| decrypt_string(value, context))
        .transpose()
}

fn map_keyring_error(error: KeyringError) -> CryptoError {
    match error {
        KeyringError::NoEntry => CryptoError::SecretNotFound,
        other => CryptoError::SecretStore(other.to_string()),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const LUT: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(LUT[(byte >> 4) as usize] as char);
        output.push(LUT[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex(value: &str) -> Result<Vec<u8>, CryptoError> {
    if value.len() != KEY_LEN * 2 || value.len() % 2 != 0 {
        return Err(CryptoError::InvalidStoredKey);
    }

    value
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| {
            let hi = decode_hex_nibble(chunk[0])?;
            let lo = decode_hex_nibble(chunk[1])?;
            Ok((hi << 4) | lo)
        })
        .collect()
}

fn decode_hex_nibble(byte: u8) -> Result<u8, CryptoError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(CryptoError::InvalidStoredKey),
    }
}

fn load_or_generate_key(
    store: &impl SecretStore,
    backup: Option<&impl KeyBackupStore>,
) -> Result<Vec<u8>, CryptoError> {
    match store.read_secret() {
        Ok(value) => {
            let key = decode_hex(&value)?;
            mirror_key_to_backup(&key, backup);
            Ok(key)
        }
        Err(CryptoError::SecretNotFound) => {
            if let Some(backup) = backup {
                match backup.read_key() {
                    Ok(key) => {
                        if key.len() != KEY_LEN {
                            return Err(CryptoError::InvalidKeyLength);
                        }
                        store.write_secret(&encode_hex(&key))?;
                        return Ok(key);
                    }
                    Err(CryptoError::SecretNotFound) => {}
                    Err(error) => return Err(error),
                }
            }

            let mut key = [0_u8; KEY_LEN];
            rand::thread_rng().fill_bytes(&mut key);
            let encoded = encode_hex(&key);
            store.write_secret(&encoded)?;
            mirror_key_to_backup(&key, backup);
            Ok(key.to_vec())
        }
        Err(error) => Err(error),
    }
}

fn mirror_key_to_backup(key: &[u8], backup: Option<&impl KeyBackupStore>) {
    if let Some(backup) = backup {
        let _ = backup.write_key(key);
    }
}

#[derive(Debug, Clone)]
struct DpapiKeyBackupStore {
    path: PathBuf,
}

impl DpapiKeyBackupStore {
    fn new(service: &str, account: &str) -> Option<Self> {
        fallback_key_path(service, account).map(|path| Self { path })
    }
}

impl KeyBackupStore for DpapiKeyBackupStore {
    fn read_key(&self) -> Result<Vec<u8>, CryptoError> {
        if !self.path.exists() {
            return Err(CryptoError::SecretNotFound);
        }

        let bytes = fs::read(&self.path)
            .map_err(|error| CryptoError::ProtectedBackup(error.to_string()))?;
        unprotect_backup_bytes(&bytes)
    }

    fn write_key(&self, value: &[u8]) -> Result<(), CryptoError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| CryptoError::ProtectedBackup(error.to_string()))?;
        }

        let protected = protect_backup_bytes(value)?;
        fs::write(&self.path, protected)
            .map_err(|error| CryptoError::ProtectedBackup(error.to_string()))
    }
}

fn fallback_key_path(service: &str, account: &str) -> Option<PathBuf> {
    let root = env::var_os("LOCALAPPDATA")?;
    let service = sanitize_path_component(service);
    let account = sanitize_path_component(account);
    Some(
        Path::new(&root)
            .join(service)
            .join("key-backup")
            .join(format!("{account}.bin")),
    )
}

fn sanitize_path_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn protect_backup_bytes(value: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| CryptoError::ProtectedBackup(error.to_string()))?;

    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
fn unprotect_backup_bytes(value: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| CryptoError::ProtectedBackup(error.to_string()))?;

    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
    }
    Ok(bytes)
}

#[cfg(not(target_os = "windows"))]
fn protect_backup_bytes(value: &[u8]) -> Result<Vec<u8>, CryptoError> {
    Ok(value.to_vec())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_backup_bytes(value: &[u8]) -> Result<Vec<u8>, CryptoError> {
    Ok(value.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug)]
    struct MemorySecretStore {
        value: Mutex<Option<String>>,
    }

    impl MemorySecretStore {
        fn empty() -> Self {
            Self {
                value: Mutex::new(None),
            }
        }
    }

    impl SecretStore for MemorySecretStore {
        fn read_secret(&self) -> Result<String, CryptoError> {
            self.value
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .ok_or(CryptoError::SecretNotFound)
        }

        fn write_secret(&self, value: &str) -> Result<(), CryptoError> {
            *self
                .value
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value.to_owned());
            Ok(())
        }
    }

    #[derive(Debug)]
    struct MemoryBackupStore {
        value: Mutex<Option<Vec<u8>>>,
    }

    impl MemoryBackupStore {
        fn empty() -> Self {
            Self {
                value: Mutex::new(None),
            }
        }
    }

    impl KeyBackupStore for MemoryBackupStore {
        fn read_key(&self) -> Result<Vec<u8>, CryptoError> {
            self.value
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .ok_or(CryptoError::SecretNotFound)
        }

        fn write_key(&self, value: &[u8]) -> Result<(), CryptoError> {
            *self
                .value
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value.to_vec());
            Ok(())
        }
    }

    #[test]
    fn keyring_provider_persists_generated_key() {
        let store = MemorySecretStore::empty();

        let first = load_or_generate_key(&store, None::<&MemoryBackupStore>)
            .expect("provider should generate key");
        let second = load_or_generate_key(&store, None::<&MemoryBackupStore>)
            .expect("provider should reuse key");

        assert_eq!(first.len(), KEY_LEN);
        assert_eq!(first, second);
    }

    #[test]
    fn keyring_provider_restores_missing_secret_from_backup() {
        let store = MemorySecretStore::empty();
        let backup = MemoryBackupStore::empty();
        backup
            .write_key(&[7_u8; KEY_LEN])
            .expect("backup write should succeed");

        let key = load_or_generate_key(&store, Some(&backup))
            .expect("provider should restore key from backup");

        assert_eq!(key, vec![7_u8; KEY_LEN]);
        assert_eq!(
            store.read_secret().expect("store should be rewritten"),
            encode_hex(&key)
        );
    }

    #[test]
    fn keyring_provider_mirrors_existing_secret_into_backup() {
        let store = MemorySecretStore::empty();
        let backup = MemoryBackupStore::empty();
        let key = vec![9_u8; KEY_LEN];
        store
            .write_secret(&encode_hex(&key))
            .expect("store write should succeed");

        let loaded = load_or_generate_key(&store, Some(&backup))
            .expect("provider should load existing store secret");

        assert_eq!(loaded, key);
        assert_eq!(
            backup.read_key().expect("backup should be populated"),
            loaded
        );
    }
}
