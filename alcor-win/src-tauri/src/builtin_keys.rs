//! Keys bundled at build time (see build.rs). They are unmasked only when a request needs them and never leave Rust;
//! a key the user stores in Credential Manager always takes precedence.

mod generated {
    include!(concat!(env!("OUT_DIR"), "/builtin_keys.rs"));
}

pub fn get(name: &str) -> Option<String> {
    let (_, masked, pad) = generated::BUNDLED.iter().find(|(n, _, _)| *n == name)?;
    String::from_utf8(masked.iter().zip(pad.iter()).map(|(b, p)| b ^ p).collect()).ok()
}

pub fn has(name: &str) -> bool {
    generated::BUNDLED.iter().any(|(n, _, _)| *n == name)
}

#[cfg(test)]
mod tests {
    #[test]
    fn unknown_names_have_no_key() {
        assert!(super::get("not-a-secret").is_none());
        assert!(!super::has("not-a-secret"));
    }

    #[test]
    fn bundled_keys_unmask_to_non_empty_text() {
        for (name, masked, pad) in super::generated::BUNDLED {
            assert_eq!(masked.len(), pad.len());
            assert!(super::get(name).is_some_and(|k| !k.is_empty()));
        }
    }
}
