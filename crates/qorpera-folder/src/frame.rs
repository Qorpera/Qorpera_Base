//! Frames on the folder link: a u32 big-endian length (of the type byte plus the payload), one type
//! byte, then the payload. Control messages carry JSON; a read reply carries the bytes as they are.

use std::io::{self, Read, Write};

/// The largest payload either side sends or accepts: one read reply (at most `MAX_READ`) or one
/// listing page, with room to spare.
pub const MAX_PAYLOAD: usize = 2 * 1024 * 1024;

/// Frame types. Upper case is sent towards the node, lower case back towards the machine.
pub mod kind {
	/// Bridge to service only: the peer's vsock CID, as the node saw it. Never sent by a machine.
	pub const BRIDGE: u8 = b'B';
	pub const HELLO: u8 = b'H';
	pub const HELLO_OK: u8 = b'h';
	pub const LIST: u8 = b'L';
	pub const LISTING: u8 = b'l';
	pub const READ: u8 = b'R';
	pub const DATA: u8 = b'd';
	pub const CHANGE: u8 = b'c';
	pub const ACK: u8 = b'a';
	pub const ERROR: u8 = b'e';
	// Writes (protocol 2).
	pub const OPEN: u8 = b'O';
	pub const OPENED: u8 = b'o';
	/// One part of a chunk: `[u32 header length][header JSON][bytes]`.
	pub const CHUNK: u8 = b'K';
	/// Part of an open file's chunk back (answered with `d`).
	pub const GET_CHUNK: u8 = b'G';
	pub const CLOSE: u8 = b'C';
	pub const MKDIR: u8 = b'M';
	pub const UNLINK: u8 = b'U';
	pub const RMDIR: u8 = b'D';
	pub const RENAME: u8 = b'N';
	pub const EXECUTABLE: u8 = b'X';
	/// A write request's answer.
	pub const DONE: u8 = b'k';
	pub const PUBLISH: u8 = b'P';
	pub const REPORT: u8 = b'p';
}

pub fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
	if payload.len() > MAX_PAYLOAD {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame payload too large"));
	}
	let len = (payload.len() + 1) as u32;
	// One write for the common small frame; two for a large read reply rather than copying it.
	if payload.len() <= 64 * 1024 {
		let mut buf = Vec::with_capacity(5 + payload.len());
		buf.extend_from_slice(&len.to_be_bytes());
		buf.push(kind);
		buf.extend_from_slice(payload);
		w.write_all(&buf)?;
	} else {
		let mut head = [0u8; 5];
		head[..4].copy_from_slice(&len.to_be_bytes());
		head[4] = kind;
		w.write_all(&head)?;
		w.write_all(payload)?;
	}
	w.flush()
}

pub fn read_frame(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
	let mut head = [0u8; 5];
	r.read_exact(&mut head)?;
	let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
	if len == 0 || len - 1 > MAX_PAYLOAD {
		return Err(io::Error::new(io::ErrorKind::InvalidData, "bad frame length"));
	}
	let mut payload = vec![0u8; len - 1];
	r.read_exact(&mut payload)?;
	Ok((head[4], payload))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn round_trips_small_and_large_frames() {
		for size in [0usize, 1, 64 * 1024, 64 * 1024 + 1, MAX_PAYLOAD] {
			let payload: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
			let mut buf = Vec::new();
			write_frame(&mut buf, kind::DATA, &payload).unwrap();
			assert_eq!(buf.len(), 5 + size);
			let (k, back) = read_frame(&mut buf.as_slice()).unwrap();
			assert_eq!(k, kind::DATA);
			assert_eq!(back, payload);
		}
	}

	#[test]
	fn refuses_oversized_and_empty_frames() {
		let mut buf = Vec::new();
		assert!(write_frame(&mut buf, kind::DATA, &vec![0u8; MAX_PAYLOAD + 1]).is_err());
		assert!(buf.is_empty());
		let too_long = ((MAX_PAYLOAD + 2) as u32).to_be_bytes();
		let mut wire = too_long.to_vec();
		wire.push(kind::DATA);
		assert_eq!(read_frame(&mut wire.as_slice()).unwrap_err().kind(), io::ErrorKind::InvalidData);
		let empty = [0u8, 0, 0, 0, kind::DATA];
		assert_eq!(read_frame(&mut empty.as_slice()).unwrap_err().kind(), io::ErrorKind::InvalidData);
	}

	#[test]
	fn a_cut_frame_is_an_error() {
		let mut buf = Vec::new();
		write_frame(&mut buf, kind::LIST, b"{\"path\":\"\"}").unwrap();
		buf.truncate(buf.len() - 1);
		assert_eq!(read_frame(&mut buf.as_slice()).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
	}
}
