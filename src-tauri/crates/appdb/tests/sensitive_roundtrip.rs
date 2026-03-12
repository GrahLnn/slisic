use appdb::crypto::CryptoContext;
use appdb::Sensitive;
use serde::{Deserialize, Serialize};
use surrealdb::types::SurrealValue;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Sensitive)]
struct BankCard {
    pub issuer: String,

    #[secure]
    pub number: String,

    #[secure]
    pub cvv: String,
}

#[test]
fn sensitive_record_roundtrip_encrypts_only_secure_fields() {
    let ctx = CryptoContext::new([7_u8; 32]).expect("context should build");
    let card = BankCard {
        issuer: "ACME Bank".to_owned(),
        number: "4111111111111111".to_owned(),
        cvv: "123".to_owned(),
    };

    let encrypted = card.encrypt(&ctx).expect("record should encrypt");

    assert_eq!(encrypted.issuer, card.issuer);
    assert_ne!(encrypted.number, card.number.as_bytes());
    assert_ne!(encrypted.cvv, card.cvv.as_bytes());

    let decrypted = encrypted.decrypt(&ctx).expect("record should decrypt");
    assert_eq!(decrypted, card);
}
