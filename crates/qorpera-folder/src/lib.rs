//! The company folder inside a Qorpera machine (`mount`), the node's vsock bridge to the folder service
//! (`bridge`), and the execution host's relay to it (`relay`). The binary is `src/main.rs`; the node side of the protocol is
//! `packages/object-gateway/src/folder-service/`.

pub mod bridge;
pub mod frame;
pub mod link;
pub mod lxd;
pub mod mount;
pub mod proto;
pub mod reads;
pub mod relay;
pub mod transport;
pub mod tree;
pub mod versions;
pub mod writer;
