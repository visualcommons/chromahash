package chromahash

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"testing"
)

// The Go package is now a thin cgo wrapper over the chromahash-c C ABI, so these
// tests exercise the public API end-to-end against the shared spec vectors —
// the cross-language parity gate. Per-function unit tests of the algorithm live
// in the Rust core (the single source of truth).

// ── helpers (shared with batch_test.go / batch_bench_test.go) ─────────────────

func solidImage(w, h int, r, g, b, a byte) []byte {
	rgba := make([]byte, w*h*4)
	for i := 0; i < w*h; i++ {
		rgba[i*4] = r
		rgba[i*4+1] = g
		rgba[i*4+2] = b
		rgba[i*4+3] = a
	}
	return rgba
}

func horizontalGradient(w, h int) []byte {
	rgba := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			t := float64(x) / math.Max(float64(w-1), 1)
			idx := (y*w + x) * 4
			rgba[idx] = byte(t * 255)
			rgba[idx+1] = byte((1.0 - t) * 255)
			rgba[idx+2] = 128
			rgba[idx+3] = 255
		}
	}
	return rgba
}

func verticalGradient(w, h int) []byte {
	rgba := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		t := float64(y) / math.Max(float64(h-1), 1)
		for x := 0; x < w; x++ {
			idx := (y*w + x) * 4
			rgba[idx] = byte(t * 255)
			rgba[idx+1] = byte(t * 128)
			rgba[idx+2] = byte((1.0 - t) * 255)
			rgba[idx+3] = 255
		}
	}
	return rgba
}

func gamutFromString(s string) Gamut {
	switch s {
	case "sRGB":
		return GamutSRGB
	case "Display P3":
		return GamutDisplayP3
	case "Adobe RGB":
		return GamutAdobeRGB
	case "BT.2020":
		return GamutBT2020
	case "ProPhoto RGB":
		return GamutProPhotoRGB
	default:
		// Falling back to sRGB turned an unrecognised gamut into a hash
		// mismatch on an unrelated assertion. Fail where the cause is, as the
		// Rust and C vector harnesses do.
		panic(fmt.Sprintf("unknown gamut in spec vector: %q", s))
	}
}

// ── integration-encode.json ──────────────────────────────────────────────────

type encodeTestCase struct {
	Name  string `json:"name"`
	Input struct {
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Gamut  string `json:"gamut"`
		Tier   int    `json:"tier"`
		RGBA   []int  `json:"rgba"`
	} `json:"input"`
	Expected struct {
		Hash         []int  `json:"hash"`
		AverageColor [4]int `json:"average_color"`
	} `json:"expected"`
}

func TestIntegrationEncode(t *testing.T) {
	data, err := os.ReadFile("../spec/test-vectors/integration-encode.json")
	if err != nil {
		t.Fatalf("integration-encode.json not found: %v", err)
	}
	var cases []encodeTestCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("parse integration-encode.json: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("no encode vectors found")
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			rgba := make([]byte, len(tc.Input.RGBA))
			for i, v := range tc.Input.RGBA {
				rgba[i] = byte(v)
			}
			ch := EncodeWithQuality(tc.Input.Width, tc.Input.Height, rgba, gamutFromString(tc.Input.Gamut), uint8(tc.Input.Tier))
			if len(ch.Hash) != len(tc.Expected.Hash) {
				t.Fatalf("hash length = %d, want %d", len(ch.Hash), len(tc.Expected.Hash))
			}
			for i, want := range tc.Expected.Hash {
				if int(ch.Hash[i]) != want {
					t.Errorf("hash[%d] = %d, want %d", i, ch.Hash[i], want)
				}
			}
			r, g, b, a := ch.AverageColor()
			avg := [4]int{int(r), int(g), int(b), int(a)}
			for i := 0; i < 4; i++ {
				if avg[i] != tc.Expected.AverageColor[i] {
					t.Errorf("average_color[%d] = %d, want %d", i, avg[i], tc.Expected.AverageColor[i])
				}
			}
		})
	}
}

// ── integration-decode.json ──────────────────────────────────────────────────

type decodeTestCase struct {
	Name  string `json:"name"`
	Input struct {
		Hash []int `json:"hash"`
	} `json:"input"`
	Expected struct {
		Width  int   `json:"width"`
		Height int   `json:"height"`
		RGBA   []int `json:"rgba"`
	} `json:"expected"`
}

func TestIntegrationDecode(t *testing.T) {
	data, err := os.ReadFile("../spec/test-vectors/integration-decode.json")
	if err != nil {
		t.Fatalf("integration-decode.json not found: %v", err)
	}
	var cases []decodeTestCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("parse integration-decode.json: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("no decode vectors found")
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			hashBytes := make([]byte, len(tc.Input.Hash))
			for i, v := range tc.Input.Hash {
				hashBytes[i] = byte(v)
			}
			ch, err := FromBytes(hashBytes)
			if err != nil {
				t.Fatalf("FromBytes rejected a spec vector: %v", err)
			}
			w, h, rgba := ch.Decode()
			if w != tc.Expected.Width {
				t.Errorf("width = %d, want %d", w, tc.Expected.Width)
			}
			if h != tc.Expected.Height {
				t.Errorf("height = %d, want %d", h, tc.Expected.Height)
			}
			for i, want := range tc.Expected.RGBA {
				if int(rgba[i]) != want {
					t.Errorf("rgba[%d] = %d, want %d", i, rgba[i], want)
				}
			}
		})
	}
}

// ── integration-decode-capped.json ────────────────────────────────────────────

type cappedDecodeTestCase struct {
	Name  string `json:"name"`
	Input struct {
		Hash     []int `json:"hash"`
		MaxWidth int   `json:"max_width"`
		MaxHt    int   `json:"max_height"`
	} `json:"input"`
	Expected struct {
		Width  int   `json:"width"`
		Height int   `json:"height"`
		RGBA   []int `json:"rgba"`
	} `json:"expected"`
}

func TestIntegrationDecodeCapped(t *testing.T) {
	data, err := os.ReadFile("../spec/test-vectors/integration-decode-capped.json")
	if err != nil {
		t.Fatalf("integration-decode-capped.json not found: %v", err)
	}
	var cases []cappedDecodeTestCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("parse integration-decode-capped.json: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("no capped decode vectors found")
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			hashBytes := make([]byte, len(tc.Input.Hash))
			for i, v := range tc.Input.Hash {
				hashBytes[i] = byte(v)
			}
			ch, err := FromBytes(hashBytes)
			if err != nil {
				t.Fatalf("FromBytes rejected a spec vector: %v", err)
			}
			w, h, rgba := ch.DecodeCapped(tc.Input.MaxWidth, tc.Input.MaxHt)
			if w != tc.Expected.Width {
				t.Errorf("width = %d, want %d", w, tc.Expected.Width)
			}
			if h != tc.Expected.Height {
				t.Errorf("height = %d, want %d", h, tc.Expected.Height)
			}
			for i, want := range tc.Expected.RGBA {
				if int(rgba[i]) != want {
					t.Errorf("rgba[%d] = %d, want %d", i, rgba[i], want)
				}
			}
		})
	}
}

// ── property tests ─────────────────────────────────────────────────────────────

// tierByteLengths is the opaque-image hash length for each tier code, indexed
// by the code — the table spec §3.3 tabulates.
var tierByteLengths = [MaxTier + 1]int{21, 32, 108, 411, 1623}

// The byte length is a function of the tier alone, so assert all five rather
// than only the default.
func TestEachTierEncodesToItsDocumentedLength(t *testing.T) {
	rgba := solidImage(4, 4, 128, 128, 128, 255)
	for tier, want := range tierByteLengths {
		ch := EncodeWithQuality(4, 4, rgba, GamutSRGB, uint8(tier))
		if len(ch.Hash) != want {
			t.Errorf("tier %d: hash length = %d, want %d", tier, len(ch.Hash), want)
		}
	}
	if got := len(Encode(4, 4, rgba, GamutSRGB).Hash); got != tierByteLengths[DefaultTier] {
		t.Errorf("Encode default length = %d, want %d", got, tierByteLengths[DefaultTier])
	}
}

// The tier codes are declared here as Go consts for idiom, but the format
// defines them and the C ABI exports them. Assert the two agree, so a renumber
// in the core cannot leave this package quietly one code behind.
func TestTierConstantsMatchTheCABI(t *testing.T) {
	abiCompact, abiDefault, abiMax := abiTierCodes()
	for _, tc := range []struct {
		name    string
		go_, c_ uint8
	}{
		{"CompactTier", CompactTier, abiCompact},
		{"DefaultTier", DefaultTier, abiDefault},
		{"MaxTier", MaxTier, abiMax},
	} {
		if tc.go_ != tc.c_ {
			t.Errorf("%s = %d in Go, %d in the C ABI", tc.name, tc.go_, tc.c_)
		}
	}
}

// The header is self-describing, so a length that disagrees with it is rejected
// at construction — not deferred to Decode.
func TestFromBytesRejectsWrongLength(t *testing.T) {
	valid := Encode(4, 4, solidImage(4, 4, 128, 64, 32, 255), GamutSRGB).Hash

	for _, tc := range []struct {
		name  string
		bytes []byte
	}{
		{"one byte short", valid[:len(valid)-1]},
		{"one byte long", append(append([]byte{}, valid...), 0)},
		{"empty", []byte{}},
		{"reserved tier code", append([]byte{valid[0]&^0x38 | (MaxTier+1)<<3}, valid[1:]...)},
		{"reserved bit set", append([]byte{valid[0] | 0x80}, valid[1:]...)},
		{"generation v1 (version 0)", append([]byte{valid[0] &^ 0x07}, valid[1:]...)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := FromBytes(tc.bytes); !errors.Is(err, ErrInvalidHash) {
				t.Errorf("FromBytes accepted %d bytes (err = %v)", len(tc.bytes), err)
			}
		})
	}
}

func TestFromBytesRoundtrip(t *testing.T) {
	ch := Encode(4, 4, solidImage(4, 4, 128, 64, 32, 255), GamutSRGB)
	got, err := FromBytes(ch.Hash)
	if err != nil {
		t.Fatalf("FromBytes rejected its own output: %v", err)
	}
	if !bytes.Equal(got.Hash, ch.Hash) {
		t.Error("FromBytes roundtrip failed")
	}
}

// FromBytes copies, so a later write to the caller's slice cannot invalidate a
// ChromaHash that already validated.
func TestFromBytesCopiesTheInput(t *testing.T) {
	src := Encode(4, 4, solidImage(4, 4, 128, 64, 32, 255), GamutSRGB).Hash
	ch, err := FromBytes(src)
	if err != nil {
		t.Fatalf("FromBytes: %v", err)
	}
	src[0] ^= 0xff
	if ch.Hash[0] == src[0] {
		t.Error("FromBytes aliased the caller's slice")
	}
}

// Decoded dimensions come from the aspect byte and the tier's raster. A range
// check wide enough to pass for every tier cannot tell them apart, so assert
// the values.
func TestDecodedDimensionsFollowTheTierRaster(t *testing.T) {
	rgba := solidImage(4, 4, 128, 64, 32, 255)
	for tier, edge := range map[uint8]int{0: 32, 1: 32, 2: 64, 3: 128, 4: 256} {
		w, h, pixels := EncodeWithQuality(4, 4, rgba, GamutSRGB, tier).Decode()
		if w != edge || h != edge {
			t.Errorf("tier %d: decoded %dx%d, want %dx%d", tier, w, h, edge, edge)
		}
		if len(pixels) != w*h*4 {
			t.Errorf("tier %d: pixel length %d, want %d", tier, len(pixels), w*h*4)
		}
	}
}
