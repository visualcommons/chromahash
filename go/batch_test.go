package chromahash

import (
	"bytes"
	"testing"
)

// mixedBatchItems is a spread of dimensions, gamuts, and alpha, mirroring the
// bulk-migration use case.
// It also spans every tier, so a batch path that ignored Quality would fail.
func mixedBatchItems() []ImageInput {
	return []ImageInput{
		{W: 4, H: 4, Rgba: solidImage(4, 4, 200, 100, 50, 255), Gamut: GamutSRGB, Quality: CompactTier},
		{W: 8, H: 4, Rgba: horizontalGradient(8, 4), Gamut: GamutDisplayP3, Quality: DefaultTier},
		{W: 4, H: 8, Rgba: solidImage(4, 8, 30, 200, 120, 128), Gamut: GamutAdobeRGB, Quality: 2},
		{W: 16, H: 16, Rgba: verticalGradient(16, 16), Gamut: GamutBT2020, Quality: 3},
		{W: 1, H: 1, Rgba: solidImage(1, 1, 255, 0, 0, 255), Gamut: GamutProPhotoRGB, Quality: MaxTier},
	}
}

func TestBatchEncodeMatchesSerial(t *testing.T) {
	items := mixedBatchItems()
	be := NewBatchEncoder()
	defer be.Close()

	got := be.EncodeBatch(items)
	if len(got) != len(items) {
		t.Fatalf("expected %d hashes, got %d", len(items), len(got))
	}
	for i, it := range items {
		want := EncodeWithQuality(it.W, it.H, it.Rgba, it.Gamut, it.Quality)
		if !bytes.Equal(got[i].Hash, want.Hash) {
			t.Errorf("item %d: batch hash != serial hash", i)
		}
	}
}

// TestBatchEncodeHonorsQuality pins the tier down to the byte count: the same
// image at every tier must come back at that tier's documented length. Comparing
// batch against serial alone would pass if both silently used one tier.
func TestBatchEncodeHonorsQuality(t *testing.T) {
	rgba := solidImage(8, 8, 200, 100, 50, 255)
	items := make([]ImageInput, 0, MaxTier+1)
	for tier := CompactTier; tier <= MaxTier; tier++ {
		items = append(items, ImageInput{W: 8, H: 8, Rgba: rgba, Gamut: GamutSRGB, Quality: tier})
	}

	be := NewBatchEncoder()
	defer be.Close()
	got := be.EncodeBatch(items)

	for i, want := range tierByteLengths {
		if len(got[i].Hash) != want {
			t.Errorf("tier %d: batch produced %d bytes, want %d", i, len(got[i].Hash), want)
		}
	}
}

// Go cannot default a struct field, so an ImageInput built without Quality
// encodes at CompactTier — unlike every other binding, where an omitted tier
// is DefaultTier. That asymmetry is forced by the language, not chosen, and
// it is the trap that made BenchmarkBatchEncode measure 21-byte hashes against
// a 32-byte serial baseline. Pin it so it is a documented property rather than
// a surprise.
func TestZeroValueQualityIsTheCompactTier(t *testing.T) {
	rgba := solidImage(8, 8, 200, 100, 50, 255)
	be := NewBatchEncoder()
	defer be.Close()

	got := be.EncodeBatch([]ImageInput{{W: 8, H: 8, Rgba: rgba, Gamut: GamutSRGB}})
	if len(got[0].Hash) != tierByteLengths[CompactTier] {
		t.Errorf("zero-value Quality produced %d bytes, want %d (CompactTier)",
			len(got[0].Hash), tierByteLengths[CompactTier])
	}
	if !bytes.Equal(got[0].Hash, EncodeWithQuality(8, 8, rgba, GamutSRGB, CompactTier).Hash) {
		t.Error("zero-value Quality did not match an explicit CompactTier encode")
	}
}

func TestBatchEncodeRejectsReservedTier(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic on a reserved tier code")
		}
	}()
	be := NewBatchEncoder()
	defer be.Close()
	be.EncodeBatch([]ImageInput{
		{W: 2, H: 2, Rgba: make([]byte, 16), Gamut: GamutSRGB, Quality: MaxTier + 1},
	})
}

func TestBatchEncodePreservesOrder(t *testing.T) {
	// Many same-shape items to exercise out-of-order completion.
	items := make([]ImageInput, 64)
	for i := range items {
		items[i] = ImageInput{
			W:       8,
			H:       8,
			Rgba:    solidImage(8, 8, byte(i), byte(255-i), byte(i*3), 255),
			Gamut:   GamutSRGB,
			Quality: DefaultTier,
		}
	}
	be := NewBatchEncoderN(4)
	defer be.Close()

	got := be.EncodeBatch(items)
	for i, it := range items {
		if !bytes.Equal(got[i].Hash, EncodeWithQuality(it.W, it.H, it.Rgba, it.Gamut, it.Quality).Hash) {
			t.Errorf("item %d out of order", i)
		}
	}
}

func TestBatchEncodeReusable(t *testing.T) {
	items := mixedBatchItems()
	be := NewBatchEncoder()
	defer be.Close()

	first := be.EncodeBatch(items)
	second := be.EncodeBatch(items)
	for i := range items {
		if !bytes.Equal(first[i].Hash, second[i].Hash) {
			t.Errorf("item %d differs across reuse", i)
		}
	}
}

func TestBatchEncodeEmpty(t *testing.T) {
	be := NewBatchEncoder()
	defer be.Close()
	if got := be.EncodeBatch(nil); len(got) != 0 {
		t.Errorf("expected empty result, got %d", len(got))
	}
}

func TestBatchEncodeInvalidPanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic on invalid item")
		}
	}()
	be := NewBatchEncoder()
	defer be.Close()
	be.EncodeBatch([]ImageInput{
		{W: 2, H: 2, Rgba: make([]byte, 3), Gamut: GamutSRGB}, // wrong length
	})
}
