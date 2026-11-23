/// Generate golden test vectors from the Rust reference implementation.
/// Run with: cargo test --manifest-path rust/Cargo.toml -- generate_test_vectors --nocapture --ignored
#[cfg(test)]
mod tests {
    use crate::aspect::{decode_aspect, decode_output_size, encode_aspect};
    use crate::bitpack::{read_bits, write_bits};
    use crate::color::{gamma_rgb_to_oklab, linear_rgb_to_oklab, oklab_to_linear_srgb};
    use crate::constants::{COMPACT_TIER, DEFAULT_TIER, Gamut, Tunables, ac_shape};
    use crate::dct::SelectionOrder;
    use crate::math_utils::{cbrt_halley, cbrt_signed};
    use crate::mulaw::{mu_compress, mu_expand, mu_law_dequantize, mu_law_quantize};
    use crate::{ChromaHash, MAX_TIER};

    fn solid_image(w: u32, h: u32, r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let n = (w * h) as usize;
        let mut rgba = vec![0u8; n * 4];
        for i in 0..n {
            rgba[i * 4] = r;
            rgba[i * 4 + 1] = g;
            rgba[i * 4 + 2] = b;
            rgba[i * 4 + 3] = a;
        }
        rgba
    }

    fn gradient_image(w: u32, h: u32) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let tx = x as f64 / (w - 1).max(1) as f64;
                let ty = y as f64 / (h - 1).max(1) as f64;
                let idx = ((y * w + x) * 4) as usize;
                rgba[idx] = (tx * 255.0) as u8;
                rgba[idx + 1] = ((1.0 - tx) * ty * 255.0) as u8;
                rgba[idx + 2] = ((1.0 - ty) * 255.0) as u8;
                rgba[idx + 3] = 255;
            }
        }
        rgba
    }

    /// Red→blue gradient along the long axis of a 1-px-wide/tall strip.
    /// Mirrors the comparison corpus dim-1x100/dim-100x1 fixtures that
    /// exposed the v0.5 degenerate-dimension aliasing bug.
    fn strip_gradient(w: u32, h: u32) -> Vec<u8> {
        let n = (w * h) as usize;
        let mut rgba = vec![0u8; n * 4];
        for i in 0..n {
            let t = i as f64 / (n - 1).max(1) as f64;
            rgba[i * 4] = (255.0 * (1.0 - t)) as u8;
            rgba[i * 4 + 2] = (255.0 * t) as u8;
            rgba[i * 4 + 3] = 255;
        }
        rgba
    }

    /// A colour ramp under an alpha that rises and falls across the image,
    /// so every alpha-mode channel carries low-frequency AC for a coded
    /// stream and a window to act on (a 1-px checkerboard leaves them at the
    /// centre code).
    fn alpha_ramp(w: u32, h: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let t = x * 255 / w.max(1);
                let tri = if 2 * x < w {
                    2 * x * 255 / w
                } else {
                    (2 * (w - x)) * 255 / w
                };
                rgba.extend_from_slice(&[
                    t as u8,
                    (255 - t) as u8,
                    (y * 255 / h.max(1)) as u8,
                    tri.min(255) as u8,
                ]);
            }
        }
        rgba
    }

    fn checkerboard_alpha(w: u32, h: u32) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let idx = ((y * w + x) * 4) as usize;
                if (x + y) % 2 == 0 {
                    rgba[idx] = 255;
                    rgba[idx + 1] = 0;
                    rgba[idx + 2] = 0;
                    rgba[idx + 3] = 255;
                } else {
                    rgba[idx] = 0;
                    rgba[idx + 1] = 0;
                    rgba[idx + 2] = 255;
                    rgba[idx + 3] = 0;
                }
            }
        }
        rgba
    }

    #[test]
    #[ignore]
    fn generate_test_vectors() {
        let spec_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../spec/test-vectors");
        std::fs::create_dir_all(&spec_dir).unwrap();

        // --- unit-color.json ---
        {
            let mut cases = Vec::new();

            let color_tests: &[(&str, [f64; 3], Gamut, &str)] = &[
                ("white_srgb", [1.0, 1.0, 1.0], Gamut::Srgb, "sRGB"),
                ("black_srgb", [0.0, 0.0, 0.0], Gamut::Srgb, "sRGB"),
                ("red_srgb", [1.0, 0.0, 0.0], Gamut::Srgb, "sRGB"),
                ("green_srgb", [0.0, 1.0, 0.0], Gamut::Srgb, "sRGB"),
                ("blue_srgb", [0.0, 0.0, 1.0], Gamut::Srgb, "sRGB"),
                ("mid_gray_srgb", [0.5, 0.5, 0.5], Gamut::Srgb, "sRGB"),
                ("red_p3", [1.0, 0.0, 0.0], Gamut::DisplayP3, "Display P3"),
                ("red_adobe", [1.0, 0.0, 0.0], Gamut::AdobeRgb, "Adobe RGB"),
            ];

            for &(name, rgb, gamut, gamut_name) in color_tests {
                let lab = linear_rgb_to_oklab(rgb, gamut);
                let rt = oklab_to_linear_srgb(lab);
                cases.push(format!(
                    r#"  {{
    "name": "{name}",
    "input": {{ "linear_rgb": [{}, {}, {}], "gamut": "{gamut_name}" }},
    "expected": {{
      "oklab": [{}, {}, {}],
      "roundtrip_srgb": [{}, {}, {}]
    }}
  }}"#,
                    rgb[0], rgb[1], rgb[2], lab[0], lab[1], lab[2], rt[0], rt[1], rt[2],
                ));
            }

            // Gamma-encoded color tests
            let gamma_tests: &[(&str, [f64; 3], Gamut, &str)] = &[
                ("gamma_red_srgb", [1.0, 0.0, 0.0], Gamut::Srgb, "sRGB"),
                ("gamma_mid_srgb", [0.5, 0.5, 0.5], Gamut::Srgb, "sRGB"),
            ];
            for &(name, rgb, gamut, gamut_name) in gamma_tests {
                let lab = gamma_rgb_to_oklab(rgb[0], rgb[1], rgb[2], gamut);
                cases.push(format!(
                    r#"  {{
    "name": "{name}",
    "input": {{ "gamma_rgb": [{}, {}, {}], "gamut": "{gamut_name}" }},
    "expected": {{ "oklab": [{}, {}, {}] }}
  }}"#,
                    rgb[0], rgb[1], rgb[2], lab[0], lab[1], lab[2],
                ));
            }

            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("unit-color.json"), json).unwrap();
        }

        // --- unit-mulaw.json (v0.6: odd level count, per-channel µ) ---
        // Covers both µ values the format uses (MU_L/MU_ALPHA = 5, MU_C = 8)
        // at every bit width, including near-zero values that exercise the
        // exact-zero center code and its first neighbors.
        {
            let mut cases = Vec::new();
            for &mu in &[Tunables::DEFAULT.mu_l, Tunables::DEFAULT.mu_c] {
                for &v in &[
                    -1.0, -0.75, -0.5, -0.25, -0.05, -0.01, 0.0, 0.01, 0.05, 0.25, 0.5, 0.75, 1.0,
                ] {
                    let c = mu_compress(v, mu);
                    let e = mu_expand(c, mu);
                    for bits in [4u32, 5, 6] {
                        let q = mu_law_quantize(v, bits, mu);
                        let dq = mu_law_dequantize(q, bits, mu);
                        cases.push(format!(
                            r#"  {{
    "name": "mu={mu}_v={v}_bits={bits}",
    "input": {{ "value": {v}, "bits": {bits}, "mu": {mu} }},
    "expected": {{ "compressed": {c}, "expanded": {e}, "quantized": {q}, "dequantized": {dq} }}
  }}"#,
                        ));
                    }
                }
                // The never-written top code must clamp down on dequantize.
                for bits in [4u32, 5, 6] {
                    let top = (1u32 << bits) - 1;
                    let dq = mu_law_dequantize(top, bits, mu);
                    cases.push(format!(
                        r#"  {{
    "name": "mu={mu}_topcode_bits={bits}",
    "input": {{ "index": {top}, "bits": {bits}, "mu": {mu} }},
    "expected": {{ "dequantized": {dq} }}
  }}"#,
                    ));
                }
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("unit-mulaw.json"), json).unwrap();
        }

        // --- unit-selection.json (v1: top-K isotropic selection) ---
        // Enumerate unique (W, H, K) selections across all 256 aspect bytes at
        // tier 0 for every K the format uses, derived from the tier-0 shape so
        // the list cannot drift: chroma (15), alpha (5), L alpha-mode (20),
        // L (28). Higher tiers reuse the same ordering on a larger grid; that
        // grid scaling is pinned by unit-aspect, and higher-tier selection is
        // exercised end-to-end by the integration-decode-capped vectors.
        //
        // Each (W, H, K) is emitted twice: once with the weights zeroed (the
        // bare priority order) and once with the shipped weights of §6.2,
        // which is the order the format actually transmits in. The two together
        // pin both halves of `selection_key`.
        {
            let t0 = Tunables::DEFAULT;
            let s0 = ac_shape(&t0, false, DEFAULT_TIER);
            let sa = ac_shape(&t0, true, DEFAULT_TIER);
            let mut ks: Vec<usize> = vec![
                sa.alpha_ac_count,
                s0.c_count,
                sa.c_count,
                sa.l_count(),
                s0.l_count(),
            ];
            ks.sort_unstable();
            ks.dedup();

            let mut cases = Vec::new();
            let mut seen = std::collections::BTreeSet::new();

            for byte in 0u8..=255 {
                let (dw, dh) = decode_output_size(byte, DEFAULT_TIER);
                for &k in &ks {
                    let key = (dw, dh, k);
                    if seen.insert(key) {
                        for (suffix, aniso, hv) in
                            [("", 0.0, 0.0), ("_w", t0.aniso_oblique, t0.sel_hv)]
                        {
                            let sel = SelectionOrder::new(byte, DEFAULT_TIER, aniso, hv).take(k);
                            let pairs: Vec<String> = sel
                                .coeffs
                                .iter()
                                .map(|&(cx, cy)| format!("[{cx},{cy}]"))
                                .collect();
                            cases.push(format!(
                                r#"  {{
    "name": "selection_w{dw}h{dh}_k{k}{suffix}",
    "input": {{ "aspect_byte": {byte}, "tier": {DEFAULT_TIER}, "k": {k}, "aniso": {aniso}, "hv": {hv} }},
    "expected": {{ "coeffs": [{}], "p_k": {} }}
  }}"#,
                                pairs.join(","),
                                sel.p_k,
                            ));
                        }
                    }
                }
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("unit-selection.json"), json).unwrap();
        }

        // --- unit-aspect.json ---
        {
            let mut cases = Vec::new();
            for &(w, h, label) in &[
                (1u32, 1u32, "1:1"),
                (3, 2, "3:2"),
                (4, 3, "4:3"),
                (16, 9, "16:9"),
                (4, 1, "4:1"),
                (1, 4, "1:4"),
                (2, 1, "2:1"),
                (1, 2, "1:2"),
                (100, 25, "100:25"),
            ] {
                let byte = encode_aspect(w, h);
                let decoded_ratio = decode_aspect(byte);
                // Natural size scales by 2^level on each axis (long edge 32·2^level),
                // where level is the tier's *render level*. The compact tier is
                // included deliberately: its size is the half of the render-level
                // rule that no length check can catch, because the byte length
                // depends only on the coefficient counts.
                for tier in 0..=MAX_TIER {
                    let (dw, dh) = decode_output_size(byte, tier);
                    cases.push(format!(
                        r#"  {{
    "name": "aspect_{label}_t{tier}",
    "input": {{ "width": {w}, "height": {h}, "tier": {tier} }},
    "expected": {{
      "byte": {byte},
      "decoded_ratio": {decoded_ratio},
      "output_width": {dw},
      "output_height": {dh}
    }}
  }}"#,
                    ));
                }
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("unit-aspect.json"), json).unwrap();
        }

        // --- unit-bitpack.json ---
        {
            let mut cases = Vec::new();
            // Round-trip tests at various bit positions and widths
            let test_cases: &[(&str, usize, u32, u32)] = &[
                ("bits4_at_0", 0, 4, 0xA),
                ("bits5_at_0", 0, 5, 0x1F),
                ("bits6_at_0", 0, 6, 0x3C),
                ("bits8_at_0", 0, 8, 0xAB),
                ("bits4_at_3", 3, 4, 0xB),
                ("bits5_at_7", 7, 5, 0x15),
                ("bits6_at_6", 6, 6, 0x2A),
                ("bits8_at_6", 6, 8, 0xCA),
                ("bits4_at_48", 48, 4, 0xF),
                ("bits5_at_48", 48, 5, 0x1A),
                ("bits6_at_48", 48, 6, 0x35),
                ("bits5_at_53", 53, 5, 0x0D),
                ("bits4_at_183", 183, 4, 0x7),
                ("bits4_at_219", 219, 4, 0xC),
                ("bits1_at_47", 47, 1, 1),
            ];
            for &(name, pos, bits, val) in test_cases {
                let mut buf = [0u8; 32];
                write_bits(&mut buf, pos, bits, val);
                let read_back = read_bits(&buf, pos, bits);
                cases.push(format!(
                    r#"  {{
    "name": "{name}",
    "input": {{ "bitpos": {pos}, "count": {bits}, "value": {val} }},
    "expected": {{ "read_back": {read_back} }}
  }}"#,
                ));
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("unit-bitpack.json"), json).unwrap();
        }

        // --- unit-cbrt.json ---
        {
            let mut cases = Vec::new();
            // cbrt_halley values across LMS domain and other ranges
            let test_vals: &[f64] = &[
                0.0, 1e-6, 0.001, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 2.5, 3.0,
                8.0, 27.0, -0.001, -0.1, -0.5, -1.0, -8.0, -27.0,
            ];
            for &x in test_vals {
                let halley = cbrt_halley(x);
                let reference = cbrt_signed(x);
                // Compute max ULP error
                let max_ulp = if x == 0.0 {
                    0
                } else {
                    // Compare bit patterns to get ULP distance
                    let a = halley.to_bits();
                    let b = reference.to_bits();
                    if halley.is_sign_negative() == reference.is_sign_negative() {
                        a.abs_diff(b).min(2)
                    } else {
                        2 // sign mismatch — report max
                    }
                };
                cases.push(format!(
                    r#"  {{
    "name": "cbrt_{x}",
    "input": {x},
    "expected": {halley},
    "max_ulp_error": {max_ulp}
  }}"#,
                    x = x,
                    halley = halley,
                    max_ulp = max_ulp,
                ));
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("unit-cbrt.json"), json).unwrap();
        }

        // --- integration-encode.json ---
        {
            let mut cases = Vec::new();

            let test_images: Vec<(&str, u32, u32, Vec<u8>, Gamut)> = vec![
                (
                    "solid_gray_4x4",
                    4,
                    4,
                    solid_image(4, 4, 128, 128, 128, 255),
                    Gamut::Srgb,
                ),
                (
                    "solid_red_4x4",
                    4,
                    4,
                    solid_image(4, 4, 255, 0, 0, 255),
                    Gamut::Srgb,
                ),
                (
                    "solid_green_4x4",
                    4,
                    4,
                    solid_image(4, 4, 0, 255, 0, 255),
                    Gamut::Srgb,
                ),
                (
                    "solid_blue_4x4",
                    4,
                    4,
                    solid_image(4, 4, 0, 0, 255, 255),
                    Gamut::Srgb,
                ),
                (
                    "solid_white_4x4",
                    4,
                    4,
                    solid_image(4, 4, 255, 255, 255, 255),
                    Gamut::Srgb,
                ),
                (
                    "solid_black_4x4",
                    4,
                    4,
                    solid_image(4, 4, 0, 0, 0, 255),
                    Gamut::Srgb,
                ),
                (
                    "gradient_16x16",
                    16,
                    16,
                    gradient_image(16, 16),
                    Gamut::Srgb,
                ),
                ("gradient_8x4", 8, 4, gradient_image(8, 4), Gamut::Srgb),
                ("gradient_4x8", 4, 8, gradient_image(4, 8), Gamut::Srgb),
                (
                    "checkerboard_alpha_8x8",
                    8,
                    8,
                    checkerboard_alpha(8, 8),
                    Gamut::Srgb,
                ),
                (
                    "solid_1x1",
                    1,
                    1,
                    solid_image(1, 1, 200, 100, 50, 255),
                    Gamut::Srgb,
                ),
                (
                    "solid_p3_4x4",
                    4,
                    4,
                    solid_image(4, 4, 200, 100, 50, 255),
                    Gamut::DisplayP3,
                ),
                // v0.6: far outside sRGB — exercises the DC search against the
                // lightness-blended gamut clamp (the ProPhoto-red→pink fix)
                (
                    "solid_prophoto_4x4",
                    4,
                    4,
                    solid_image(4, 4, 220, 50, 30, 255),
                    Gamut::ProPhotoRgb,
                ),
                // v0.2: large images (full-resolution encoding)
                (
                    "gradient_200x150",
                    200,
                    150,
                    gradient_image(200, 150),
                    Gamut::Srgb,
                ),
                // v0.2: panorama (exercises adaptive 10×5 grid)
                (
                    "gradient_200x50",
                    200,
                    50,
                    gradient_image(200, 50),
                    Gamut::Srgb,
                ),
                // v0.6: degenerate dimensions — single-sample axes used to
                // produce aliased junk coefficients (the dim-1xN catastrophe);
                // the encoder frequency clamp must zero every cx ≥ 1 (or cy ≥ 1)
                ("strip_1x100", 1, 100, strip_gradient(1, 100), Gamut::Srgb),
                ("strip_100x1", 100, 1, strip_gradient(100, 1), Gamut::Srgb),
                // v0.6: 16:1 panorama at the aspect clamp boundary
                (
                    "gradient_320x20",
                    320,
                    20,
                    gradient_image(320, 20),
                    Gamut::Srgb,
                ),
                // v0.7.2: the two source gamuts no shared vector reached. Adobe
                // RGB is the gamma-2.2 EOTF arm and BT.2020 the PQ + Reinhard
                // one; both were pinned only by this crate's own goldens, so a
                // binding that got either wrong still passed the parity gate.
                // Same pixels as solid_p3_4x4, so a diff isolates the gamut.
                (
                    "solid_adobe_4x4",
                    4,
                    4,
                    solid_image(4, 4, 200, 100, 50, 255),
                    Gamut::AdobeRgb,
                ),
                (
                    "solid_bt2020_4x4",
                    4,
                    4,
                    solid_image(4, 4, 200, 100, 50, 255),
                    Gamut::Bt2020,
                ),
                // v0.7.2: a colour whose OKLAB chroma runs past MAX_CHROMA_A and
                // MAX_CHROMA_B, so the DC clamp in quantize_c_dc is exercised
                // across languages rather than in the reference alone. ProPhoto
                // blue clamps on both axes at once.
                (
                    "solid_out_of_gamut_4x4",
                    4,
                    4,
                    solid_image(4, 4, 0, 0, 255, 255),
                    Gamut::ProPhotoRgb,
                ),
                // v0.7.2: fully transparent. The alpha-weighted average has a
                // zero weight sum here and must fall back to black rather than
                // divide by zero — pinned by a core unit test and a property,
                // but by no vector any other language replays.
                (
                    "transparent_4x4",
                    4,
                    4,
                    solid_image(4, 4, 0, 0, 0, 0),
                    Gamut::Srgb,
                ),
                // v0.7.2: uniform partial alpha. Distinct from the checkerboard
                // case in that the alpha plane is flat, so its AC is zero while
                // the flag is still set.
                (
                    "uniform_alpha_8x8",
                    8,
                    8,
                    solid_image(8, 8, 200, 60, 40, 128),
                    Gamut::Srgb,
                ),
            ];

            // Every image is pinned at tier 0; a representative subset (gradients,
            // alpha, a solid) is also pinned at tiers 1..=3 so the quality
            // multiplier's encode path is exercised end to end. The subset uses
            // only small sources — the hash size is tier-driven, so there is no
            // need to re-emit a large RGBA input once per tier.
            let higher_tier_images = [
                "gradient_16x16",
                "gradient_8x4",
                "checkerboard_alpha_8x8",
                "solid_red_4x4",
            ];
            for (name, w, h, rgba, gamut) in &test_images {
                let mut tiers = vec![COMPACT_TIER, DEFAULT_TIER];
                if higher_tier_images.contains(name) {
                    tiers.extend((DEFAULT_TIER + 1)..=MAX_TIER);
                }
                let rgba_str: Vec<String> = rgba.iter().map(|b| b.to_string()).collect();
                let gamut_name = match gamut {
                    Gamut::Srgb => "sRGB",
                    Gamut::DisplayP3 => "Display P3",
                    Gamut::AdobeRgb => "Adobe RGB",
                    Gamut::Bt2020 => "BT.2020",
                    Gamut::ProPhotoRgb => "ProPhoto RGB",
                };
                for tier in tiers {
                    let hash = ChromaHash::encode_with_quality(*w, *h, rgba, *gamut, tier);
                    let bytes: Vec<String> =
                        hash.as_bytes().iter().map(|b| b.to_string()).collect();
                    let avg = hash.average_color();
                    cases.push(format!(
                        r#"  {{
    "name": "{name}_t{tier}",
    "input": {{ "width": {w}, "height": {h}, "gamut": "{gamut_name}", "tier": {tier}, "rgba": [{rgba_list}] }},
    "expected": {{ "hash": [{hash_list}], "average_color": [{},{},{},{}] }}
  }}"#,
                        avg[0],
                        avg[1],
                        avg[2],
                        avg[3],
                        rgba_list = rgba_str.join(","),
                        hash_list = bytes.join(","),
                    ));
                }
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("integration-encode.json"), json).unwrap();
        }

        // --- integration-decode.json ---
        {
            let mut cases = Vec::new();

            // The tier is explicit so the decode vectors are not all pinned at
            // the default. Every pre-existing entry passes DEFAULT_TIER, so its
            // bytes are unchanged — the diff on regeneration must be a pure
            // insertion.
            /// One decode fixture: name, width, height, RGBA, source gamut, tier.
            type DecodeCase = (&'static str, u32, u32, Vec<u8>, Gamut, u8);
            let test_hashes: Vec<DecodeCase> = vec![
                (
                    "solid_gray_4x4",
                    4,
                    4,
                    solid_image(4, 4, 128, 128, 128, 255),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                (
                    "solid_red_4x4",
                    4,
                    4,
                    solid_image(4, 4, 255, 0, 0, 255),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                (
                    "gradient_16x16",
                    16,
                    16,
                    gradient_image(16, 16),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                (
                    "checkerboard_alpha_8x8",
                    8,
                    8,
                    checkerboard_alpha(8, 8),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                // v0.2: panorama decode
                (
                    "gradient_200x50",
                    200,
                    50,
                    gradient_image(200, 50),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                // v0.6: solid corner color — DC search + exact-zero quantizer
                // must reproduce it almost exactly (v0.5 decoded (0,58,214))
                (
                    "solid_blue_4x4_decode",
                    4,
                    4,
                    solid_image(4, 4, 0, 0, 255, 255),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                // v0.6: 1-px-wide strip decodes as a clean vertical profile
                (
                    "strip_1x100_decode",
                    1,
                    100,
                    strip_gradient(1, 100),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                // v0.7.2: the only byte-exact tier-4 decode oracle in any
                // language. Deliberately a 16:1 source: decode_output_size
                // clamps to 256x16 = 4096 px, where a square tier-4 case would
                // render 256x256 and add ~3.5 MB of JSON. The full 1623-byte
                // payload is still read either way — the AC read loop runs
                // before the render-raster frequency filter — so every tier-4
                // bit offset is exercised at a fraction of the size.
                (
                    "strip_100x1_t4_decode",
                    100,
                    1,
                    strip_gradient(100, 1),
                    Gamut::Srgb,
                    MAX_TIER,
                ),
                // v0.8.0 (generation v2): one byte-exact decode oracle per
                // cell the v0.8 verdict changed, each a 16:1 source so the
                // raster stays small while the whole payload is read. Code 3
                // opaque: the coded stream, no window. Code 3 alpha: the
                // coded stream with the 5-bit alpha bounds, window 0.85.
                // Code 4 alpha: the 5-bit alpha row, no window. (Code 4
                // opaque, window 0.7, is `strip_100x1_t4_decode` above.)
                (
                    "strip_100x1_t3_decode",
                    100,
                    1,
                    strip_gradient(100, 1),
                    Gamut::Srgb,
                    3,
                ),
                (
                    "alpha_ramp_64x4_t3_decode",
                    64,
                    4,
                    alpha_ramp(64, 4),
                    Gamut::Srgb,
                    3,
                ),
                (
                    "alpha_ramp_64x4_t4_decode",
                    64,
                    4,
                    alpha_ramp(64, 4),
                    Gamut::Srgb,
                    MAX_TIER,
                ),
                // v0.7.2: decode halves of the two alpha gaps added above.
                (
                    "transparent_4x4_decode",
                    4,
                    4,
                    solid_image(4, 4, 0, 0, 0, 0),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
                (
                    "uniform_alpha_8x8_decode",
                    8,
                    8,
                    solid_image(8, 8, 200, 60, 40, 128),
                    Gamut::Srgb,
                    DEFAULT_TIER,
                ),
            ];

            for (name, w, h, rgba, gamut, tier) in &test_hashes {
                let hash = ChromaHash::encode_with_quality(*w, *h, rgba, *gamut, *tier);
                let (dw, dh, decoded_rgba) = hash.decode();
                let bytes: Vec<String> = hash.as_bytes().iter().map(|b| b.to_string()).collect();
                let decoded_str: Vec<String> = decoded_rgba.iter().map(|b| b.to_string()).collect();
                cases.push(format!(
                    r#"  {{
    "name": "{name}",
    "input": {{ "hash": [{hash_list}] }},
    "expected": {{ "width": {dw}, "height": {dh}, "rgba": [{rgba_list}] }}
  }}"#,
                    hash_list = bytes.join(","),
                    rgba_list = decoded_str.join(","),
                ));
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("integration-decode.json"), json).unwrap();
        }

        // --- integration-decode-capped.json (v0.6) ---
        // decode_capped renders below the natural size by skipping frequencies
        // the coarser raster cannot represent (spec §11.4). The 1×N cases are
        // the regression guard for the v0.5 all-white aliasing bug.
        {
            let mut cases = Vec::new();

            // (name, w, h, rgba, gamut, tier, max_w, max_h). Higher-tier hashes
            // are capped to small rasters: the decode still reads the whole
            // tier-scaled AC payload (pinning higher-tier selection + bit offsets
            // cross-language) while keeping the pixel output small.
            #[allow(clippy::type_complexity)]
            let capped_cases: Vec<(&str, u32, u32, Vec<u8>, Gamut, u8, u32, u32)> = vec![
                (
                    "strip_1x100_capped_1x100",
                    1,
                    100,
                    strip_gradient(1, 100),
                    Gamut::Srgb,
                    0,
                    1,
                    100,
                ),
                (
                    "strip_100x1_capped_100x1",
                    100,
                    1,
                    strip_gradient(100, 1),
                    Gamut::Srgb,
                    0,
                    100,
                    1,
                ),
                (
                    "solid_1x1_capped_1x1",
                    1,
                    1,
                    solid_image(1, 1, 200, 100, 50, 255),
                    Gamut::Srgb,
                    0,
                    1,
                    1,
                ),
                (
                    "gradient_16x16_capped_8x8",
                    16,
                    16,
                    gradient_image(16, 16),
                    Gamut::Srgb,
                    0,
                    8,
                    8,
                ),
                (
                    "gradient_200x50_capped_16x4",
                    200,
                    50,
                    gradient_image(200, 50),
                    Gamut::Srgb,
                    0,
                    16,
                    4,
                ),
                // Caps larger than natural must decode at natural size.
                (
                    "gradient_16x16_capped_64x64",
                    16,
                    16,
                    gradient_image(16, 16),
                    Gamut::Srgb,
                    0,
                    64,
                    64,
                ),
                // Higher tiers, capped small: exercise the tier-scaled AC read.
                (
                    "gradient_16x16_t2_capped_16x16",
                    16,
                    16,
                    gradient_image(16, 16),
                    Gamut::Srgb,
                    2,
                    16,
                    16,
                ),
                (
                    "checkerboard_alpha_8x8_t1_capped_16x16",
                    8,
                    8,
                    checkerboard_alpha(8, 8),
                    Gamut::Srgb,
                    1,
                    16,
                    16,
                ),
                (
                    "gradient_200x50_t3_capped_16x4",
                    200,
                    50,
                    gradient_image(200, 50),
                    Gamut::Srgb,
                    3,
                    16,
                    4,
                ),
            ];

            for (name, w, h, rgba, gamut, tier, max_w, max_h) in &capped_cases {
                let hash = ChromaHash::encode_with_quality(*w, *h, rgba, *gamut, *tier);
                let (dw, dh, decoded_rgba) = hash.decode_capped(*max_w, *max_h);
                let bytes: Vec<String> = hash.as_bytes().iter().map(|b| b.to_string()).collect();
                let decoded_str: Vec<String> = decoded_rgba.iter().map(|b| b.to_string()).collect();
                cases.push(format!(
                    r#"  {{
    "name": "{name}",
    "input": {{ "hash": [{hash_list}], "max_width": {max_w}, "max_height": {max_h} }},
    "expected": {{ "width": {dw}, "height": {dh}, "rgba": [{rgba_list}] }}
  }}"#,
                    hash_list = bytes.join(","),
                    rgba_list = decoded_str.join(","),
                ));
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("integration-decode-capped.json"), json).unwrap();
        }

        // --- unit-validate.json (v1: from_bytes is the decodability check) ---
        // A structurally valid hash is guaranteed decodable; from_bytes rejects
        // anything malformed early. Pin the accept/reject decision (the Debug name
        // of ChromaHashError, or "ok") for representative valid and corrupt inputs
        // so every language's validation agrees.
        {
            let mut cases = Vec::new();
            let valid =
                ChromaHash::encode(4, 4, &solid_image(4, 4, 128, 128, 128, 255), Gamut::Srgb);
            let valid_alpha =
                ChromaHash::encode(4, 4, &solid_image(4, 4, 200, 60, 40, 128), Gamut::Srgb);
            let valid_t2 =
                ChromaHash::encode_with_quality(16, 16, &gradient_image(16, 16), Gamut::Srgb, 3);
            // Both compact modes are pinned: the compact tier is code 0, so a
            // decoder that treats 0 as the 32-byte default mis-reads its length
            // instead of rejecting it, and must be caught here.
            let valid_compact = ChromaHash::encode_with_quality(
                4,
                4,
                &solid_image(4, 4, 128, 128, 128, 255),
                Gamut::Srgb,
                COMPACT_TIER,
            );
            let valid_compact_alpha = ChromaHash::encode_with_quality(
                4,
                4,
                &solid_image(4, 4, 200, 60, 40, 128),
                Gamut::Srgb,
                COMPACT_TIER,
            );

            let base: Vec<u8> = valid.as_bytes().to_vec();
            let mut bad_version = base.clone();
            bad_version[0] = (bad_version[0] & !0b111) | 2; // version 2 (unsupported)
            // A generation-v1 descriptor (version 0, chromahash 0.7.x): a v2
            // decoder implements v2 alone, so it rejects it by its version.
            let mut generation_v1 = base.clone();
            generation_v1[0] &= !0b111;
            // The first code that is still reserved. The codes are ordered by
            // quality, so `MAX_TIER + 1` is exactly that code.
            let mut bad_tier = base.clone();
            bad_tier[0] = (bad_tier[0] & !(0b111 << 3)) | ((MAX_TIER + 1) << 3);
            let mut reserved = base.clone();
            reserved[0] |= 1 << 7; // reserved bit set
            let mut too_long = base.clone();
            too_long.push(0); // one byte too many
            let truncated = base[..base.len() - 1].to_vec(); // one byte short
            let tiny = base[..3].to_vec(); // shorter than the fixed header

            let inputs: Vec<(&str, Vec<u8>)> = vec![
                ("valid_default", base.clone()),
                ("valid_default_alpha", valid_alpha.as_bytes().to_vec()),
                ("valid_tier3", valid_t2.as_bytes().to_vec()),
                ("valid_compact", valid_compact.as_bytes().to_vec()),
                (
                    "valid_compact_alpha",
                    valid_compact_alpha.as_bytes().to_vec(),
                ),
                ("empty", Vec::new()),
                ("tiny", tiny),
                ("truncated_by_one", truncated),
                ("one_byte_too_long", too_long),
                ("bad_version", bad_version),
                ("generation_v1", generation_v1),
                ("bad_tier", bad_tier),
                ("reserved_bit_set", reserved),
            ];

            for (name, bytes) in &inputs {
                let result = match ChromaHash::from_bytes(bytes) {
                    Ok(_) => "ok".to_string(),
                    Err(e) => format!("{e:?}"),
                };
                let list: Vec<String> = bytes.iter().map(|b| b.to_string()).collect();
                cases.push(format!(
                    r#"  {{
    "name": "{name}",
    "input": {{ "bytes": [{}] }},
    "expected": {{ "result": "{result}" }}
  }}"#,
                    list.join(","),
                ));
            }
            let json = format!("[\n{}\n]\n", cases.join(",\n"));
            std::fs::write(spec_dir.join("unit-validate.json"), json).unwrap();
        }

        eprintln!("Test vectors generated in {:?}", spec_dir);
    }

    // ── Read the generated vectors back ───────────────────────────────────────
    //
    // Four of the unit vector files — bitpack, cbrt, color, mulaw — were written
    // by the generator above and then read by nothing: not this crate, not
    // `spec/validate.py`, not any binding. A committed file nobody asserts
    // against is not a test — it is a snapshot that regenerates silently.
    //
    // `unit-aspect` and `unit-selection` were left out of this module on the
    // grounds that `spec/validate.py` consumes them, which it does — and as an
    // independent transcription it is the stronger oracle of the two. But
    // `validate.py` runs under `mise run validate:spec`, not under
    // `mise run test`, so a regeneration that quietly changed 45 aspect cases or
    // 488 selection cases was invisible to `cargo test` and to CI's Rust job.
    // They are read back here for that reason: not to replace the Python
    // oracle, but so the Rust suite notices when the vectors move.
    //
    // These read them back through the same kernels. That does not make the
    // vectors an independent oracle — the crate is the reference — but it does
    // turn "someone regenerated the vectors" from an invisible event into a
    // failing test, which is exactly the guarantee `tests/spec_vectors.rs`
    // already gives the integration vectors.
    //
    // Gated on `spec-vectors` for the same reason that test target is: the
    // cargo-mutants sweep builds this crate in isolation, without the sibling
    // `spec/` directory, so `include_str!` could not resolve there.
    #[cfg(feature = "spec-vectors")]
    mod read_back {
        use super::*;
        use serde_json::Value;

        macro_rules! vectors {
            ($name:literal) => {{
                let raw = include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../spec/test-vectors/",
                    $name
                ));
                let parsed: Value = serde_json::from_str(raw)
                    .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", $name));
                let cases = parsed
                    .as_array()
                    .unwrap_or_else(|| panic!("{} should be a JSON array", $name))
                    .clone();
                assert!(!cases.is_empty(), "{} is empty", $name);
                cases
            }};
        }

        fn f64_at(v: &Value) -> f64 {
            v.as_f64().expect("expected a JSON number")
        }

        /// Bit fields must round-trip at every position and width the format
        /// uses, including the ones that straddle a byte boundary.
        ///
        /// Every vector has `read_back == value`, so replaying them alone would
        /// only assert `read(write(x)) == x` — true of any self-consistent pair
        /// of functions, including one that packed bits in the wrong order.
        /// The *placement* is asserted separately below, against the byte
        /// layout the format defines.
        #[test]
        fn unit_bitpack_vectors() {
            let cases = vectors!("unit-bitpack.json");
            for case in &cases {
                let name = case["name"].as_str().unwrap_or("<unnamed>");
                let pos = case["input"]["bitpos"].as_u64().expect("bitpos") as usize;
                let count = case["input"]["count"].as_u64().expect("count") as u32;
                let value = case["input"]["value"].as_u64().expect("value") as u32;
                let expected = case["expected"]["read_back"].as_u64().expect("read_back") as u32;

                let mut buf = [0u8; 32];
                write_bits(&mut buf, pos, count, value);
                assert_eq!(read_bits(&buf, pos, count), expected, "{name}");

                // The written bits must land where the *spec* says, not merely
                // where `read_bits` looks for them. §12.6 is explicit: bit `i`
                // of the value goes to bit `(bitpos + i) % 8` of byte
                // `(bitpos + i) / 8` — LSB-first within each byte. This is
                // transcribed from the spec pseudocode, deliberately not from
                // `bitpack.rs`, so it is a second opinion rather than an echo.
                let mut expected_buf = [0u8; 32];
                for i in 0..count as usize {
                    if (value >> i) & 1 == 1 {
                        expected_buf[(pos + i) / 8] |= 1 << ((pos + i) % 8);
                    }
                }
                assert_eq!(buf, expected_buf, "{name}: byte layout");
            }
        }

        /// The Halley cube root is the hot path in the Oklab transform. The
        /// vectors carry the ULP distance to the reference at generation time;
        /// reproduce the value exactly and stay within that distance.
        #[test]
        fn unit_cbrt_vectors() {
            let cases = vectors!("unit-cbrt.json");
            for case in &cases {
                let name = case["name"].as_str().unwrap_or("<unnamed>");
                let x = f64_at(&case["input"]);
                let expected = f64_at(&case["expected"]);
                let max_ulp = case["max_ulp_error"].as_u64().expect("max_ulp_error");

                let got = cbrt_halley(x);
                assert_eq!(
                    got.to_bits(),
                    expected.to_bits(),
                    "{name}: cbrt_halley({x})"
                );

                let reference = cbrt_signed(x);
                if x != 0.0 && got.is_sign_negative() == reference.is_sign_negative() {
                    assert!(
                        got.to_bits().abs_diff(reference.to_bits()) <= max_ulp.max(1),
                        "{name}: {got} is more than {max_ulp} ULP from {reference}"
                    );
                }
            }
        }

        /// The Oklab transform and its inverse, per gamut. Bit-exact: these are
        /// the numbers every other implementation must reproduce.
        #[test]
        fn unit_color_vectors() {
            let cases = vectors!("unit-color.json");
            for case in &cases {
                let name = case["name"].as_str().unwrap_or("<unnamed>");
                let gamut = match case["input"]["gamut"].as_str().expect("gamut") {
                    "sRGB" => Gamut::Srgb,
                    "Display P3" => Gamut::DisplayP3,
                    "Adobe RGB" => Gamut::AdobeRgb,
                    "BT.2020" => Gamut::Bt2020,
                    "ProPhoto RGB" => Gamut::ProPhotoRgb,
                    other => panic!("{name}: unknown gamut {other:?}"),
                };
                let triple = |v: &Value| -> [f64; 3] {
                    let a = v.as_array().expect("expected a 3-element array");
                    [f64_at(&a[0]), f64_at(&a[1]), f64_at(&a[2])]
                };

                let lab = if let Some(linear) = case["input"].get("linear_rgb") {
                    linear_rgb_to_oklab(triple(linear), gamut)
                } else {
                    let rgb = triple(&case["input"]["gamma_rgb"]);
                    gamma_rgb_to_oklab(rgb[0], rgb[1], rgb[2], gamut)
                };
                let expected_lab = triple(&case["expected"]["oklab"]);
                for c in 0..3 {
                    assert_eq!(
                        lab[c].to_bits(),
                        expected_lab[c].to_bits(),
                        "{name}: oklab[{c}]"
                    );
                }

                if let Some(rt) = case["expected"].get("roundtrip_srgb") {
                    let got = oklab_to_linear_srgb(lab);
                    let expected_rt = triple(rt);
                    for c in 0..3 {
                        assert_eq!(
                            got[c].to_bits(),
                            expected_rt[c].to_bits(),
                            "{name}: roundtrip_srgb[{c}]"
                        );
                    }
                }
            }
        }

        /// The µ-law companding quantizer, at both µ values the format uses and
        /// every bit width — including the never-written top code, which must
        /// clamp rather than run off the end of the level table.
        #[test]
        fn unit_mulaw_vectors() {
            let cases = vectors!("unit-mulaw.json");
            for case in &cases {
                let name = case["name"].as_str().unwrap_or("<unnamed>");
                let input = &case["input"];
                let expected = &case["expected"];
                let bits = input["bits"].as_u64().expect("bits") as u32;
                let mu = f64_at(&input["mu"]);

                // Top-code cases carry only an index; value cases carry the rest.
                if let Some(index) = input.get("index") {
                    let i = index.as_u64().expect("index") as u32;
                    assert_eq!(
                        mu_law_dequantize(i, bits, mu).to_bits(),
                        f64_at(&expected["dequantized"]).to_bits(),
                        "{name}: dequantize"
                    );
                    continue;
                }

                let v = f64_at(&input["value"]);
                assert_eq!(
                    mu_compress(v, mu).to_bits(),
                    f64_at(&expected["compressed"]).to_bits(),
                    "{name}: compress"
                );
                assert_eq!(
                    mu_expand(mu_compress(v, mu), mu).to_bits(),
                    f64_at(&expected["expanded"]).to_bits(),
                    "{name}: expand"
                );
                assert_eq!(
                    mu_law_quantize(v, bits, mu) as u64,
                    expected["quantized"].as_u64().expect("quantized"),
                    "{name}: quantize"
                );
                assert_eq!(
                    mu_law_dequantize(mu_law_quantize(v, bits, mu), bits, mu).to_bits(),
                    f64_at(&expected["dequantized"]).to_bits(),
                    "{name}: dequantize"
                );
            }
        }

        /// Aspect encode/decode and the derived render size, over every distinct
        /// `(ratio, tier)` the format produces.
        ///
        /// `decoded_ratio` is compared bit-exactly: it is an `f64` written at
        /// shortest-round-trip precision, and the whole point of pinning it is
        /// that a decoder reconstructing the ratio one ULP differently would
        /// pick a different render size at some aspect byte.
        #[test]
        fn unit_aspect_vectors() {
            let cases = vectors!("unit-aspect.json");
            for case in &cases {
                let name = case["name"].as_str().unwrap_or("<unnamed>");
                let width = case["input"]["width"].as_u64().expect("width") as u32;
                let height = case["input"]["height"].as_u64().expect("height") as u32;
                let tier = case["input"]["tier"].as_u64().expect("tier") as u8;

                let byte = encode_aspect(width, height);
                assert_eq!(
                    u64::from(byte),
                    case["expected"]["byte"].as_u64().expect("byte"),
                    "{name}: aspect byte"
                );

                let ratio = decode_aspect(byte);
                assert_eq!(
                    ratio.to_bits(),
                    f64_at(&case["expected"]["decoded_ratio"]).to_bits(),
                    "{name}: decoded ratio (bit-exact)"
                );

                let (ow, oh) = decode_output_size(byte, tier);
                assert_eq!(
                    u64::from(ow),
                    case["expected"]["output_width"]
                        .as_u64()
                        .expect("output_width"),
                    "{name}: output width"
                );
                assert_eq!(
                    u64::from(oh),
                    case["expected"]["output_height"]
                        .as_u64()
                        .expect("output_height"),
                    "{name}: output height"
                );
            }
        }

        /// Top-K coefficient selection over every distinct `(W, H, K)` the format
        /// reaches, unweighted and at the shipped weights.
        ///
        /// This is what pins an implementation's *integer* selection key rather
        /// than merely its sort: two implementations can agree on an ordering for
        /// most inputs and diverge on the ties that the Q12 key resolves exactly.
        #[test]
        fn unit_selection_vectors() {
            let cases = vectors!("unit-selection.json");
            for case in &cases {
                let name = case["name"].as_str().unwrap_or("<unnamed>");
                let aspect_byte = case["input"]["aspect_byte"].as_u64().expect("aspect_byte") as u8;
                let tier = case["input"]["tier"].as_u64().expect("tier") as u8;
                let k = case["input"]["k"].as_u64().expect("k") as usize;
                let aniso = f64_at(&case["input"]["aniso"]);
                let hv = f64_at(&case["input"]["hv"]);

                let sel = SelectionOrder::new(aspect_byte, tier, aniso, hv).take(k);

                let expected: Vec<(usize, usize)> = case["expected"]["coeffs"]
                    .as_array()
                    .expect("coeffs")
                    .iter()
                    .map(|pair| {
                        let p = pair.as_array().expect("coeff pair");
                        (
                            p[0].as_u64().expect("cx") as usize,
                            p[1].as_u64().expect("cy") as usize,
                        )
                    })
                    .collect();
                assert_eq!(sel.coeffs, expected, "{name}: selected coefficients");
                assert_eq!(
                    sel.p_k,
                    case["expected"]["p_k"].as_u64().expect("p_k"),
                    "{name}: p_k"
                );
            }
        }
    }
}
