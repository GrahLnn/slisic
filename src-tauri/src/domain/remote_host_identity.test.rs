use super::*;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

#[test]
fn encoded_identity_round_trip_preserves_host_ownership() {
    let identity = RemoteHostIdentity::generate();
    let restored = RemoteHostIdentity::from_encoded_secret(&identity.encoded_secret()).unwrap();

    assert_eq!(restored.host_id(), identity.host_id());
    assert_eq!(restored.encoded_public_key(), identity.encoded_public_key());
}

#[test]
fn host_and_code_change_signatures_match_the_relay_transcripts() {
    let identity = RemoteHostIdentity::generate();
    let public_key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(identity.encoded_public_key())
        .unwrap()
        .try_into()
        .unwrap();
    let verifying_key = VerifyingKey::from_bytes(&public_key).unwrap();

    let host_signature = URL_SAFE_NO_PAD
        .decode(identity.sign_host_challenge("nonce", "GRAHLNN", 41))
        .unwrap();
    verifying_key
        .verify(
            host_proof_transcript("nonce", &identity.host_id(), "GRAHLNN", 41).as_bytes(),
            &Signature::from_slice(&host_signature).unwrap(),
        )
        .unwrap();

    let change_signature = URL_SAFE_NO_PAD
        .decode(identity.sign_code_change("tx", "GRAHLNN", "NEWCODE", 3))
        .unwrap();
    verifying_key
        .verify(
            code_change_transcript("tx", &identity.host_id(), "GRAHLNN", "NEWCODE", 3).as_bytes(),
            &Signature::from_slice(&change_signature).unwrap(),
        )
        .unwrap();

    let claim_signature = URL_SAFE_NO_PAD
        .decode(identity.sign_code_claim("claim", "GRAHLNN"))
        .unwrap();
    verifying_key
        .verify(
            code_claim_transcript("claim", &identity.host_id(), "GRAHLNN").as_bytes(),
            &Signature::from_slice(&claim_signature).unwrap(),
        )
        .unwrap();
}
