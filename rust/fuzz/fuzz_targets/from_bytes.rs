//! `ChromaHash::from_bytes` on arbitrary bytes.
//!
//! The fail-fast contract (spec §2.6): every byte string is either rejected
//! with the error the spec's checks name, in the spec's order, or accepted —
//! and an accepted hash decodes, at its tier's natural size, without a panic.
#![no_main]

use chromahash::ChromaHash;
use chromahash_fuzz::{check_natural, expected_validation};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let got = ChromaHash::from_bytes(data);
    assert_eq!(
        got.as_ref().map(|_| ()).map_err(|e| *e),
        expected_validation(data),
        "from_bytes disagrees with spec §2.6 on {} bytes",
        data.len()
    );
    let Ok(hash) = got else { return };
    assert_eq!(hash.as_bytes(), data, "from_bytes did not keep the bytes");
    let (w, h, rgba) = hash.decode();
    check_natural(&hash, w, h, &rgba);
    // Cheap, and reads the same header and DC fields by a separate path.
    let _ = hash.average_color();
});
