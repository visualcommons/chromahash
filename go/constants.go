package chromahash

// Gamut identifies the source color space. Values match the chromahash-c ABI's
// CHROMA_HASH_GAMUT_* constants (and the Rust core's Gamut), so a plain
// conversion crosses the FFI. Any other value panics before it reaches the ABI.
type Gamut int

const (
	GamutSRGB Gamut = iota
	GamutDisplayP3
	GamutAdobeRGB
	GamutBT2020
	GamutProPhotoRGB
)

// valid reports whether g is one of the Gamut constants. Gamut is an int, so
// Gamut(5) compiles, and the C ABI takes an int32_t: without this check a value
// such as 1<<32 would truncate to GamutSRGB at the conversion.
func (g Gamut) valid() bool {
	return g >= GamutSRGB && g <= GamutProPhotoRGB
}
