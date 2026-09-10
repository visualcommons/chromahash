# chromahash (Go)

> Modern, high-quality image placeholder representation for professional formats (LQIP)

`chromahash` encodes an image into a compact, self-describing Low Quality Image
Placeholder (LQIP) — **32 bytes** at the default tier, 21 at the compact one and
108/411/1623 above it — and decodes it back into a low-fidelity preview. Color is
encoded in the perceptually-uniform [OKLAB](https://bottosson.github.io/posts/oklab/)
space with wide-gamut input support (sRGB, Display P3, Adobe RGB, BT.2020,
ProPhoto RGB) and decodes to a caller-chosen display gamut (sRGB, Display P3,
or Adobe RGB).

This is the **Go** binding — a thin [cgo](https://pkg.go.dev/cmd/cgo) wrapper over
the [`chromahash-c`](../bindings/c) C ABI. It carries no native algorithm of its
own and produces output **bit-identical** to every other ChromaHash
implementation, validated against the shared [`spec/`](../spec) test vectors. The
`go.mod` is dependency-free.

```sh
go get github.com/visualcommons/chromahash/go
```

## Building

Because the package is cgo, builds need a C toolchain with `CGO_ENABLED=1` and
the static library staged into [`go/lib`](lib):

```sh
mise run cbuild:go   # builds libchromahash_c.a and stages it into go/lib
```

`mise run build:go` and `mise run test:go` run this step automatically.

## Usage

```go
package main

import (
	"fmt"
	"log"

	chromahash "github.com/visualcommons/chromahash/go"
)

func main() {
	// width × height × 4 bytes (RGBA) — a 2×2 image here.
	rgba := []byte{
		255, 0, 0, 255, 0, 255, 0, 255,
		0, 0, 255, 255, 255, 255, 0, 255,
	}

	hash := chromahash.Encode(2, 2, rgba, chromahash.GamutSRGB)
	fmt.Printf("hash: %x\n", hash.Hash) // 32 bytes

	// Reconstruct a preview. FromBytes validates the header up front, so a
	// ChromaHash that comes back is guaranteed to decode. Decode() targets
	// sRGB; DecodeTo() can render to Display P3 or Adobe RGB instead.
	decoded, err := chromahash.FromBytes(hash.Hash)
	if err != nil {
		log.Fatal(err)
	}
	w, h, preview := decoded.Decode()
	fmt.Printf("decoded %dx%d, %d bytes\n", w, h, len(preview))
}
```

See the [project repository](https://github.com/visualcommons/chromahash) for the
full format specification and the other language implementations.

> **Note:** ChromaHash is a pre-1.0 **Draft** format — the bitstream is not yet
> guaranteed stable across versions.

## License

Licensed under either of [Apache License, Version 2.0](https://github.com/visualcommons/chromahash/blob/master/LICENSE-APACHE)
or [MIT license](https://github.com/visualcommons/chromahash/blob/master/LICENSE-MIT)
at your option.
