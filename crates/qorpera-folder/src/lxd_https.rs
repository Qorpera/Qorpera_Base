//! The bridge's own access to LXD: a client certificate on LXD's pinned loopback HTTPS listener, in place of the
//! socket's group (WS15 V2-A1..A10). The files and their rules are `lxd-https.ts`'s in the runner orchestrator:
//! - `listener.json` (root's, 0644): `{"schema", "origin": "https://127.0.0.1:<port>" or "https://[::1]:<port>",
//!   "certificateSha256"}`, the SHA-256 of the listener's certificate (DER, lower-case hex), the pin;
//! - `<account>/client.crt` and `<account>/client.key`, root's, in a folder of the account's group, the key 0400 or
//!   0440. LXD names the caller by the certificate's SHA-256.
//!
//! TLS 1.3 only, with no SNI, no resumption and no ALPN (LXD's listener would agree only to h2). The pin is checked
//! inside the handshake, so a listener that is not the pinned one gets no request byte and not our certificate.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{ClientConfig, ClientConnection, Resumption};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::sign::CertifiedKey;
use rustls::{CertificateError, DigitallySignedStruct, ProtocolVersion, SignatureScheme, StreamOwned};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{Metadata, OpenOptions};
use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ROOT: &str = "/etc/qorpera-lxd-ids";
const LISTENER_SCHEMA: &str = "qorpera.lxd-listener/v1";
const MAX_LISTENER: u64 = 4096;
const MAX_IDENTITY: u64 = 16384;
/// The TCP connect and the whole TLS handshake: a listener that answers slowly cannot stretch it.
const HANDSHAKE: Duration = Duration::from_secs(5);
/// Each read and write after the handshake.
const TIMEOUT: Duration = Duration::from_secs(5);
/// Local file systems (statfs magic numbers): ext4, xfs, btrfs, zfs, overlay, tmpfs. No network file system.
const LOCAL: [i64; 6] = [0xEF53, 0x5846_5342, 0x9123_683E, 0x2FC1_2FC1, 0x794C_7630, 0x0102_1994];

pub type Connection = StreamOwned<ClientConnection, TcpStream>;

/// This account's access: where the listener is, which certificate it must show, and our identity. Holds the key
/// inside the TLS configuration; the key file's bytes are zeroed once read.
pub struct Https {
	address: SocketAddr,
	identity: [u8; 32],
	config: Arc<ClientConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Listener {
	schema: String,
	origin: String,
	certificate_sha256: String,
}

impl Https {
	/// This process's access, read from `root` with the protected reads: root's files on a local disk, no links, the
	/// key readable only by root and this process's group.
	pub fn read(root: &Path) -> io::Result<Https> {
		let account = account()?;
		let listener = protected(&root.join("listener.json"), MAX_LISTENER, false)
			.map_err(|e| invalid("LXD_LISTENER_INVALID", &e.to_string()))?;
		let certificate = protected(&root.join(&account).join("client.crt"), MAX_IDENTITY, false)
			.map_err(|e| invalid("LXD_IDENTITY_INVALID", &e.to_string()))?;
		let key = protected(&root.join(&account).join("client.key"), MAX_IDENTITY, true)
			.map_err(|e| invalid("LXD_IDENTITY_INVALID", &e.to_string()))?;
		Https::from_files(&listener, &certificate, key)
	}

	/// Checks the three files' bytes. Zeroes `key` whether or not they hold.
	pub fn from_files(listener: &[u8], certificate: &[u8], key: Vec<u8>) -> io::Result<Https> {
		let key = Wiped(key);
		// An object: serde would also take the three values as an array.
		if listener.iter().copied().find(|b| !b" \t\r\n".contains(b)) != Some(b'{') {
			return Err(invalid("LXD_LISTENER_INVALID", "not a JSON object"));
		}
		let record: Listener =
			serde_json::from_slice(listener).map_err(|e| invalid("LXD_LISTENER_INVALID", &e.to_string()))?;
		if record.schema != LISTENER_SCHEMA {
			return Err(invalid("LXD_LISTENER_INVALID", "another schema"));
		}
		let address = origin(&record.origin)
			.ok_or_else(|| invalid("LXD_LISTENER_INVALID", "the origin is not https://127.0.0.1:<port> or https://[::1]:<port>"))?;
		let pin = sha256_hex(&record.certificate_sha256)
			.ok_or_else(|| invalid("LXD_LISTENER_INVALID", "certificateSha256 is not 64 lower-case hex digits"))?;

		let pems = certificate.windows(11).filter(|w| *w == b"-----BEGIN ").count();
		if pems != 1 || !certificate.starts_with(b"-----BEGIN CERTIFICATE-----") {
			return Err(invalid("LXD_IDENTITY_INVALID", "client.crt is not one PEM certificate"));
		}
		let cert = CertificateDer::from_pem_slice(certificate)
			.map_err(|_| invalid("LXD_IDENTITY_INVALID", "client.crt is not a PEM certificate"))?;
		let private =
			PrivateKeyDer::from_pem_slice(&key.0).map_err(|_| invalid("LXD_IDENTITY_INVALID", "client.key is not a PEM key"))?;
		let provider = Arc::new(rustls::crypto::ring::default_provider());
		// from_der lets through a key whose public half it cannot work out; keys_match does not.
		CertifiedKey::from_der(vec![cert.clone()], private.clone_key(), &provider)
			.and_then(|c| c.keys_match())
			.map_err(|e| invalid("LXD_IDENTITY_INVALID", &format!("client.key does not match client.crt: {e}")))?;
		let identity = digest(&cert);
		if identity == pin {
			return Err(invalid("LXD_IDENTITY_INVALID", "the client certificate is the listener's"));
		}
		let algorithms = provider.signature_verification_algorithms;
		let mut config = ClientConfig::builder_with_provider(provider)
			.with_protocol_versions(&[&rustls::version::TLS13])
			.map_err(|e| invalid("LXD_IDENTITY_INVALID", &e.to_string()))?
			.dangerous()
			// The pin is the server check: LXD's certificate is its own, under no CA.
			.with_custom_certificate_verifier(Arc::new(Pinned { sha256: pin, algorithms }))
			.with_client_auth_cert(vec![cert], private)
			.map_err(|e| invalid("LXD_IDENTITY_INVALID", &e.to_string()))?;
		config.enable_sni = false;
		config.resumption = Resumption::disabled();
		Ok(Https { address, identity, config: Arc::new(config) })
	}

	/// The listener's address as a Host header: `127.0.0.1:<port>` or `[::1]:<port>`.
	pub fn host(&self) -> String {
		self.address.to_string()
	}

	/// SHA-256 of this account's client certificate: how LXD names the caller (auth_user_name).
	pub fn identity(&self) -> [u8; 32] {
		self.identity
	}

	/// One connection to the pinned listener, handed over only after the whole handshake.
	pub fn connect(&self) -> io::Result<Connection> {
		let deadline = Instant::now() + HANDSHAKE;
		let timed_out = || io::Error::new(io::ErrorKind::TimedOut, "LXD_HTTPS_HANDSHAKE_TIMEOUT");
		let mut tcp = TcpStream::connect_timeout(&self.address, HANDSHAKE).map_err(|e| match e.kind() {
			io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => timed_out(),
			_ => io::Error::other(format!("LXD_HTTPS_UNAVAILABLE: {e}")),
		})?;
		tcp.set_nodelay(true)?;
		let mut tls = ClientConnection::new(self.config.clone(), ServerName::from(self.address.ip()))
			.map_err(|e| io::Error::other(format!("LXD_HTTPS_UNAVAILABLE: {e}")))?;
		// A read or write that timed out is tried again until the whole handshake's deadline.
		let again = |e: &io::Error| {
			matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted)
		};
		while tls.is_handshaking() || tls.wants_write() {
			let left = deadline.saturating_duration_since(Instant::now());
			if left.is_zero() {
				return Err(timed_out());
			}
			tcp.set_read_timeout(Some(left))?;
			tcp.set_write_timeout(Some(left))?;
			if tls.wants_write() {
				match tls.write_tls(&mut tcp) {
					Err(e) if !again(&e) => return Err(io::Error::other(format!("LXD_HTTPS_UNAVAILABLE: {e}"))),
					_ => continue,
				}
			}
			match tls.read_tls(&mut tcp) {
				Ok(0) => {
					return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "LXD_HTTPS_UNAVAILABLE: the listener closed"))
				}
				Ok(_) => {}
				Err(e) if again(&e) => continue,
				Err(e) => return Err(io::Error::other(format!("LXD_HTTPS_UNAVAILABLE: {e}"))),
			}
			if let Err(e) = tls.process_new_packets() {
				// Tell the listener why (best effort), then stop.
				let _ = tls.write_tls(&mut tcp);
				return Err(match e {
					rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure) => {
						io::Error::other("LXD_HTTPS_SERVER_UNPINNED")
					}
					e => io::Error::other(format!("LXD_HTTPS_UNAVAILABLE: {e}")),
				});
			}
		}
		if tls.protocol_version() != Some(ProtocolVersion::TLSv1_3) || tls.alpn_protocol().is_some() {
			return Err(io::Error::other("LXD_HTTPS_UNAVAILABLE: not TLS 1.3 without ALPN"));
		}
		tcp.set_read_timeout(Some(TIMEOUT))?;
		tcp.set_write_timeout(Some(TIMEOUT))?;
		Ok(StreamOwned::new(tls, tcp))
	}
}

/// The listener must show the pinned certificate; the handshake's signatures are checked as usual.
#[derive(Debug)]
struct Pinned {
	sha256: [u8; 32],
	algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pinned {
	fn verify_server_cert(
		&self,
		end_entity: &CertificateDer<'_>,
		_intermediates: &[CertificateDer<'_>],
		_server_name: &ServerName<'_>,
		_ocsp_response: &[u8],
		_now: UnixTime,
	) -> Result<ServerCertVerified, rustls::Error> {
		if digest(end_entity) == self.sha256 {
			Ok(ServerCertVerified::assertion())
		} else {
			Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
		}
	}

	fn verify_tls12_signature(
		&self,
		message: &[u8],
		cert: &CertificateDer<'_>,
		dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, rustls::Error> {
		verify_tls12_signature(message, cert, dss, &self.algorithms)
	}

	fn verify_tls13_signature(
		&self,
		message: &[u8],
		cert: &CertificateDer<'_>,
		dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, rustls::Error> {
		verify_tls13_signature(message, cert, dss, &self.algorithms)
	}

	fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
		self.algorithms.supported_schemes()
	}
}

/// The file's bytes, read only if every folder above it is root's and writable by root alone, and the file is root's
/// own, regular, with one link, on a local disk, at most `limit` bytes, and unchanged while read. A `confidential`
/// file (the key) must be mode 0400, or 0440 with this process's group.
fn protected(path: &Path, limit: u64, confidential: bool) -> io::Result<Vec<u8>> {
	let refused = |why: &str| io::Error::new(io::ErrorKind::PermissionDenied, format!("{}: {why}", path.display()));
	if !path.is_absolute() {
		return Err(refused("not an absolute path"));
	}
	for folder in path.ancestors().skip(1) {
		let meta = std::fs::symlink_metadata(folder)?;
		if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o6022 != 0 {
			return Err(refused(&format!("{} is not a folder only root may change", folder.display())));
		}
	}
	let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)?;
	// SAFETY: statfs is plain data, valid when all zero.
	let mut fs: libc::statfs = unsafe { std::mem::zeroed() };
	// SAFETY: fstatfs writes only `fs`, a local, for a descriptor this function holds open.
	if unsafe { libc::fstatfs(file.as_raw_fd(), &mut fs) } != 0 {
		return Err(io::Error::last_os_error());
	}
	#[allow(clippy::unnecessary_cast)]
	let kind = fs.f_type as i64;
	if !LOCAL.contains(&kind) {
		return Err(refused("not on a local disk"));
	}
	let before = file.metadata()?;
	if !before.is_file() || before.uid() != 0 || before.mode() & 0o6022 != 0 {
		return Err(refused("not a regular file only root may change"));
	}
	if confidential {
		let mode = before.mode() & 0o7777;
		// SAFETY: getegid has no preconditions.
		if !(mode == 0o400 || mode == 0o440) || (mode & 0o040 != 0 && before.gid() != unsafe { libc::getegid() }) {
			return Err(refused("a key must be mode 0400, or 0440 with this process's group"));
		}
	}
	if before.nlink() != 1 {
		return Err(refused("more than one link"));
	}
	let len = before.len();
	if len == 0 || len > limit {
		return Err(refused(&format!("not 1 to {limit} bytes")));
	}
	if std::fs::canonicalize(path)? != path {
		return Err(refused("not its own real path"));
	}
	let mut buffer = Wiped(vec![0; len as usize + 1]);
	let mut filled = 0;
	while filled < buffer.0.len() {
		match (&file).read(&mut buffer.0[filled..]) {
			Ok(0) => break,
			Ok(n) => filled += n,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
			Err(e) => return Err(e),
		}
	}
	let after = file.metadata()?;
	let named = std::fs::symlink_metadata(path)?;
	if filled as u64 != len || stamp(&before) != stamp(&after) || stamp(&before) != stamp(&named) {
		return Err(refused("changed while read"));
	}
	buffer.0.truncate(filled);
	Ok(std::mem::take(&mut buffer.0))
}

type Stamp = (u64, u64, u32, u32, u32, u64, u64, i64, i64, i64, i64);

fn stamp(m: &Metadata) -> Stamp {
	(m.dev(), m.ino(), m.uid(), m.gid(), m.mode(), m.nlink(), m.size(), m.mtime(), m.mtime_nsec(), m.ctime(), m.ctime_nsec())
}

/// This process's account name, for its identity folder.
fn account() -> io::Result<String> {
	// SAFETY: getpwuid_r writes only `entry`, `found` and `buffer`, all locals, `buffer` with the length passed;
	// pw_name then points into `buffer`, NUL-terminated, and is read before `buffer` is dropped.
	unsafe {
		let mut entry: libc::passwd = std::mem::zeroed();
		let mut found: *mut libc::passwd = std::ptr::null_mut();
		let mut buffer = vec![0 as libc::c_char; 16 * 1024];
		let status = libc::getpwuid_r(libc::geteuid(), &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut found);
		if status != 0 || found.is_null() || entry.pw_name.is_null() {
			return Err(invalid("LXD_IDENTITY_INVALID", "this account has no name"));
		}
		match std::ffi::CStr::from_ptr(entry.pw_name).to_str() {
			Ok(name) if valid_account(name) => Ok(name.to_string()),
			_ => Err(invalid("LXD_IDENTITY_INVALID", "this account's name is not a plain one")),
		}
	}
}

/// Bytes zeroed when dropped.
struct Wiped(Vec<u8>);

impl Drop for Wiped {
	fn drop(&mut self) {
		for byte in self.0.iter_mut() {
			// SAFETY: a write through a valid `&mut u8`; volatile, so the zeroing is not optimised away.
			unsafe { std::ptr::write_volatile(byte, 0) };
		}
	}
}

fn digest(bytes: &[u8]) -> [u8; 32] {
	Sha256::digest(bytes).into()
}

/// Loopback only, with an explicit port of 1 to 65535 and no leading zero; no path, query or user part.
fn origin(text: &str) -> Option<SocketAddr> {
	let rest = text.strip_prefix("https://")?;
	let (ip, port) = match rest.strip_prefix("127.0.0.1:") {
		Some(port) => (IpAddr::V4(Ipv4Addr::LOCALHOST), port),
		None => (IpAddr::V6(Ipv6Addr::LOCALHOST), rest.strip_prefix("[::1]:")?),
	};
	if port.is_empty() || port.len() > 5 || port.starts_with('0') || !port.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	Some(SocketAddr::new(ip, port.parse().ok()?))
}

fn sha256_hex(text: &str) -> Option<[u8; 32]> {
	if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
		return None;
	}
	let mut out = [0u8; 32];
	for (i, byte) in out.iter_mut().enumerate() {
		*byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok()?;
	}
	Some(out)
}

fn valid_account(name: &str) -> bool {
	let bytes = name.as_bytes();
	!bytes.is_empty()
		&& bytes.len() <= 32
		&& (bytes[0].is_ascii_lowercase() || bytes[0] == b'_')
		&& bytes.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn invalid(code: &str, detail: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, format!("{code}: {detail}"))
}

#[cfg(test)]
pub(crate) mod tests {
	use super::*;
	use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
	use rustls::server::{ServerConfig, ServerConnection};
	use rustls::DistinguishedName;
	use std::io::Write;
	use std::net::TcpListener;
	use std::os::unix::fs::PermissionsExt;
	use std::path::PathBuf;
	use std::sync::atomic::{AtomicU64, Ordering};
	use std::sync::mpsc;

	/// A folder of its own, removed when dropped.
	pub(crate) struct Scratch(pub(crate) PathBuf);

	impl Scratch {
		pub(crate) fn new(under: &Path) -> Scratch {
			static NEXT: AtomicU64 = AtomicU64::new(0);
			let dir = under.join(format!(
				"qorpera-folder-lxd-https-{}-{}",
				std::process::id(),
				NEXT.fetch_add(1, Ordering::Relaxed)
			));
			std::fs::create_dir(&dir).unwrap();
			set_mode(&dir, 0o755);
			Scratch(dir)
		}
	}

	impl Drop for Scratch {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	/// A throwaway P-256 certificate and key, made with openssl and never kept: (client.crt, client.key) bytes.
	pub(crate) fn throwaway(dir: &Path, name: &str) -> (Vec<u8>, Vec<u8>) {
		let (crt, key) = (dir.join(format!("{name}.crt")), dir.join(format!("{name}.key")));
		let made = std::process::Command::new("openssl")
			.args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1"])
			.arg("-subj")
			.arg(format!("/CN={name}"))
			.arg("-keyout")
			.arg(&key)
			.arg("-out")
			.arg(&crt)
			.stdin(std::process::Stdio::null())
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null())
			.status()
			.expect("openssl");
		assert!(made.success(), "openssl req");
		let pair = (std::fs::read(&crt).unwrap(), std::fs::read(&key).unwrap());
		std::fs::remove_file(&crt).unwrap();
		std::fs::remove_file(&key).unwrap();
		pair
	}

	pub(crate) fn hex(bytes: &[u8; 32]) -> String {
		bytes.iter().map(|b| format!("{b:02x}")).collect()
	}

	pub(crate) fn listener_json(origin: &str, pin: &[u8; 32]) -> String {
		format!(r#"{{"schema":"qorpera.lxd-listener/v1","origin":"{origin}","certificateSha256":"{}"}}"#, hex(pin))
	}

	fn set_mode(path: &Path, mode: u32) {
		std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
	}

	/// "ok", or the error's code.
	fn code(result: io::Result<Https>) -> String {
		match result {
			Ok(_) => "ok".into(),
			Err(e) => e.to_string().split(':').next().unwrap_or_default().to_string(),
		}
	}

	/// What a stand-in listener saw of one connection.
	pub(crate) struct Seen {
		pub(crate) request: Vec<u8>,
		pub(crate) alpn: Option<Vec<u8>>,
		pub(crate) client: Option<[u8; 32]>,
		pub(crate) version: Option<ProtocolVersion>,
		pub(crate) sni: Option<String>,
	}

	/// Takes any client certificate, as LXD's listener does before it looks the caller up.
	#[derive(Debug)]
	struct AnyClient(WebPkiSupportedAlgorithms);

	impl ClientCertVerifier for AnyClient {
		fn root_hint_subjects(&self) -> &[DistinguishedName] {
			&[]
		}

		fn verify_client_cert(
			&self,
			_end_entity: &CertificateDer<'_>,
			_intermediates: &[CertificateDer<'_>],
			_now: UnixTime,
		) -> Result<ClientCertVerified, rustls::Error> {
			Ok(ClientCertVerified::assertion())
		}

		fn verify_tls12_signature(
			&self,
			message: &[u8],
			cert: &CertificateDer<'_>,
			dss: &DigitallySignedStruct,
		) -> Result<HandshakeSignatureValid, rustls::Error> {
			verify_tls12_signature(message, cert, dss, &self.0)
		}

		fn verify_tls13_signature(
			&self,
			message: &[u8],
			cert: &CertificateDer<'_>,
			dss: &DigitallySignedStruct,
		) -> Result<HandshakeSignatureValid, rustls::Error> {
			verify_tls13_signature(message, cert, dss, &self.0)
		}

		fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
			self.0.supported_schemes()
		}
	}

	/// A stand-in for LXD's listener (TLS 1.3, offering only h2, asking for a client certificate) on 127.0.0.1,
	/// answering each request with `reply(target)` and then closing. The access returned pins `pin`, by default the
	/// stand-in's own certificate, with a fresh client identity.
	pub(crate) fn stand_in(
		dir: &Path,
		reply: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static,
		pin: Option<[u8; 32]>,
	) -> (Https, mpsc::Receiver<Seen>) {
		let provider = Arc::new(rustls::crypto::ring::default_provider());
		let (server_crt, server_key) = throwaway(dir, "listener");
		let (client_crt, client_key) = throwaway(dir, "client");
		let server = CertificateDer::from_pem_slice(&server_crt).unwrap();
		let mut config = ServerConfig::builder_with_provider(provider.clone())
			.with_protocol_versions(&[&rustls::version::TLS13])
			.unwrap()
			.with_client_cert_verifier(Arc::new(AnyClient(provider.signature_verification_algorithms)))
			.with_single_cert(vec![server.clone()], PrivateKeyDer::from_pem_slice(&server_key).unwrap())
			.unwrap();
		config.alpn_protocols = vec![b"h2".to_vec()];
		let config = Arc::new(config);
		let listener = TcpListener::bind("127.0.0.1:0").unwrap();
		let origin = format!("https://{}", listener.local_addr().unwrap());
		let (seen, heard) = mpsc::channel();
		let reply = Arc::new(reply);
		std::thread::spawn(move || {
			for conn in listener.incoming() {
				let Ok(tcp) = conn else { return };
				let (config, reply, seen) = (config.clone(), reply.clone(), seen.clone());
				std::thread::spawn(move || {
					let _ = seen.send(serve(config, tcp, &*reply));
				});
			}
		});
		let pin = pin.unwrap_or_else(|| digest(&server));
		let https = Https::from_files(listener_json(&origin, &pin).as_bytes(), &client_crt, client_key).unwrap();
		(https, heard)
	}

	fn serve(config: Arc<ServerConfig>, mut tcp: TcpStream, reply: &dyn Fn(&str) -> Vec<u8>) -> Seen {
		tcp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
		let mut conn = ServerConnection::new(config).unwrap();
		let mut request = Vec::new();
		let ended = |r: &[u8]| r.windows(4).any(|w| w == b"\r\n\r\n");
		{
			let mut tls = rustls::Stream::new(&mut conn, &mut tcp);
			let mut chunk = [0u8; 4096];
			while !ended(&request) {
				match tls.read(&mut chunk) {
					Ok(0) | Err(_) => break,
					Ok(n) => request.extend_from_slice(&chunk[..n]),
				}
			}
			if ended(&request) {
				let target = String::from_utf8_lossy(&request).split(' ').nth(1).unwrap_or("").to_string();
				let _ = tls.write_all(&reply(&target));
				let _ = tls.flush();
			}
		}
		conn.send_close_notify();
		while conn.wants_write() {
			if conn.write_tls(&mut tcp).is_err() {
				break;
			}
		}
		Seen {
			request,
			alpn: conn.alpn_protocol().map(<[u8]>::to_vec),
			client: conn.peer_certificates().and_then(|c| c.first()).map(|c| digest(c)),
			version: conn.protocol_version(),
			sni: conn.server_name().map(str::to_string),
		}
	}

	#[test]
	fn the_listener_record_and_the_identity_are_checked() {
		let scratch = Scratch::new(&std::env::temp_dir());
		let (crt, key) = throwaway(&scratch.0, "client");
		let (other_crt, other_key) = throwaway(&scratch.0, "other");
		// Upper-case hex of this pin differs from it.
		let pin = [0xab; 32];
		let with = |listener: &str, crt: &[u8], key: &[u8]| code(Https::from_files(listener.as_bytes(), crt, key.to_vec()));

		let ok = with(&listener_json("https://127.0.0.1:8443", &pin), &crt, &key);
		assert_eq!(ok, "ok");
		let access = Https::from_files(listener_json("https://[::1]:65535", &pin).as_bytes(), &crt, key.clone()).unwrap();
		assert_eq!(access.host(), "[::1]:65535");
		assert_eq!(access.identity(), digest(&CertificateDer::from_pem_slice(&crt).unwrap()));
		for origin in [
			"https://127.0.0.1",
			"https://127.0.0.1:0",
			"https://127.0.0.1:08443",
			"https://127.0.0.1:65536",
			"http://127.0.0.1:8443",
			"https://localhost:8443",
			"https://127.0.0.1:8443/",
			"https://user@127.0.0.1:8443",
			"https://192.0.2.1:8443",
			"https://[::1]",
			" https://127.0.0.1:8443",
			"https://127.0.0.1:+8443",
		] {
			assert_eq!(with(&listener_json(origin, &pin), &crt, &key), "LXD_LISTENER_INVALID", "{origin}");
		}
		let good = listener_json("https://127.0.0.1:8443", &pin);
		for record in [
			good.replace("lxd-listener/v1", "lxd-listener/v2"),
			good.replace(&hex(&pin), &hex(&pin).to_uppercase()),
			good.replace(&hex(&pin), &hex(&pin)[1..]),
			r#"{"schema":"qorpera.lxd-listener/v1","origin":"https://127.0.0.1:8443"}"#.to_string(),
			good.replace(r#""origin""#, r#""extra":1,"origin""#),
			format!(r#"["qorpera.lxd-listener/v1","https://127.0.0.1:8443","{}"]"#, hex(&pin)),
			"not json".to_string(),
		] {
			assert_eq!(with(&record, &crt, &key), "LXD_LISTENER_INVALID", "{record}");
		}
		let two = [crt.clone(), other_crt.clone()].concat();
		for (crt, key) in [
			(&two[..], &key[..]),
			(&crt[..], &other_key[..]),
			(&crt[..], &b"not a key"[..]),
			(&b""[..], &key[..]),
			(&key[..], &key[..]),
		] {
			assert_eq!(with(&good, crt, key), "LXD_IDENTITY_INVALID");
		}
		let own = digest(&CertificateDer::from_pem_slice(&crt).unwrap());
		assert_eq!(with(&listener_json("https://127.0.0.1:8443", &own), &crt, &key), "LXD_IDENTITY_INVALID");
	}

	#[test]
	fn the_pinned_listener_gets_the_request_and_our_certificate_over_tls_1_3_without_alpn_or_sni() {
		let scratch = Scratch::new(&std::env::temp_dir());
		let (https, heard) = stand_in(&scratch.0, |_| b"HTTP/1.0 200 OK\r\n\r\n{\"type\":\"sync\"}".to_vec(), None);
		let mut connection = https.connect().unwrap();
		connection.write_all(b"GET /1.0 HTTP/1.0\r\nHost: x\r\n\r\n").unwrap();
		let mut answer = Vec::new();
		connection.read_to_end(&mut answer).unwrap();
		assert_eq!(answer, b"HTTP/1.0 200 OK\r\n\r\n{\"type\":\"sync\"}");
		let seen = heard.recv_timeout(Duration::from_secs(10)).unwrap();
		assert_eq!(seen.request, b"GET /1.0 HTTP/1.0\r\nHost: x\r\n\r\n");
		assert_eq!(seen.alpn, None, "LXD would agree only to h2");
		assert_eq!(seen.client, Some(https.identity()));
		assert_eq!(seen.version, Some(ProtocolVersion::TLSv1_3));
		assert_eq!(seen.sni, None);
	}

	#[test]
	fn a_listener_that_is_not_the_pinned_one_gets_no_request_and_not_our_certificate() {
		let scratch = Scratch::new(&std::env::temp_dir());
		let (https, heard) = stand_in(&scratch.0, |_| b"HTTP/1.0 200 OK\r\n\r\n".to_vec(), Some([7; 32]));
		let refused = https.connect().err().expect("an unpinned listener is refused").to_string();
		assert!(refused.starts_with("LXD_HTTPS_SERVER_UNPINNED"), "{refused}");
		let seen = heard.recv_timeout(Duration::from_secs(10)).unwrap();
		assert!(seen.request.is_empty());
		assert_eq!(seen.client, None);
	}

	#[test]
	fn a_listener_that_drips_its_handshake_runs_into_the_whole_handshake_deadline() {
		let scratch = Scratch::new(&std::env::temp_dir());
		let (crt, key) = throwaway(&scratch.0, "client");
		let listener = TcpListener::bind("127.0.0.1:0").unwrap();
		let origin = format!("https://{}", listener.local_addr().unwrap());
		std::thread::spawn(move || {
			let Ok((mut tcp, _)) = listener.accept() else { return };
			// A handshake record of 16 KiB, sent one byte every 400 ms: each read gets something, the whole never ends.
			if tcp.write_all(&[0x16, 0x03, 0x03, 0x40, 0x00]).is_err() {
				return;
			}
			for _ in 0..40 {
				std::thread::sleep(Duration::from_millis(400));
				if tcp.write_all(&[0]).is_err() {
					return;
				}
			}
		});
		let https = Https::from_files(listener_json(&origin, &[7; 32]).as_bytes(), &crt, key).unwrap();
		let started = Instant::now();
		let error = https.connect().err().expect("a dripping listener times out");
		let took = started.elapsed();
		assert_eq!(error.kind(), io::ErrorKind::TimedOut);
		assert_eq!(error.to_string(), "LXD_HTTPS_HANDSHAKE_TIMEOUT");
		assert!(took >= HANDSHAKE && took < HANDSHAKE + Duration::from_millis(1500), "{took:?}");
	}

	/// A scratch folder under /root, when this test runs as root and /root is root's alone: the protected reads take
	/// root's files only.
	fn root_scratch() -> Option<Scratch> {
		// SAFETY: geteuid has no preconditions.
		if unsafe { libc::geteuid() } != 0 {
			return None;
		}
		let root = std::fs::symlink_metadata("/root").ok()?;
		(root.is_dir() && root.uid() == 0 && root.mode() & 0o077 == 0).then(|| Scratch::new(Path::new("/root")))
	}

	#[test]
	fn the_files_are_read_only_as_root_left_them() {
		let Some(scratch) = root_scratch() else {
			eprintln!("skipped: needs root and a /root only root may open");
			return;
		};
		let root = &scratch.0;
		let account = account().unwrap();
		let folder = root.join(&account);
		std::fs::create_dir(&folder).unwrap();
		set_mode(&folder, 0o750);
		let (crt, key) = throwaway(root, "client");
		let listener = root.join("listener.json");
		let record = listener_json("https://127.0.0.1:8443", &[0xab; 32]);
		std::fs::write(&listener, &record).unwrap();
		set_mode(&listener, 0o644);
		std::fs::write(folder.join("client.crt"), &crt).unwrap();
		set_mode(&folder.join("client.crt"), 0o644);
		let key_file = folder.join("client.key");
		std::fs::write(&key_file, &key).unwrap();
		set_mode(&key_file, 0o400);

		let access = Https::read(root).unwrap();
		assert_eq!(access.identity(), digest(&CertificateDer::from_pem_slice(&crt).unwrap()));
		assert_eq!(access.host(), "127.0.0.1:8443");
		// The key: root's alone, or root's and this process's group's, read-only.
		set_mode(&key_file, 0o440);
		assert_eq!(code(Https::read(root)), "ok");
		for mode in [0o444, 0o640, 0o600] {
			set_mode(&key_file, mode);
			assert_eq!(code(Https::read(root)), "LXD_IDENTITY_INVALID", "{mode:o}");
		}
		set_mode(&key_file, 0o400);
		// The listener record: not writable by others, not a link, no second name.
		set_mode(&listener, 0o666);
		assert_eq!(code(Https::read(root)), "LXD_LISTENER_INVALID");
		set_mode(&listener, 0o644);
		let real = root.join("listener.real");
		std::fs::rename(&listener, &real).unwrap();
		std::os::unix::fs::symlink(&real, &listener).unwrap();
		assert_eq!(code(Https::read(root)), "LXD_LISTENER_INVALID");
		std::fs::remove_file(&listener).unwrap();
		std::fs::rename(&real, &listener).unwrap();
		let second = root.join("listener.second");
		std::fs::hard_link(&listener, &second).unwrap();
		assert_eq!(code(Https::read(root)), "LXD_LISTENER_INVALID");
		std::fs::remove_file(&second).unwrap();
		// A folder above that others may change.
		set_mode(root, 0o777);
		assert_eq!(code(Https::read(root)), "LXD_LISTENER_INVALID");
		set_mode(root, 0o755);
		// Size: 1 to 4096 bytes.
		std::fs::write(&listener, vec![b' '; MAX_LISTENER as usize + 1]).unwrap();
		assert_eq!(code(Https::read(root)), "LXD_LISTENER_INVALID");
		std::fs::write(&listener, b"").unwrap();
		assert_eq!(code(Https::read(root)), "LXD_LISTENER_INVALID");
		std::fs::write(&listener, &record).unwrap();
		assert_eq!(code(Https::read(root)), "ok");
	}

	#[test]
	fn a_file_others_may_replace_or_a_relative_path_is_refused() {
		let scratch = Scratch::new(&std::env::temp_dir());
		let file = scratch.0.join("listener.json");
		std::fs::write(&file, b"{}").unwrap();
		set_mode(&scratch.0, 0o1777);
		assert!(protected(&file, MAX_LISTENER, false).is_err());
		set_mode(&scratch.0, 0o755);
		assert!(protected(Path::new("listener.json"), MAX_LISTENER, false).is_err());
	}
}
