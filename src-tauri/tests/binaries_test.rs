mod utils {
    pub mod binaries {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/utils/binaries.rs"
        ));
    }

    mod binaries_test {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/utils/binaries.test.rs"
        ));
    }
}
