//! Byte arrays that cross the UniFFI boundary in one copy.
//!
//! UniFFI carries a `Vec<u8>` as an `i32` big-endian length followed by the
//! bytes, but its Rust side converts that buffer through the generic
//! `Vec<T>` path: one bounds check and one push per byte. An RGBA input is
//! `w * h * 4` bytes, so that loop, not the encode, was most of what the
//! binding added to an encode (`tools/comparison/results/counts/overhead/`).
//!
//! [`Bytes`] and [`SharedBytes`] write and read the same wire bytes with one
//! slice copy, and declare the same type metadata as `Vec<u8>`, so the
//! scaffolding's checksums and every generated Kotlin, Swift and Python
//! binding are unchanged: the foreign side still sees `ByteArray`, `Data` and
//! `bytes`. [`SharedBytes`] lifts straight into the `Arc<[u8]>` the core's
//! batch encoder takes, where a `Vec<u8>` would be copied a second time.

use std::ops::Deref;
use std::sync::Arc;

use uniffi::{FfiConverter, MetadataBuffer, RustBuffer, TypeId};

use crate::UniFfiTag;

/// The wire form's length prefix: the byte count as a big-endian `i32`.
fn put_len(len: usize, buf: &mut Vec<u8>) {
    // UniFFI limits a sequence to i32::MAX items and panics past it too.
    let len = i32::try_from(len).expect("a byte array longer than i32::MAX");
    buf.extend_from_slice(&len.to_be_bytes());
}

/// Read one length-prefixed byte array off the front of `buf`, rejecting a
/// negative length or one that overruns the buffer, as UniFFI's own `Vec<u8>`
/// lift does.
fn read_bytes<'a>(buf: &mut &'a [u8]) -> uniffi::Result<&'a [u8]> {
    uniffi::check_remaining(buf, 4)?;
    let (prefix, rest) = buf.split_at(4);
    let len = i32::from_be_bytes(prefix.try_into().expect("4 bytes"));
    let len = usize::try_from(len)?;
    uniffi::check_remaining(rest, len)?;
    let (bytes, rest) = rest.split_at(len);
    *buf = rest;
    Ok(bytes)
}

/// A top-level argument's buffer holds exactly one byte array; anything left
/// after it is the error UniFFI's own lift raises.
fn lift_only(vec: &[u8]) -> uniffi::Result<usize> {
    let mut rest = vec;
    let len = read_bytes(&mut rest)?.len();
    if !rest.is_empty() {
        uniffi::deps::anyhow::bail!(
            "junk data left in buffer after lifting (count: {})",
            rest.len()
        );
    }
    Ok(len)
}

fn lower_bytes(bytes: &[u8]) -> RustBuffer {
    let mut buf = Vec::with_capacity(4 + bytes.len());
    put_len(bytes.len(), &mut buf);
    buf.extend_from_slice(bytes);
    RustBuffer::from_vec(buf)
}

/// An owned byte array, carried across the boundary in one copy. Derefs to
/// `[u8]`; convert from and into `Vec<u8>` with `From`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);

// SAFETY: the FFI type is a RustBuffer in UniFFI's own byte-array wire form,
// and the metadata is exactly `Vec<u8>`'s, so foreign code built for
// `Vec<u8>` reads and writes it correctly.
unsafe impl FfiConverter<UniFfiTag> for Bytes {
    type FfiType = RustBuffer;

    fn lower(obj: Self) -> RustBuffer {
        lower_bytes(&obj.0)
    }

    fn try_lift(buf: RustBuffer) -> uniffi::Result<Self> {
        let mut vec = buf.destroy_into_vec();
        lift_only(&vec)?;
        // Reuse the argument's allocation: shift the bytes over the prefix.
        vec.drain(..4);
        Ok(Bytes(vec))
    }

    fn write(obj: Self, buf: &mut Vec<u8>) {
        put_len(obj.0.len(), buf);
        buf.extend_from_slice(&obj.0);
    }

    fn try_read(buf: &mut &[u8]) -> uniffi::Result<Self> {
        Ok(Bytes(read_bytes(buf)?.to_vec()))
    }

    const TYPE_ID_META: MetadataBuffer = <Vec<u8> as TypeId<UniFfiTag>>::TYPE_ID_META;
}

uniffi::derive_ffi_traits!(local Bytes);

impl Deref for Bytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl From<Vec<u8>> for Bytes {
    fn from(v: Vec<u8>) -> Self {
        Bytes(v)
    }
}

impl From<Bytes> for Vec<u8> {
    fn from(b: Bytes) -> Self {
        b.0
    }
}

impl PartialEq<Vec<u8>> for Bytes {
    fn eq(&self, other: &Vec<u8>) -> bool {
        self.0 == *other
    }
}

impl PartialEq<[u8]> for Bytes {
    fn eq(&self, other: &[u8]) -> bool {
        self.0 == other
    }
}

/// A shared, immutable byte array: the `Arc<[u8]>` the core's batch encoder
/// takes, lifted from the boundary in one copy. Derefs to `[u8]`; convert from
/// `Vec<u8>` or `Arc<[u8]>` with `From`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedBytes(pub Arc<[u8]>);

// SAFETY: as for `Bytes` — the same wire form and the same metadata.
unsafe impl FfiConverter<UniFfiTag> for SharedBytes {
    type FfiType = RustBuffer;

    fn lower(obj: Self) -> RustBuffer {
        lower_bytes(&obj.0)
    }

    fn try_lift(buf: RustBuffer) -> uniffi::Result<Self> {
        let vec = buf.destroy_into_vec();
        let len = lift_only(&vec)?;
        Ok(SharedBytes(Arc::from(&vec[4..4 + len])))
    }

    fn write(obj: Self, buf: &mut Vec<u8>) {
        put_len(obj.0.len(), buf);
        buf.extend_from_slice(&obj.0);
    }

    fn try_read(buf: &mut &[u8]) -> uniffi::Result<Self> {
        Ok(SharedBytes(Arc::from(read_bytes(buf)?)))
    }

    const TYPE_ID_META: MetadataBuffer = <Vec<u8> as TypeId<UniFfiTag>>::TYPE_ID_META;
}

uniffi::derive_ffi_traits!(local SharedBytes);

impl Deref for SharedBytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl From<Vec<u8>> for SharedBytes {
    fn from(v: Vec<u8>) -> Self {
        SharedBytes(Arc::from(v))
    }
}

impl From<Arc<[u8]>> for SharedBytes {
    fn from(a: Arc<[u8]>) -> Self {
        SharedBytes(a)
    }
}

impl PartialEq<Vec<u8>> for SharedBytes {
    fn eq(&self, other: &Vec<u8>) -> bool {
        *self.0 == **other
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uniffi::{Lift, Lower};

    /// The wire bytes UniFFI's own `Vec<u8>` converter writes.
    fn reference(bytes: &[u8]) -> Vec<u8> {
        let buf = <Vec<u8> as Lower<UniFfiTag>>::lower(bytes.to_vec());
        buf.destroy_into_vec()
    }

    const SAMPLES: [&[u8]; 3] = [&[], &[7], &[0, 255, 1, 128, 64, 3]];

    #[test]
    fn lowers_to_uniffis_own_wire_bytes() {
        for s in SAMPLES {
            let ours = <Bytes as FfiConverter<UniFfiTag>>::lower(Bytes(s.to_vec()));
            assert_eq!(ours.destroy_into_vec(), reference(s));
            let shared =
                <SharedBytes as FfiConverter<UniFfiTag>>::lower(SharedBytes::from(s.to_vec()));
            assert_eq!(shared.destroy_into_vec(), reference(s));
            let mut written = Vec::new();
            <Bytes as FfiConverter<UniFfiTag>>::write(Bytes(s.to_vec()), &mut written);
            assert_eq!(written, reference(s));
        }
    }

    #[test]
    fn lifts_uniffis_own_wire_bytes() {
        for s in SAMPLES {
            let lifted =
                <Bytes as FfiConverter<UniFfiTag>>::try_lift(RustBuffer::from_vec(reference(s)));
            assert_eq!(lifted.expect("lift"), s.to_vec());
            let shared = <SharedBytes as FfiConverter<UniFfiTag>>::try_lift(RustBuffer::from_vec(
                reference(s),
            ));
            assert_eq!(shared.expect("lift"), s.to_vec());
        }
    }

    #[test]
    fn reads_one_array_and_leaves_the_rest() {
        let mut wire = reference(&[1, 2, 3]);
        wire.extend_from_slice(&reference(&[9]));
        let mut rest = wire.as_slice();
        let first = <Bytes as FfiConverter<UniFfiTag>>::try_read(&mut rest).expect("read");
        assert_eq!(first, vec![1, 2, 3]);
        let second = <SharedBytes as FfiConverter<UniFfiTag>>::try_read(&mut rest).expect("read");
        assert_eq!(second, vec![9]);
        assert!(rest.is_empty());
    }

    #[test]
    fn rejects_what_uniffis_own_lift_rejects() {
        let negative = (-1i32).to_be_bytes().to_vec();
        let overrun = [&5i32.to_be_bytes()[..], &[1, 2]].concat();
        let short_prefix = vec![0u8, 0];
        let mut junk = reference(&[1, 2]);
        junk.push(0);
        for bad in [negative, overrun, short_prefix, junk] {
            let reference_lift =
                <Vec<u8> as Lift<UniFfiTag>>::try_lift(RustBuffer::from_vec(bad.clone()));
            assert!(reference_lift.is_err(), "UniFFI accepts {bad:?}");
            let ours =
                <Bytes as FfiConverter<UniFfiTag>>::try_lift(RustBuffer::from_vec(bad.clone()));
            assert!(ours.is_err(), "Bytes accepts {bad:?}");
            let shared = <SharedBytes as FfiConverter<UniFfiTag>>::try_lift(RustBuffer::from_vec(
                bad.clone(),
            ));
            assert!(shared.is_err(), "SharedBytes accepts {bad:?}");
        }
    }

    #[test]
    fn declares_vec_u8s_metadata() {
        let meta = |m: MetadataBuffer| m.bytes[..m.size].to_vec();
        let vec_meta = meta(<Vec<u8> as TypeId<UniFfiTag>>::TYPE_ID_META);
        assert_eq!(meta(<Bytes as TypeId<UniFfiTag>>::TYPE_ID_META), vec_meta);
        assert_eq!(
            meta(<SharedBytes as TypeId<UniFfiTag>>::TYPE_ID_META),
            vec_meta
        );
    }
}
