//! The company folder inside a Qorpera machine (`mount`), the node's vsock bridge to the folder service
//! (`bridge`), the execution host's relay to it (`relay`), and the office folder helper's command starter (`command`).
//! The binary is `src/main.rs`; the node side of the protocol is `packages/object-gateway/src/folder-service/`.

pub mod bridge;
pub mod cache;
pub mod command;
pub mod frame;
pub mod git;
pub mod ignore;
pub mod index;
pub mod link;
pub mod local;
pub mod lxd;
pub mod mount;
pub mod peers;
pub mod proto;
pub mod reads;
pub mod records;
pub mod relay;
pub mod transport;
pub mod tree;
pub mod versions;
pub mod viewfile;
pub mod writer;
