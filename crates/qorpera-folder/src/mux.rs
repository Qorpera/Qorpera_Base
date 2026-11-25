// WHY: One Linux epoll loop replaces 2 OS threads and 256 KiB per connection in bridge and relay
// with a shared 128 KiB read buffer and lazy per-connection backpressure queues,
// keeping TasksMax and memory bounded under 512+ simultaneous VM connections.

use crate::transport::Stream;
use std::collections::{HashMap, VecDeque};
use std::io::{self, IoSlice, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const READ_BUF_BYTES: usize = 128 * 1024;
const MAX_PENDING_BYTES: usize = 256 * 1024;
const SHRINK_THRESHOLD_BYTES: usize = 64 * 1024;
const HALF_CLOSE_GRACE: Duration = Duration::from_millis(200);
const WAKE_TOKEN: u64 = 0;
const MAX_EVENTS: usize = 64;

struct NewPair {
	a: Stream,
	b: Stream,
	guard: Box<dyn Send + 'static>,
}

struct MuxInner {
	wake_fd: RawFd,
	pending: Mutex<Vec<NewPair>>,
	stopped: AtomicBool,
}

impl Drop for MuxInner {
	fn drop(&mut self) {
		// SAFETY: wake_fd is owned exclusively by MuxInner and closed once all handles and the loop exit.
		unsafe {
			libc::close(self.wake_fd);
		}
	}
}

pub struct Mux {
	inner: Arc<MuxInner>,
}

impl Mux {
	pub fn spawn(name: &str) -> io::Result<Self> {
		// SAFETY: plain Linux syscalls creating cloexec epoll and eventfd descriptors.
		let epfd = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
		if epfd < 0 {
			return Err(io::Error::last_os_error());
		}
		let wake_fd = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
		if wake_fd < 0 {
			let err = io::Error::last_os_error();
			unsafe { libc::close(epfd) };
			return Err(err);
		}
		if let Err(err) = epoll_ctl(epfd, libc::EPOLL_CTL_ADD, wake_fd, libc::EPOLLIN as u32, WAKE_TOKEN) {
			unsafe {
				libc::close(wake_fd);
				libc::close(epfd);
			}
			return Err(err);
		}
		let inner = Arc::new(MuxInner {
			wake_fd,
			pending: Mutex::new(Vec::new()),
			stopped: AtomicBool::new(false),
		});
		let loop_inner = Arc::clone(&inner);
		let spawned = std::thread::Builder::new().name(name.into()).spawn(move || {
			event_loop(epfd, loop_inner);
		});
		if let Err(err) = spawned {
			unsafe { libc::close(epfd) };
			return Err(err);
		}
		Ok(Self { inner })
	}

	pub fn add(&self, a: Stream, b: Stream, guard: impl Send + 'static) -> io::Result<()> {
		a.set_nonblocking(true)?;
		b.set_nonblocking(true)?;
		self.inner.pending.lock().unwrap().push(NewPair { a, b, guard: Box::new(guard) });
		wake_eventfd(self.inner.wake_fd);
		Ok(())
	}
}

impl Drop for Mux {
	fn drop(&mut self) {
		self.inner.stopped.store(true, Ordering::Release);
		wake_eventfd(self.inner.wake_fd);
	}
}

fn wake_eventfd(fd: RawFd) {
	let one: u64 = 1;
	// SAFETY: writing an 8-byte u64 counter increment to a valid non-blocking eventfd.
	unsafe {
		let _ = libc::write(fd, (&one as *const u64).cast(), std::mem::size_of::<u64>());
	}
}

fn drain_eventfd(fd: RawFd) {
	let mut val: u64 = 0;
	loop {
		// SAFETY: reading an 8-byte counter from a valid non-blocking eventfd.
		let n = unsafe { libc::read(fd, (&mut val as *mut u64).cast(), std::mem::size_of::<u64>()) };
		if n <= 0 {
			break;
		}
	}
}

fn epoll_ctl(epfd: RawFd, op: libc::c_int, fd: RawFd, events: u32, token: u64) -> io::Result<()> {
	let mut ev = libc::epoll_event { events, u64: token };
	let ptr = if op == libc::EPOLL_CTL_DEL { std::ptr::null_mut() } else { &mut ev as *mut libc::epoll_event };
	// SAFETY: epfd and fd are open descriptors owned by the mux thread; ev is valid for ADD/MOD.
	if unsafe { libc::epoll_ctl(epfd, op, fd, ptr) } < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

struct Conn {
	a: Stream,
	b: Stream,
	a_fd: RawFd,
	b_fd: RawFd,
	a_to_b: VecDeque<u8>,
	b_to_a: VecDeque<u8>,
	a_eof: bool,
	b_eof: bool,
	a_shut_wr: bool,
	b_shut_wr: bool,
	a_events: u32,
	b_events: u32,
	a_in_epoll: bool,
	b_in_epoll: bool,
	half_close_deadline: Option<Instant>,
	_guard: Box<dyn Send + 'static>,
}

enum Step {
	Keep,
	Done,
	Abort,
}

fn event_loop(epfd: RawFd, inner: Arc<MuxInner>) {
	let mut conns: HashMap<u64, Conn> = HashMap::new();
	let mut next_id: u64 = 1;
	let mut scratch = vec![0u8; READ_BUF_BYTES];
	let mut events = [libc::epoll_event { events: 0, u64: 0 }; MAX_EVENTS];

	loop {
		admit_pending(epfd, &inner, &mut conns, &mut next_id);
		if inner.stopped.load(Ordering::Acquire) && conns.is_empty() {
			break;
		}
		let timeout_ms = next_timeout_ms(&conns);
		// SAFETY: epfd is valid and events buffer has length MAX_EVENTS.
		let ready = unsafe { libc::epoll_wait(epfd, events.as_mut_ptr(), MAX_EVENTS as libc::c_int, timeout_ms) };
		if ready < 0 {
			let err = io::Error::last_os_error();
			if err.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			break;
		}
		for ev in &events[..ready as usize] {
			if ev.u64 == WAKE_TOKEN {
				drain_eventfd(inner.wake_fd);
				admit_pending(epfd, &inner, &mut conns, &mut next_id);
				continue;
			}
			let id = ev.u64 >> 1;
			let is_b = (ev.u64 & 1) != 0;
			let outcome = match conns.get_mut(&id) {
				Some(conn) => step_conn(epfd, id, conn, is_b, ev.events, &mut scratch),
				None => continue,
			};
			match outcome {
				Step::Keep => {}
				Step::Done => remove_conn(epfd, &mut conns, id, false),
				Step::Abort => remove_conn(epfd, &mut conns, id, true),
			}
		}
		sweep_deadlines(epfd, &mut conns);
	}

	let ids: Vec<u64> = conns.keys().copied().collect();
	for id in ids {
		remove_conn(epfd, &mut conns, id, true);
	}
	// SAFETY: epfd is owned solely by event_loop.
	unsafe {
		libc::close(epfd);
	}
}

fn admit_pending(epfd: RawFd, inner: &MuxInner, conns: &mut HashMap<u64, Conn>, next_id: &mut u64) {
	let incoming = {
		let mut pending = inner.pending.lock().unwrap();
		if pending.is_empty() {
			return;
		}
		std::mem::take(&mut *pending)
	};
	let init_events = (libc::EPOLLIN | libc::EPOLLRDHUP) as u32;
	for pair in incoming {
		let id = *next_id;
		*next_id += 1;
		let a_fd = pair.a.as_raw_fd();
		let b_fd = pair.b.as_raw_fd();
		if epoll_ctl(epfd, libc::EPOLL_CTL_ADD, a_fd, init_events, id << 1).is_err() {
			pair.a.shutdown();
			pair.b.shutdown();
			continue;
		}
		if epoll_ctl(epfd, libc::EPOLL_CTL_ADD, b_fd, init_events, (id << 1) | 1).is_err() {
			let _ = epoll_ctl(epfd, libc::EPOLL_CTL_DEL, a_fd, 0, 0);
			pair.a.shutdown();
			pair.b.shutdown();
			continue;
		}
		conns.insert(
			id,
			Conn {
				a: pair.a,
				b: pair.b,
				a_fd,
				b_fd,
				a_to_b: VecDeque::new(),
				b_to_a: VecDeque::new(),
				a_eof: false,
				b_eof: false,
				a_shut_wr: false,
				b_shut_wr: false,
				a_events: init_events,
				b_events: init_events,
				a_in_epoll: true,
				b_in_epoll: true,
				half_close_deadline: None,
				_guard: pair.guard,
			},
		);
	}
}

fn next_timeout_ms(conns: &HashMap<u64, Conn>) -> libc::c_int {
	let mut earliest: Option<Instant> = None;
	for conn in conns.values() {
		if let Some(d) = conn.half_close_deadline {
			earliest = Some(match earliest {
				Some(cur) if cur <= d => cur,
				_ => d,
			});
		}
	}
	let Some(deadline) = earliest else { return -1 };
	let now = Instant::now();
	if now >= deadline {
		0
	} else {
		(deadline.duration_since(now).as_millis().min(libc::c_int::MAX as u128) as libc::c_int).max(1)
	}
}

fn sweep_deadlines(epfd: RawFd, conns: &mut HashMap<u64, Conn>) {
	let now = Instant::now();
	let mut expired = Vec::new();
	for (&id, conn) in conns.iter() {
		if conn.half_close_deadline.is_some_and(|d| now >= d) {
			expired.push(id);
		}
	}
	for id in expired {
		remove_conn(epfd, conns, id, true);
	}
}

fn remove_conn(epfd: RawFd, conns: &mut HashMap<u64, Conn>, id: u64, abort: bool) {
	let Some(conn) = conns.remove(&id) else { return };
	if conn.a_in_epoll {
		let _ = epoll_ctl(epfd, libc::EPOLL_CTL_DEL, conn.a_fd, 0, 0);
	}
	if conn.b_in_epoll {
		let _ = epoll_ctl(epfd, libc::EPOLL_CTL_DEL, conn.b_fd, 0, 0);
	}
	if abort {
		conn.a.shutdown();
		conn.b.shutdown();
	}
	drop(conn);
}

fn step_conn(epfd: RawFd, id: u64, conn: &mut Conn, is_b: bool, mask: u32, scratch: &mut [u8]) -> Step {
	let readable = (mask & (libc::EPOLLIN | libc::EPOLLHUP | libc::EPOLLRDHUP | libc::EPOLLERR) as u32) != 0;
	let writable = (mask & libc::EPOLLOUT as u32) != 0;
	let fatal_flag = (mask & (libc::EPOLLERR | libc::EPOLLHUP) as u32) != 0;

	if !is_b {
		if writable && !conn.b_to_a.is_empty() && drain_queue(&mut conn.a, &mut conn.b_to_a).is_err() {
			return Step::Abort;
		}
		if readable && !conn.a_eof {
			if pump_read(&mut conn.a, &mut conn.b, &mut conn.a_to_b, &mut conn.a_eof, scratch).is_err() {
				return Step::Abort;
			}
		} else if fatal_flag {
			return Step::Abort;
		}
	} else {
		if writable && !conn.a_to_b.is_empty() && drain_queue(&mut conn.b, &mut conn.a_to_b).is_err() {
			return Step::Abort;
		}
		if readable && !conn.b_eof {
			if pump_read(&mut conn.b, &mut conn.a, &mut conn.b_to_a, &mut conn.b_eof, scratch).is_err() {
				return Step::Abort;
			}
		} else if fatal_flag {
			return Step::Abort;
		}
	}

	// WHY: Propagate clean EOF with SHUT_WR so half-closed client requests still receive in-flight responses.
	if conn.a_eof && conn.a_to_b.is_empty() && !conn.b_shut_wr {
		conn.b.shutdown_write();
		conn.b_shut_wr = true;
	}
	if conn.b_eof && conn.b_to_a.is_empty() && !conn.a_shut_wr {
		conn.a.shutdown_write();
		conn.a_shut_wr = true;
		// WHY: Bound teardown when the upstream closes an idle pooled socket so slots are freed promptly.
		if !conn.a_eof && conn.half_close_deadline.is_none() {
			conn.half_close_deadline = Some(Instant::now() + HALF_CLOSE_GRACE);
		}
	}

	if conn.a_eof && conn.a_to_b.is_empty() && conn.b_eof && conn.b_to_a.is_empty() {
		return Step::Done;
	}

	let want_a = side_events(conn.a_eof, conn.a_to_b.len(), !conn.b_to_a.is_empty());
	let want_b = side_events(conn.b_eof, conn.b_to_a.len(), !conn.a_to_b.is_empty());
	if update_epoll(epfd, conn.a_fd, id << 1, &mut conn.a_in_epoll, &mut conn.a_events, want_a).is_err()
		|| update_epoll(epfd, conn.b_fd, (id << 1) | 1, &mut conn.b_in_epoll, &mut conn.b_events, want_b).is_err()
	{
		return Step::Abort;
	}
	Step::Keep
}

fn side_events(src_eof: bool, out_len: usize, need_write: bool) -> u32 {
	let mut ev = 0u32;
	if !src_eof && out_len < MAX_PENDING_BYTES {
		ev |= (libc::EPOLLIN | libc::EPOLLRDHUP) as u32;
	}
	if need_write {
		ev |= libc::EPOLLOUT as u32;
	}
	ev
}

fn update_epoll(
	epfd: RawFd,
	fd: RawFd,
	token: u64,
	in_epoll: &mut bool,
	current: &mut u32,
	want: u32,
) -> io::Result<()> {
	// WHY: Remove half-closed fds with want==0 from epoll so Linux's implicit EPOLLHUP monitoring never busy-spins.
	if want == 0 {
		if *in_epoll {
			epoll_ctl(epfd, libc::EPOLL_CTL_DEL, fd, 0, 0)?;
			*in_epoll = false;
			*current = 0;
		}
		return Ok(());
	}
	if !*in_epoll {
		epoll_ctl(epfd, libc::EPOLL_CTL_ADD, fd, want, token)?;
		*in_epoll = true;
		*current = want;
	} else if *current != want {
		epoll_ctl(epfd, libc::EPOLL_CTL_MOD, fd, want, token)?;
		*current = want;
	}
	Ok(())
}

fn drain_queue(dst: &mut Stream, q: &mut VecDeque<u8>) -> io::Result<()> {
	while !q.is_empty() {
		let (s1, s2) = q.as_slices();
		let res = if s2.is_empty() {
			dst.write(s1)
		} else {
			dst.write_vectored(&[IoSlice::new(s1), IoSlice::new(s2)])
		};
		match res {
			Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "peer write zero")),
			Ok(n) => {
				q.drain(..n);
			}
			Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
			Err(e) => return Err(e),
		}
	}
	if q.is_empty() && q.capacity() > SHRINK_THRESHOLD_BYTES {
		*q = VecDeque::new();
	}
	Ok(())
}

fn pump_read(
	src: &mut Stream,
	dst: &mut Stream,
	q: &mut VecDeque<u8>,
	src_eof: &mut bool,
	scratch: &mut [u8],
) -> io::Result<()> {
	while !*src_eof && q.len() < MAX_PENDING_BYTES {
		let n = match src.read(scratch) {
			Ok(0) => {
				*src_eof = true;
				break;
			}
			Ok(n) => n,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
			Err(e) => return Err(e),
		};
		if q.is_empty() {
			let mut pos = 0;
			while pos < n {
				match dst.write(&scratch[pos..n]) {
					Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "peer write zero")),
					Ok(w) => pos += w,
					Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
					Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
						q.extend(&scratch[pos..n]);
						break;
					}
					Err(e) => return Err(e),
				}
			}
		} else {
			q.extend(&scratch[..n]);
			drain_queue(dst, q)?;
		}
	}
	Ok(())
}

type Job = Box<dyn FnOnce() + Send + 'static>;

struct PoolState {
	queue: VecDeque<Job>,
	stopped: bool,
}

pub struct WorkerPool {
	state: Arc<(Mutex<PoolState>, Condvar)>,
}

impl WorkerPool {
	pub fn new(name: &str, workers: usize) -> io::Result<Self> {
		let state = Arc::new((Mutex::new(PoolState { queue: VecDeque::new(), stopped: false }), Condvar::new()));
		for i in 0..workers.max(1) {
			let shared = Arc::clone(&state);
			std::thread::Builder::new().name(format!("{name}-{i}")).spawn(move || {
				let (lock, wake) = &*shared;
				loop {
					let job = {
						let mut s = lock.lock().unwrap();
						while s.queue.is_empty() && !s.stopped {
							s = wake.wait(s).unwrap();
						}
						match s.queue.pop_front() {
							Some(job) => job,
							None => return,
						}
					};
					job();
				}
			})?;
		}
		Ok(Self { state })
	}

	pub fn submit(&self, job: impl FnOnce() + Send + 'static) {
		let (lock, wake) = &*self.state;
		let mut s = lock.lock().unwrap();
		if !s.stopped {
			s.queue.push_back(Box::new(job));
			wake.notify_one();
		}
	}
}

impl Drop for WorkerPool {
	fn drop(&mut self) {
		let (lock, wake) = &*self.state;
		lock.lock().unwrap().stopped = true;
		wake.notify_all();
	}
}
