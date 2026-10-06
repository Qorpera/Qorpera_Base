//! Streams on the folder link: vsock between a VM and its node, or a Unix socket (the node's bridge
//! to its service, and local tests).

use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

pub enum Stream {
	Vsock(vsock::VsockStream),
	Unix(UnixStream),
}

impl Read for Stream {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Stream::Vsock(s) => s.read(buf),
			Stream::Unix(s) => s.read(buf),
		}
	}
}

impl Write for Stream {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Stream::Vsock(s) => s.write(buf),
			Stream::Unix(s) => s.write(buf),
		}
	}
	fn flush(&mut self) -> io::Result<()> {
		match self {
			Stream::Vsock(s) => s.flush(),
			Stream::Unix(s) => s.flush(),
		}
	}
}

impl Stream {
	pub fn try_clone(&self) -> io::Result<Stream> {
		Ok(match self {
			Stream::Vsock(s) => Stream::Vsock(s.try_clone()?),
			Stream::Unix(s) => Stream::Unix(s.try_clone()?),
		})
	}

	pub fn set_timeouts(&self, read: Option<Duration>, write: Option<Duration>) -> io::Result<()> {
		match self {
			Stream::Vsock(s) => {
				s.set_read_timeout(read)?;
				s.set_write_timeout(write)
			}
			Stream::Unix(s) => {
				s.set_read_timeout(read)?;
				s.set_write_timeout(write)
			}
		}
	}

	pub fn shutdown(&self) {
		let _ = match self {
			Stream::Vsock(s) => s.shutdown(std::net::Shutdown::Both),
			Stream::Unix(s) => s.shutdown(std::net::Shutdown::Both),
		};
	}
}

pub enum Listener {
	Vsock(vsock::VsockListener),
	Unix(UnixListener),
}

impl Listener {
	/// `vsock:any:<port>` or `unix:<path>`.
	pub fn bind(addr: &str) -> io::Result<Listener> {
		if let Some(rest) = addr.strip_prefix("vsock:") {
			let (cid, port) = rest.split_once(':').ok_or_else(|| bad("vsock:<cid|any>:<port>"))?;
			let cid = if cid == "any" { vsock::VMADDR_CID_ANY } else { cid.parse().map_err(|_| bad("bad CID"))? };
			let port = port.parse().map_err(|_| bad("bad port"))?;
			Ok(Listener::Vsock(vsock::VsockListener::bind_with_cid_port(cid, port)?))
		} else if let Some(path) = addr.strip_prefix("unix:") {
			Ok(Listener::Unix(UnixListener::bind(path)?))
		} else {
			Err(bad("address must be vsock:... or unix:..."))
		}
	}

	/// The stream and, for vsock, the peer's CID as the kernel reports it (a VM cannot choose it).
	pub fn accept(&self) -> io::Result<(Stream, Option<u32>)> {
		match self {
			Listener::Vsock(l) => {
				let (s, a) = l.accept()?;
				Ok((Stream::Vsock(s), Some(a.cid())))
			}
			Listener::Unix(l) => {
				let (s, _) = l.accept()?;
				Ok((Stream::Unix(s), None))
			}
		}
	}
}

/// `vsock:<cid>:<port>` (the host is CID 2) or `unix:<path>`.
pub fn connect(addr: &str) -> io::Result<Stream> {
	if let Some(rest) = addr.strip_prefix("vsock:") {
		let (cid, port) = rest.split_once(':').ok_or_else(|| bad("vsock:<cid>:<port>"))?;
		let cid = cid.parse().map_err(|_| bad("bad CID"))?;
		let port = port.parse().map_err(|_| bad("bad port"))?;
		Ok(Stream::Vsock(vsock::VsockStream::connect_with_cid_port(cid, port)?))
	} else if let Some(path) = addr.strip_prefix("unix:") {
		Ok(Stream::Unix(UnixStream::connect(path)?))
	} else {
		Err(bad("address must be vsock:... or unix:..."))
	}
}

fn bad(msg: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, msg.to_string())
}
