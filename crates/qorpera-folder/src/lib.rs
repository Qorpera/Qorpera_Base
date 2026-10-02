//! The company folder inside a Qorpera machine (`mount`), and the node's vsock bridge to the folder service
//! (`bridge`). The binary is `src/main.rs`; the node side of the protocol is
//! `packages/object-gateway/src/folder-service/`.

pub mod bridge;
pub mod frame;
pub mod link;
pub mod lxd;
pub mod mount;
pub mod proto;
pub mod reads;
pub mod transport;
pub mod tree;
