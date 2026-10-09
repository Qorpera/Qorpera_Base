//! A file open for writing (deploy/first-node/RUNTIME-FOLDER-WRITES.md, "Pending bytes"). The node holds the file's
//! chunks; this program holds at most one of them, the one being written, in memory. A write that moves past it sends
//! it (hashed, in parts) and takes up the next; a write inside a chunk already sent reads that chunk back first. At
//! close the last one goes and the node closes the file at its size.
//!
//! The node's rule for a file's chunks: every one but the last exactly 4 MiB, at most 64 of them, and a chunk is set
//! only once every chunk before it is. So a write past the end first fills the gap with zeros, chunk by chunk.

use crate::link::Fail;
use crate::proto::{ErrorReply, CHUNK, MAX_CHUNKS, MAX_READ};

/// Where the chunks of open files go and come back from: the node (`Link`), or a stand-in in tests.
pub trait Chunks {
	/// Sets chunk `index` of the open file `handle` to `data` (at least one byte, at most 4 MiB).
	fn put(&self, handle: u32, index: u32, data: &[u8]) -> Result<(), Fail>;
	/// `length` bytes from `offset` of chunk `index` as the node holds it.
	fn get(&self, handle: u32, index: u32, offset: u64, length: u64) -> Result<Vec<u8>, Fail>;
}

/// The chunk being written.
struct Current {
	index: u64,
	data: Vec<u8>,
	/// Changed since it was sent (or never sent).
	dirty: bool,
}

pub struct Writer {
	pub handle: u32,
	size: u64,
	/// The lengths of the chunks the node holds for the file, from the first. A chunk past the size may linger there;
	/// the close leaves it out.
	held: Vec<u64>,
	current: Option<Current>,
}

fn too_large() -> Fail {
	Fail::Remote(ErrorReply { code: crate::proto::code::TOO_LARGE.into(), message: "The file would pass 256 MiB".into() })
}

/// The length of chunk `index` of a file of `size` bytes.
fn chunk_len(size: u64, index: u64) -> u64 {
	size.saturating_sub(index * CHUNK).min(CHUNK)
}

impl Writer {
	/// A file the node opened as `handle` at `size`: it holds the chunks of that size (none after a truncate).
	pub fn new(handle: u32, size: u64) -> Writer {
		let count = size.div_ceil(CHUNK);
		Writer { handle, size, held: (0..count).map(|i| chunk_len(size, i)).collect(), current: None }
	}

	pub fn size(&self) -> u64 {
		self.size
	}

	/// Makes chunk `index` the one in memory: the one before is sent if it changed; this one is read back if the node
	/// holds it.
	fn load(&mut self, store: &impl Chunks, index: u64) -> Result<(), Fail> {
		if self.current.as_ref().is_some_and(|c| c.index == index) {
			return Ok(());
		}
		self.flush(store)?;
		let data = match self.held.get(index as usize) {
			Some(&len) if len > 0 => {
				let mut data = Vec::with_capacity(CHUNK as usize);
				let mut offset = 0;
				while offset < len {
					let piece = (len - offset).min(MAX_READ as u64);
					let got = store.get(self.handle, index as u32, offset, piece)?;
					if got.len() as u64 != piece {
						return Err(Fail::Link(std::io::Error::other("the node sent a chunk of another length")));
					}
					data.extend_from_slice(&got);
					offset += piece;
				}
				data
			}
			_ => Vec::new(),
		};
		self.current = Some(Current { index, data, dirty: false });
		Ok(())
	}

	/// Sends the chunk in memory if it changed. It stays in memory.
	pub fn flush(&mut self, store: &impl Chunks) -> Result<(), Fail> {
		let Some(current) = self.current.as_mut().filter(|c| c.dirty) else { return Ok(()) };
		let index = current.index as usize;
		if !current.data.is_empty() {
			store.put(self.handle, index as u32, &current.data)?;
		}
		current.dirty = false;
		let len = current.data.len() as u64;
		if index < self.held.len() {
			self.held[index] = len;
		} else {
			// Only ever the next one: the gap before it was filled first.
			debug_assert_eq!(index, self.held.len());
			self.held.push(len);
		}
		Ok(())
	}

	/// Every chunk before `index` made whole, with zeros past the current end: the file is about to reach `index`.
	fn fill_before(&mut self, store: &impl Chunks, index: u64) -> Result<(), Fail> {
		if self.size == 0 && index == 0 {
			return Ok(());
		}
		let last = if self.size == 0 { 0 } else { (self.size - 1) / CHUNK };
		let from = if self.size == 0 { 0 } else if self.size % CHUNK == 0 { last + 1 } else { last };
		for i in from..index {
			self.load(store, i)?;
			let current = self.current.as_mut().expect("loaded");
			current.data.resize(CHUNK as usize, 0);
			current.dirty = true;
			self.size = self.size.max((i + 1) * CHUNK);
		}
		Ok(())
	}

	/// Writes `data` at `offset`.
	pub fn write(&mut self, store: &impl Chunks, offset: u64, data: &[u8]) -> Result<(), Fail> {
		let end = offset.checked_add(data.len() as u64).ok_or_else(too_large)?;
		if end > MAX_CHUNKS * CHUNK {
			return Err(too_large());
		}
		let mut at = offset;
		let mut rest = data;
		while !rest.is_empty() {
			let index = at / CHUNK;
			let within = (at % CHUNK) as usize;
			let take = rest.len().min(CHUNK as usize - within);
			self.fill_before(store, index)?;
			self.load(store, index)?;
			let current = self.current.as_mut().expect("loaded");
			if current.data.len() < within + take {
				current.data.resize(within + take, 0);
			}
			current.data[within..within + take].copy_from_slice(&rest[..take]);
			current.dirty = true;
			at += take as u64;
			rest = &rest[take..];
			self.size = self.size.max(at);
		}
		Ok(())
	}

	/// Up to `length` bytes from `offset`, as the file is now (written but unsent bytes included).
	pub fn read(&mut self, store: &impl Chunks, offset: u64, length: u64) -> Result<Vec<u8>, Fail> {
		let end = offset.saturating_add(length).min(self.size);
		let mut out = Vec::with_capacity(end.saturating_sub(offset) as usize);
		let mut at = offset;
		while at < end {
			let index = at / CHUNK;
			let within = at % CHUNK;
			let take = (end - at).min(CHUNK - within);
			match &self.current {
				Some(c) if c.index == index => {
					let from = (within as usize).min(c.data.len());
					let to = ((within + take) as usize).min(c.data.len());
					out.extend_from_slice(&c.data[from..to]);
					// Within the size but past what the chunk holds: a hole.
					out.resize(out.len() + (take as usize - (to - from)), 0);
				}
				_ => {
					let held = self.held.get(index as usize).copied().unwrap_or(0);
					let to = (within + take).min(held);
					if within < to {
						let mut from = within;
						while from < to {
							let piece = (to - from).min(MAX_READ as u64);
							let got = store.get(self.handle, index as u32, from, piece)?;
							if got.len() as u64 != piece {
								return Err(Fail::Link(std::io::Error::other("the node sent a chunk of another length")));
							}
							out.extend_from_slice(&got);
							from += piece;
						}
					}
					out.resize(out.len() + (take - to.saturating_sub(within).min(take)) as usize, 0);
				}
			}
			at += take;
		}
		Ok(out)
	}

	/// The file's new size: cut short, or grown with zeros. A cut on the 4 MiB grid (or to nothing) sends no chunk: the
	/// node cuts the file's chunks at the close, from its origin's when no chunk of it was sent (folder service, close).
	pub fn truncate(&mut self, store: &impl Chunks, size: u64) -> Result<(), Fail> {
		if size > MAX_CHUNKS * CHUNK {
			return Err(too_large());
		}
		if size >= self.size {
			if size > self.size {
				let index = (size - 1) / CHUNK;
				self.fill_before(store, index)?;
				self.load(store, index)?;
				let current = self.current.as_mut().expect("loaded");
				current.data.resize(chunk_len(size, index) as usize, 0);
				current.dirty = true;
				self.size = size;
			}
			return Ok(());
		}
		let count = size.div_ceil(CHUNK);
		// The new last chunk ends inside: it is cut, and sent again. It is loaded before anything changes, so a cut that
		// fails leaves the file as it was.
		let inside = count > 0 && size % CHUNK != 0;
		if inside {
			self.load(store, count - 1)?;
		}
		if self.current.as_ref().is_some_and(|c| c.index >= count) {
			self.current = None;
		}
		self.held.truncate(count as usize);
		self.size = size;
		if inside {
			let current = self.current.as_mut().expect("loaded");
			current.data.truncate(chunk_len(size, count - 1) as usize);
			current.dirty = true;
		}
		Ok(())
	}

	/// Everything written is with the node: what the close needs.
	pub fn finish(&mut self, store: &impl Chunks) -> Result<u64, Fail> {
		self.flush(store)?;
		Ok(self.size)
	}

	/// The writer of a file the node closed, for the file opened again (as `handle`) at the version that close made: the
	/// chunk in memory stays, so the next write does not read it back.
	pub fn reopened(mut self, handle: u32) -> Writer {
		let count = self.size.div_ceil(CHUNK);
		self.held.truncate(count as usize);
		if self.current.as_ref().is_some_and(|c| c.index >= count) {
			self.current = None;
		}
		self.handle = handle;
		self
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::cell::RefCell;

	/// The node's chunks of one file, with its rules: a chunk is set only once every one before it is.
	#[derive(Default)]
	struct Store {
		chunks: RefCell<Vec<Vec<u8>>>,
		puts: RefCell<Vec<u32>>,
		gets: RefCell<usize>,
		/// The link is down: every chunk asked back fails.
		failing: std::cell::Cell<bool>,
	}

	impl Store {
		fn with(content: &[u8]) -> Store {
			let s = Store::default();
			*s.chunks.borrow_mut() = content.chunks(CHUNK as usize).map(<[u8]>::to_vec).collect();
			s
		}
		/// The file as the node would close it at `size`.
		fn file(&self, size: u64) -> Vec<u8> {
			let chunks = self.chunks.borrow();
			let count = size.div_ceil(CHUNK) as usize;
			assert!(chunks.len() >= count, "the node misses a chunk");
			for (i, c) in chunks[..count].iter().enumerate() {
				assert_eq!(c.len() as u64, chunk_len(size, i as u64), "chunk {i} does not tile the size");
			}
			chunks[..count].concat()
		}
	}

	impl Chunks for Store {
		fn put(&self, _handle: u32, index: u32, data: &[u8]) -> Result<(), Fail> {
			assert!(!data.is_empty() && data.len() as u64 <= CHUNK);
			let mut chunks = self.chunks.borrow_mut();
			assert!(index as usize <= chunks.len(), "a chunk before {index} is missing");
			if index as usize == chunks.len() {
				chunks.push(data.to_vec());
			} else {
				chunks[index as usize] = data.to_vec();
			}
			self.puts.borrow_mut().push(index);
			Ok(())
		}
		fn get(&self, _handle: u32, index: u32, offset: u64, length: u64) -> Result<Vec<u8>, Fail> {
			assert!(length <= MAX_READ as u64);
			if self.failing.get() {
				return Err(Fail::Link(std::io::Error::other("the link is down")));
			}
			*self.gets.borrow_mut() += 1;
			let chunks = self.chunks.borrow();
			let c = &chunks[index as usize];
			Ok(c[offset as usize..(offset + length).min(c.len() as u64) as usize].to_vec())
		}
	}

	fn bytes(len: usize, seed: u8) -> Vec<u8> {
		(0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
	}

	#[test]
	fn a_file_written_in_order_sends_each_chunk_once() {
		let store = Store::default();
		let mut w = Writer::new(1, 0);
		let data = bytes(9 * 1024 * 1024 + 5, 1);
		for piece in data.chunks(128 * 1024).enumerate() {
			w.write(&store, (piece.0 * 128 * 1024) as u64, piece.1).unwrap();
		}
		assert_eq!(w.finish(&store).unwrap(), data.len() as u64);
		assert_eq!(*store.puts.borrow(), [0, 1, 2]);
		assert_eq!(*store.gets.borrow(), 0, "sequential writes never read back");
		assert_eq!(store.file(data.len() as u64), data);
	}

	#[test]
	fn a_write_inside_a_sent_chunk_reads_it_back() {
		let content = bytes(6 * 1024 * 1024, 2);
		let store = Store::with(&content);
		let mut w = Writer::new(1, content.len() as u64);
		// A database page in the first chunk, then one in the second, then the first again.
		w.write(&store, 4096, b"page one").unwrap();
		w.write(&store, 5 * 1024 * 1024, b"page two").unwrap();
		w.write(&store, 8192, b"page three").unwrap();
		let size = w.finish(&store).unwrap();
		let mut expected = content.clone();
		expected[4096..4104].copy_from_slice(b"page one");
		expected[5 * 1024 * 1024..5 * 1024 * 1024 + 8].copy_from_slice(b"page two");
		expected[8192..8202].copy_from_slice(b"page three");
		assert_eq!(store.file(size), expected);
		// What is unsent reads as written; what is sent reads from the node.
		let mut w = Writer::new(2, size);
		w.write(&store, 10, b"XY").unwrap();
		assert_eq!(w.read(&store, 8, 6).unwrap(), [&expected[8..10], b"XY", &expected[12..14]].concat());
		assert_eq!(w.read(&store, 5 * 1024 * 1024, 8).unwrap(), b"page two");
		assert_eq!(w.read(&store, size - 2, 100).unwrap(), &expected[expected.len() - 2..]);
	}

	#[test]
	fn a_write_past_the_end_fills_the_gap_with_zeros() {
		let store = Store::with(b"head");
		let mut w = Writer::new(1, 4);
		w.write(&store, 9 * 1024 * 1024, b"tail").unwrap();
		let size = w.finish(&store).unwrap();
		assert_eq!(size, 9 * 1024 * 1024 + 4);
		let file = store.file(size);
		assert_eq!(&file[..4], b"head");
		assert!(file[4..9 * 1024 * 1024].iter().all(|b| *b == 0));
		assert_eq!(&file[9 * 1024 * 1024..], b"tail");
		assert_eq!(*store.puts.borrow(), [0, 1, 2]);
	}

	#[test]
	fn truncates_short_and_long() {
		let content = bytes(10 * 1024 * 1024, 3);
		let store = Store::with(&content);
		let mut w = Writer::new(1, content.len() as u64);
		w.truncate(&store, 5 * 1024 * 1024 + 7).unwrap();
		assert_eq!(w.finish(&store).unwrap(), 5 * 1024 * 1024 + 7);
		assert_eq!(store.file(5 * 1024 * 1024 + 7), &content[..5 * 1024 * 1024 + 7]);
		// Grown again: zeros, never the old bytes.
		w.truncate(&store, 9 * 1024 * 1024).unwrap();
		let size = w.finish(&store).unwrap();
		let file = store.file(size);
		assert_eq!(&file[..5 * 1024 * 1024 + 7], &content[..5 * 1024 * 1024 + 7]);
		assert!(file[5 * 1024 * 1024 + 7..].iter().all(|b| *b == 0));
		// To nothing, then written again.
		w.truncate(&store, 0).unwrap();
		w.write(&store, 0, b"new").unwrap();
		assert_eq!(w.finish(&store).unwrap(), 3);
		assert_eq!(store.file(3), b"new");
		// Cut on the grid: no chunk is sent again.
		let store = Store::with(&content);
		let mut w = Writer::new(1, content.len() as u64);
		w.truncate(&store, 8 * 1024 * 1024).unwrap();
		assert_eq!(w.finish(&store).unwrap(), 8 * 1024 * 1024);
		assert!(store.puts.borrow().is_empty());
		assert_eq!(store.file(8 * 1024 * 1024), &content[..8 * 1024 * 1024]);
	}

	#[test]
	fn a_cut_that_cannot_read_its_last_chunk_back_leaves_the_file_as_it_was() {
		let content = bytes(10 * 1024 * 1024, 4);
		let store = Store::with(&content);
		let mut w = Writer::new(1, content.len() as u64);
		store.failing.set(true);
		assert!(w.truncate(&store, 5 * 1024 * 1024 + 7).is_err());
		assert_eq!(w.size(), content.len() as u64);
		store.failing.set(false);
		assert_eq!(w.finish(&store).unwrap(), content.len() as u64);
		assert!(store.puts.borrow().is_empty());
		assert_eq!(store.file(content.len() as u64), content);
	}

	#[test]
	fn a_file_opened_again_goes_on_from_the_chunk_in_memory() {
		let store = Store::default();
		let mut w = Writer::new(1, 0);
		let data = bytes(5 * 1024 * 1024 + 3, 5);
		w.write(&store, 0, &data).unwrap();
		let size = w.finish(&store).unwrap();
		// Closed at the node, then opened again at the version that close made: the next write goes on, with nothing
		// read back.
		let mut w = w.reopened(2);
		assert_eq!(w.handle, 2);
		w.write(&store, size, b"more").unwrap();
		assert_eq!(w.read(&store, size - 3, 7).unwrap(), [&data[data.len() - 3..], b"more"].concat());
		assert_eq!(w.finish(&store).unwrap(), size + 4);
		assert_eq!(*store.gets.borrow(), 0);
		assert_eq!(store.file(size + 4), [&data[..], b"more"].concat());
	}

	#[test]
	fn refuses_to_pass_256_mib() {
		let store = Store::default();
		let mut w = Writer::new(1, 0);
		let err = w.write(&store, MAX_CHUNKS * CHUNK, b"x").unwrap_err();
		assert_eq!(err.errno(), libc::EFBIG);
		assert_eq!(w.truncate(&store, MAX_CHUNKS * CHUNK + 1).unwrap_err().errno(), libc::EFBIG);
		assert!(store.puts.borrow().is_empty());
	}
}
