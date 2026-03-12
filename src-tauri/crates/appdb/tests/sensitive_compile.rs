#[test]
fn sensitive_macro_rules_are_enforced() {
    let tests = trybuild::TestCases::new();
    tests.compile_fail("tests/ui/sensitive/no_secure_fields.rs");
    tests.compile_fail("tests/ui/sensitive/unsupported_secure_type.rs");
}
