// Package chromahash implements the ChromaHash LQIP (Low Quality Image
// Placeholder) format — a compact, variable-length representation of an image
// (32 bytes at the default quality tier, larger at higher tiers).
//
// This package is a thin cgo wrapper over the chromahash-c C ABI, which exposes
// the zero-dependency Rust core. Output is byte-identical to every other
// ChromaHash implementation. Because it uses cgo, builds require a C toolchain
// (CGO_ENABLED=1) and the prebuilt static library under go/lib — run
// `mise run build:go` (which builds + stages it) rather than a bare `go build`.
package chromahash

/*
#cgo CFLAGS: -I${SRCDIR}/include
#cgo LDFLAGS: -L${SRCDIR}/lib -lchromahash_c
#cgo linux LDFLAGS: -lm -ldl -lpthread
#include "chromahash.h"
*/
import "C"

import (
	"errors"
	"runtime"
	"unsafe"
)

// Tier codes, ordered by quality (spec §2.5). Codes 5..=7 are reserved.
const (
	// CompactTier is the 21-byte compact tier — the smallest and lowest
	// fidelity, rendered at DefaultTier's resolution.
	CompactTier uint8 = 0
	// DefaultTier is the 32-byte tier Encode produces. Pass this rather than a
	// literal: the codes are ordered by quality, so a bare 0 selects the
	// compact tier.
	DefaultTier uint8 = 1
	// MaxTier is the highest valid tier code.
	MaxTier uint8 = 4
)

// abiTierCodes returns the tier codes as the linked C ABI exports them.
//
// The codes above are declared as Go consts so they can be used in constant
// expressions, but the format owns them and the C ABI is where this package
// gets everything else. cgo is unavailable in _test.go files, so the parity
// test reaches the exported symbols through here.
func abiTierCodes() (compact, def, max uint8) {
	return uint8(C.CHROMAHASH_COMPACT_TIER),
		uint8(C.CHROMAHASH_DEFAULT_TIER),
		uint8(C.CHROMAHASH_MAX_TIER)
}

// ChromaHash is a variable-length LQIP representation of an image (32 bytes at
// the default tier; the length is self-describing via the header).
type ChromaHash struct {
	Hash []byte
}

// Encode encodes an RGBA image into a ChromaHash.
//
// w, h are the image dimensions (>=1 each).
// rgba is the pixel data in RGBA format (4 bytes per pixel, row-major).
// gamut is the source color space.
//
// Panics if dimensions are out of range or rgba length doesn't match.
func Encode(w, h int, rgba []byte, gamut Gamut) ChromaHash {
	if w < 1 {
		panic("chromahash: width must be >= 1")
	}
	if h < 1 {
		panic("chromahash: height must be >= 1")
	}
	if len(rgba) != w*h*4 {
		panic("chromahash: rgba length mismatch")
	}

	return EncodeWithQuality(w, h, rgba, gamut, DefaultTier)
}

// EncodeWithQuality encodes an RGBA image at an explicit quality tier
// (0..=MaxTier, ordered by quality). DefaultTier is the 32-byte tier and
// CompactTier the 21-byte one; each higher code carries more detail in a larger
// hash. See Encode for the argument contract.
func EncodeWithQuality(w, h int, rgba []byte, gamut Gamut, quality uint8) ChromaHash {
	if w < 1 {
		panic("chromahash: width must be >= 1")
	}
	if h < 1 {
		panic("chromahash: height must be >= 1")
	}
	if len(rgba) != w*h*4 {
		panic("chromahash: rgba length mismatch")
	}
	if !gamut.valid() {
		panic("chromahash: unknown gamut")
	}

	var handle *C.ChromaHash
	status := C.chromahash_encode_with_quality(
		C.uint32_t(w),
		C.uint32_t(h),
		(*C.uint8_t)(unsafe.Pointer(&rgba[0])),
		C.size_t(len(rgba)),
		C.ChromaHashGamut(gamut),
		C.uint8_t(quality),
		&handle,
	)
	runtime.KeepAlive(rgba)
	if status != C.CHROMA_HASH_STATUS_OK || handle == nil {
		panic("chromahash: encode failed")
	}
	defer C.chromahash_free(handle)

	return readHash(handle)
}

// readHash copies a handle's variable-length bytes into a ChromaHash.
func readHash(handle *C.ChromaHash) ChromaHash {
	n := int(C.chromahash_byte_len(handle))
	out := ChromaHash{Hash: make([]byte, n)}
	if n > 0 {
		if C.chromahash_as_bytes(handle, (*C.uint8_t)(unsafe.Pointer(&out.Hash[0])), C.size_t(n)) != C.CHROMA_HASH_STATUS_OK {
			panic("chromahash: as_bytes failed")
		}
	}
	return out
}

// ErrInvalidHash is returned by FromBytes for bytes that are not a valid v2
// ChromaHash: an unsupported version, a reserved tier code, a set reserved bit,
// or a length that disagrees with the self-describing header.
var ErrInvalidHash = errors.New("chromahash: not a valid ChromaHash")

// FromBytes creates a ChromaHash from raw hash bytes, validating them up front.
//
// The format is self-describing, so the header fixes the exact byte length: a
// ChromaHash that comes back from FromBytes is guaranteed to decode. Anything
// else returns ErrInvalidHash rather than deferring the failure to Decode.
func FromBytes(b []byte) (ChromaHash, error) {
	if len(b) == 0 {
		return ChromaHash{}, ErrInvalidHash
	}
	var handle *C.ChromaHash
	status := C.chromahash_from_bytes(
		(*C.uint8_t)(unsafe.Pointer(&b[0])),
		C.size_t(len(b)),
		&handle,
	)
	runtime.KeepAlive(b)
	if status != C.CHROMA_HASH_STATUS_OK || handle == nil {
		return ChromaHash{}, ErrInvalidHash
	}
	C.chromahash_free(handle)

	// Copy: the caller keeps ownership of b, and a ChromaHash that validated
	// must not be invalidated by a later write to the caller's slice.
	hash := make([]byte, len(b))
	copy(hash, b)
	return ChromaHash{Hash: hash}, nil
}

// handle reconstructs an opaque C handle from the hash bytes, validating the
// v1 header. Reachable with invalid bytes only through a hand-built
// ChromaHash literal — FromBytes validates — so it panics rather than
// widening every accessor to return an error. The caller must free the handle
// with C.chromahash_free.
func (ch *ChromaHash) handle() *C.ChromaHash {
	if len(ch.Hash) == 0 {
		panic("chromahash: from_bytes failed")
	}
	var handle *C.ChromaHash
	status := C.chromahash_from_bytes(
		(*C.uint8_t)(unsafe.Pointer(&ch.Hash[0])),
		C.size_t(len(ch.Hash)),
		&handle,
	)
	if status != C.CHROMA_HASH_STATUS_OK || handle == nil {
		panic("chromahash: from_bytes failed")
	}
	return handle
}

// Decode decodes the ChromaHash into an sRGB RGBA image.
// Returns width, height, and RGBA pixel data (row-major, 4 bytes per pixel).
func (ch ChromaHash) Decode() (int, int, []byte) {
	return ch.DecodeTo(GamutSRGB)
}

// DecodeTo decodes the ChromaHash into an RGBA image in the given output gamut
// (GamutSRGB / GamutDisplayP3 / GamutAdobeRGB; others fall back to sRGB).
// Returns width, height, and RGBA pixel data.
func (ch ChromaHash) DecodeTo(output Gamut) (int, int, []byte) {
	if !output.valid() {
		panic("chromahash: unknown gamut")
	}
	handle := ch.handle()
	defer C.chromahash_free(handle)
	var img C.ChromaHashImage
	if C.chromahash_decode_to(handle, C.ChromaHashGamut(output), &img) != C.CHROMA_HASH_STATUS_OK {
		panic("chromahash: decode failed")
	}
	return readImage(&img)
}

// DecodeCapped decodes into an sRGB RGBA image, capped at the given maximum
// dimensions. Returns width, height, and RGBA pixel data.
func (ch ChromaHash) DecodeCapped(maxW, maxH int) (int, int, []byte) {
	return ch.DecodeCappedTo(maxW, maxH, GamutSRGB)
}

// DecodeCappedTo decodes (see DecodeCapped) in the given output gamut.
func (ch ChromaHash) DecodeCappedTo(maxW, maxH int, output Gamut) (int, int, []byte) {
	if !output.valid() {
		panic("chromahash: unknown gamut")
	}
	handle := ch.handle()
	defer C.chromahash_free(handle)
	var img C.ChromaHashImage
	if C.chromahash_decode_capped_to(handle, C.uint32_t(maxW), C.uint32_t(maxH), C.ChromaHashGamut(output), &img) != C.CHROMA_HASH_STATUS_OK {
		panic("chromahash: decode_capped failed")
	}
	return readImage(&img)
}

// readImage copies a library-owned ChromaHashImage into Go memory and frees it.
func readImage(img *C.ChromaHashImage) (int, int, []byte) {
	defer C.chromahash_image_free(img)
	n := C.int(img.rgba_len)
	var rgba []byte
	if n > 0 {
		rgba = C.GoBytes(unsafe.Pointer(img.rgba), n)
	}
	return int(img.width), int(img.height), rgba
}

// AverageColor extracts the average color from the ChromaHash without a full
// decode. Returns r, g, b, a as uint8 values. Per spec §11.2.
func (ch ChromaHash) AverageColor() (r, g, b, a uint8) {
	handle := ch.handle()
	defer C.chromahash_free(handle)
	var color C.ChromaHashColor
	if C.chromahash_average_color(handle, &color) != C.CHROMA_HASH_STATUS_OK {
		panic("chromahash: average_color failed")
	}
	return uint8(color.r), uint8(color.g), uint8(color.b), uint8(color.a)
}
