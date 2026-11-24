//! The core baseline arm of the C ABI's overhead counts: the protocol of
//! `bindings/overhead/protocol.rs` over the Rust core, built in this crate with
//! the same profile as `overhead_c`, its A/B partner.

#[path = "../../overhead/protocol.rs"]
mod protocol;

#[path = "../../overhead/core_layer.rs"]
mod core_layer;

fn main() {
    protocol::main(core_layer::Core::default());
}
