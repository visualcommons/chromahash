package chromahash

import (
	"runtime"
	"strconv"
)

// ImageInput is one image to encode in a batch.
type ImageInput struct {
	W     int
	H     int
	Rgba  []byte
	Gamut Gamut
	// Quality is the tier to encode this image at (0..=MaxTier, ordered by
	// quality). Note that the zero value is CompactTier, not DefaultTier —
	// set it explicitly to DefaultTier for the 32-byte hash Encode produces.
	Quality uint8
}

// batchJob is a unit of work handed to a worker goroutine: which item it is,
// the image to encode, the shared output slice to write into, and the channel
// to signal completion on.
type batchJob struct {
	index int
	input ImageInput
	out   []ChromaHash
	done  chan<- struct{}
}

// BatchEncoder encodes many images in parallel over an owned pool of worker
// goroutines. Construct one with NewBatchEncoder, reuse it across many
// EncodeBatch calls, then release it with Close.
//
// A BatchEncoder is intended to be used from a single goroutine; EncodeBatch
// and Close must not be called concurrently with each other.
type BatchEncoder struct {
	jobs   chan batchJob
	closed bool
}

// NewBatchEncoder starts a worker pool sized to runtime.NumCPU().
func NewBatchEncoder() *BatchEncoder {
	return NewBatchEncoderN(runtime.NumCPU())
}

// NewBatchEncoderN starts a worker pool with n workers (clamped to >= 1).
func NewBatchEncoderN(n int) *BatchEncoder {
	if n < 1 {
		n = 1
	}
	be := &BatchEncoder{jobs: make(chan batchJob)}
	for i := 0; i < n; i++ {
		go func() {
			for job := range be.jobs {
				it := job.input
				job.out[job.index] = EncodeWithQuality(it.W, it.H, it.Rgba, it.Gamut, it.Quality)
				job.done <- struct{}{}
			}
		}()
	}
	return be
}

// EncodeBatch encodes every item, returning hashes in the same order as items.
// Each hash is byte-identical to EncodeWithQuality on that item at its Quality
// tier.
//
// All items are validated up front, before any work is dispatched, so an
// invalid item panics on the calling goroutine (identifying its index) rather
// than crashing a worker mid-flight. Validation matches EncodeWithQuality.
func (be *BatchEncoder) EncodeBatch(items []ImageInput) []ChromaHash {
	if be.closed {
		panic("chromahash: EncodeBatch called on closed BatchEncoder")
	}
	for i, it := range items {
		if it.W < 1 {
			panic("chromahash: item " + strconv.Itoa(i) + ": width must be >= 1")
		}
		if it.H < 1 {
			panic("chromahash: item " + strconv.Itoa(i) + ": height must be >= 1")
		}
		if len(it.Rgba) != it.W*it.H*4 {
			panic("chromahash: item " + strconv.Itoa(i) + ": rgba length mismatch")
		}
		if it.Quality > MaxTier {
			panic("chromahash: item " + strconv.Itoa(i) + ": quality tier out of range")
		}
	}

	out := make([]ChromaHash, len(items))
	if len(items) == 0 {
		return out
	}

	// done is buffered to the item count so workers never block reporting.
	done := make(chan struct{}, len(items))
	for i, it := range items {
		be.jobs <- batchJob{index: i, input: it, out: out, done: done}
	}
	for range items {
		<-done
	}
	return out
}

// Close shuts down the worker pool. It is idempotent; calling EncodeBatch after
// Close panics.
func (be *BatchEncoder) Close() {
	if be.closed {
		return
	}
	be.closed = true
	close(be.jobs)
}
