use anyhow::{Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use rand::RngExt;
use sha2::{Digest, Sha256};

const HOST_PROOF_VERSION: &str = "slisic-host-v1";
const CODE_CLAIM_VERSION: &str = "slisic-code-claim-v1";
const CODE_CHANGE_VERSION: &str = "slisic-code-change-v1";

#[derive(Clone)]
pub(super) struct RemoteHostIdentity {
    signing_key: SigningKey,
}

impl RemoteHostIdentity {
    pub(super) fn generate() -> Self {
        let mut secret = [0_u8; 32];
        rand::rng().fill(&mut secret);
        Self {
            signing_key: SigningKey::from_bytes(&secret),
        }
    }

    pub(super) fn from_encoded_secret(encoded: &str) -> Result<Self> {
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|error| anyhow!(error.to_string()))?;
        let secret: [u8; 32] = decoded
            .try_into()
            .map_err(|_| anyhow!("remote host identity must contain 32 bytes"))?;
        Ok(Self {
            signing_key: SigningKey::from_bytes(&secret),
        })
    }

    pub(super) fn encoded_secret(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.signing_key.to_bytes())
    }

    pub(super) fn encoded_public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.signing_key.verifying_key().to_bytes())
    }

    pub(super) fn host_id(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.signing_key.verifying_key().to_bytes()))
    }

    pub(super) fn sign_host_challenge(
        &self,
        nonce: &str,
        code: &str,
        connection_epoch: u64,
    ) -> String {
        self.sign(&host_proof_transcript(
            nonce,
            &self.host_id(),
            code,
            connection_epoch,
        ))
    }

    pub(super) fn sign_code_change(
        &self,
        transaction_id: &str,
        expected_code: &str,
        desired_code: &str,
        expected_revision: u64,
    ) -> String {
        self.sign(&code_change_transcript(
            transaction_id,
            &self.host_id(),
            expected_code,
            desired_code,
            expected_revision,
        ))
    }

    pub(super) fn sign_code_claim(&self, transaction_id: &str, code: &str) -> String {
        self.sign(&code_claim_transcript(
            transaction_id,
            &self.host_id(),
            code,
        ))
    }

    fn sign(&self, transcript: &str) -> String {
        URL_SAFE_NO_PAD.encode(self.signing_key.sign(transcript.as_bytes()).to_bytes())
    }
}

pub(super) fn host_proof_transcript(
    nonce: &str,
    host_id: &str,
    code: &str,
    connection_epoch: u64,
) -> String {
    format!("{HOST_PROOF_VERSION}\n{nonce}\n{host_id}\n{code}\n{connection_epoch}")
}

pub(super) fn code_change_transcript(
    transaction_id: &str,
    host_id: &str,
    expected_code: &str,
    desired_code: &str,
    expected_revision: u64,
) -> String {
    format!(
        "{CODE_CHANGE_VERSION}\n{transaction_id}\n{host_id}\n{expected_code}\n{desired_code}\n{expected_revision}"
    )
}

pub(super) fn code_claim_transcript(transaction_id: &str, host_id: &str, code: &str) -> String {
    format!("{CODE_CLAIM_VERSION}\n{transaction_id}\n{host_id}\n{code}")
}

#[cfg(test)]
#[path = "remote_host_identity.test.rs"]
mod tests;
