//! Every line-anchored exclusion in `.cargo/mutants.toml` still points at the
//! operator its proof is about.
//!
//! An entry such as `"src/encode.rs:994:28: delete - in quantize_one"` names a
//! file, line and column. When code above it moves, the anchor stops matching
//! and the sweep reports the mutant as missed again: safe, but noisy, and a
//! sweep is hours long. Worse, a shifted anchor can land on a *different*
//! operator of the same kind and silently exempt it. This test reads each
//! anchor and checks that the source text at that line and column is the
//! operator the pattern replaces or deletes, so drift fails `cargo test`
//! instead of a weekly sweep.

use std::fs;
use std::path::Path;

/// `(file, line, column, operator)` for each anchored `exclude_re` entry.
fn anchors(toml: &str) -> Vec<(String, usize, usize, String)> {
    let mut out = Vec::new();
    for raw in toml.lines() {
        let line = raw.trim();
        if !line.starts_with("\"src/") {
            continue;
        }
        let body = line.trim_start_matches('"');
        let body = body[..body.rfind('"').expect("closing quote")].to_string();
        // `file:LINE:COL` then either `: replace …` or `.*replace …`.
        let mut parts = body.splitn(3, ':');
        let file = parts.next().unwrap().to_string();
        let (Some(l), Some(tail)) = (parts.next(), parts.next()) else {
            continue; // not line-anchored (a whole-file or whole-function entry)
        };
        let digits = tail.chars().take_while(char::is_ascii_digit).count();
        let (Ok(l), Ok(c)) = (l.parse::<usize>(), tail[..digits].parse::<usize>()) else {
            continue;
        };
        // The operator is the token after `replace ` or `delete `, with the
        // TOML string's regex escaping (`\\+`, `\\|`) undone.
        let rest = tail[digits..]
            .trim_start_matches(':')
            .trim_start_matches(".*")
            .trim();
        let op = rest
            .strip_prefix("replace ")
            .or_else(|| rest.strip_prefix("delete "))
            .unwrap_or_else(|| panic!("unrecognised anchored entry: {line}"))
            .split_whitespace()
            .next()
            .unwrap()
            .replace("\\\\", "");
        out.push((file, l, c, op));
    }
    out
}

#[test]
fn every_anchored_exclusion_lands_on_its_operator() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let toml = fs::read_to_string(root.join(".cargo/mutants.toml")).expect("mutants.toml");
    let found = anchors(&toml);
    assert!(
        found.len() >= 10,
        "premise: the file carries line-anchored entries ({} found)",
        found.len()
    );
    for (file, l, c, op) in found {
        let src = fs::read_to_string(root.join(&file)).unwrap_or_else(|_| panic!("{file}"));
        let text = src
            .lines()
            .nth(l - 1)
            .unwrap_or_else(|| panic!("{file}:{l}"));
        let at = text
            .get(c - 1..)
            .unwrap_or_else(|| panic!("{file}:{l}:{c}"));
        assert!(
            at.starts_with(&op),
            "{file}:{l}:{c} should be `{op}` but reads `{}`: re-anchor the entry",
            at.chars().take(12).collect::<String>()
        );
    }
}
