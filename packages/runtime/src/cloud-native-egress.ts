import { Resolver } from "node:dns/promises";
import { chmod, lstat } from "node:fs/promises";
import { createConnection, createServer, isIPv4, type Socket } from "node:net";
import { join } from "node:path";

// Native subscription traffic only. Company tools, storage and control-plane
// requests execute in the trusted host, never through this relay.
export const NATIVE_CODEX_EGRESS_HOSTS = Object.freeze(["chatgpt.com", "auth.openai.com"]);
/** A run on a member's ChatGPT plan (Sign in with ChatGPT) reaches OpenAI's API alone: the vault, not the
 * run, renews the plan's tokens, and the run never uses the Codex login's ChatGPT backend. */
export const NATIVE_CHATGPT_PLAN_EGRESS_HOSTS = Object.freeze(["api.openai.com"]);
const MAX_HELLO_BYTES = 65_536;
// Bounds per connection only: 8 at once, 5 s to connect and 30 s idle. A run's relay counts no bytes and no connections
// over its life (no caps on runs, 5 Oct 2026; it stopped a run after 64 MiB or 128 connections until then).
const MAX_CONNECTIONS = 8;

export function nativeEgressPublicAddress(address: string): boolean {
	if (!isIPv4(address)) return false;
	const [a, b, c] = address.split(".").map(Number);
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
		(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
		(a === 203 && b === 0 && c === 113)
	);
}

/** Bounded TLS ClientHello inspection, not TLS termination. See RFC 8446 §4.1.2
 * and RFC 6066 §3. No bytes reach the network before an unambiguous visible SNI
 * matches CONNECT. ECH, missing/duplicate SNI and malformed records fail closed.
 */
export function nativeClientHelloServerName(wire: Buffer): string | undefined {
	if (wire.length > MAX_HELLO_BYTES) throw new Error("Native egress ClientHello limit");
	const fragments: Buffer[] = [];
	let offset = 0;
	let length = 0;
	while (offset < wire.length) {
		if (wire.length - offset < 5) return undefined;
		const recordLength = wire.readUInt16BE(offset + 3);
		if (
			wire[offset] !== 22 ||
			wire[offset + 1] !== 3 ||
			wire[offset + 2] < 1 ||
			wire[offset + 2] > 3 ||
			recordLength < 1 ||
			recordLength > 16_384
		)
			throw new Error("Invalid native TLS record");
		if (wire.length - offset - 5 < recordLength) return undefined;
		fragments.push(wire.subarray(offset + 5, offset + 5 + recordLength));
		length += recordLength;
		offset += 5 + recordLength;
		const hello = Buffer.concat(fragments, length);
		if (hello.length < 4) continue;
		const expected = hello.readUIntBE(1, 3) + 4;
		if (hello[0] !== 1 || expected > MAX_HELLO_BYTES - 5 || expected < 45)
			throw new Error("Invalid native ClientHello");
		if (hello.length < expected) continue;
		let cursor = 4;
		const take = (count: number): Buffer => {
			if (cursor + count > expected) throw new Error("Truncated native ClientHello");
			const result = hello.subarray(cursor, cursor + count);
			cursor += count;
			return result;
		};
		if (take(2).readUInt16BE() !== 0x0303) throw new Error("Unsupported native TLS version");
		take(32);
		const sessionBytes = take(1)[0];
		if (sessionBytes > 32) throw new Error("Invalid native TLS session");
		take(sessionBytes);
		const cipherBytes = take(2).readUInt16BE();
		if (cipherBytes < 2 || cipherBytes % 2 !== 0) throw new Error("Invalid native TLS ciphers");
		take(cipherBytes);
		if (take(1)[0] !== 1 || take(1)[0] !== 0) throw new Error("Invalid native TLS compression");
		const extensionBytes = take(2).readUInt16BE();
		if (cursor + extensionBytes !== expected) throw new Error("Invalid native TLS extensions");
		const extensions = new Set<number>();
		let name: string | undefined;
		while (cursor < expected) {
			const type = take(2).readUInt16BE();
			const bytes = take(take(2).readUInt16BE());
			if (extensions.has(type) || type === 0xfe0d) throw new Error("Ambiguous native TLS extensions");
			extensions.add(type);
			if (type !== 0) continue;
			if (
				bytes.length < 6 ||
				bytes.readUInt16BE() !== bytes.length - 2 ||
				bytes[2] !== 0 ||
				bytes.readUInt16BE(3) !== bytes.length - 5
			)
				throw new Error("Invalid native TLS server name");
			name = bytes.subarray(5).toString("ascii");
			if (!/^[a-z0-9.-]{1,253}$/.test(name) || !bytes.subarray(5).equals(Buffer.from(name)))
				throw new Error("Invalid native TLS server name");
		}
		if (!name) throw new Error("Native TLS server name required");
		return name;
	}
	return undefined;
}

/** One IPv4 lookup, cancelled with `signal`; the secret broker's relay (5j-6b) resolves the same way. */
export async function resolveNativeHost(host: string, signal: AbortSignal): Promise<string[]> {
	const resolver = new Resolver({ timeout: 1000, tries: 1 });
	const cancel = (): void => resolver.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		return await resolver.resolve4(host);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

export interface NativeEgressTransport {
	resolve(host: string, signal: AbortSignal): Promise<string[]>;
	connect(address: string): Socket;
}

/** Private per-execution Unix capability. No HTTP endpoint, bearer token,
 * credential forwarding/inspection, TLS interception, redirects or DNS from
 * the model namespace. Test transport is dependency injection, not runtime config.
 */
export async function startNativeCodexEgress(options: {
	root: string;
	signal: AbortSignal;
	transport?: NativeEgressTransport;
	/** The hosts this run may reach; the Codex login's hosts unless the run is on a ChatGPT plan. */
	hosts?: readonly string[];
}): Promise<{ path: string; close(): Promise<void> }> {
	const hosts = options.hosts ?? NATIVE_CODEX_EGRESS_HOSTS;
	if (hosts !== NATIVE_CODEX_EGRESS_HOSTS && hosts !== NATIVE_CHATGPT_PLAN_EGRESS_HOSTS)
		throw new Error("Unsupported native egress hosts");
	const metadata = await lstat(options.root);
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		metadata.uid !== process.getuid?.() ||
		(metadata.mode & 0o077) !== 0
	)
		throw new Error("Unsafe native egress root");
	const path = join(options.root, "egress.sock");
	if (Buffer.byteLength(path) > 100) throw new Error("Native egress socket path too long");
	const transport = options.transport ?? {
		resolve: resolveNativeHost,
		connect: (address: string) => createConnection({ host: address, port: 443, family: 4 }),
	};
	const peers = new Set<Socket>();
	const upstreams = new Set<Socket>();
	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, controller.signal]);
	const server = createServer((peer) => {
		if (signal.aborted || peers.size >= MAX_CONNECTIONS) {
			peer.destroy();
			return;
		}
		peers.add(peer);
		let upstream: Socket | undefined;
		let buffered = Buffer.alloc(0);
		let host: string | undefined;
		let connecting = false;
		let fragments = 0;
		const attempt = new AbortController();
		const deadline = setTimeout(() => attempt.abort(), 5000);
		const attemptSignal = AbortSignal.any([signal, attempt.signal]);
		const close = (): void => {
			peer.destroy();
			upstream?.destroy();
		};
		attemptSignal.addEventListener("abort", close, { once: true });
		peer.on("error", close);
		peer.once("close", () => {
			clearTimeout(deadline);
			attempt.abort();
			attemptSignal.removeEventListener("abort", close);
			peers.delete(peer);
			upstream?.destroy();
		});
		peer.setTimeout(30_000, close);
		const accept = async (): Promise<void> => {
			if (!host) {
				const end = buffered.indexOf("\r\n\r\n");
				if (end < 0) {
					if (buffered.length > 4096) close();
					return;
				}
				if (end > 4096) throw new Error("Native proxy header limit");
				const header = buffered.subarray(0, end).toString("latin1");
				const lines = header.split("\r\n");
				const target = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(lines.shift() ?? "")?.[1];
				if (!target || !hosts.includes(target)) throw new Error("Native egress target denied");
				const names = new Set<string>();
				for (const line of lines) {
					const entry = /^([A-Za-z-]+):[ \t]*([\x20-\x7e]*)$/.exec(line);
					const name = entry?.[1].toLowerCase();
					if (
						!entry ||
						!name ||
						names.has(name) ||
						!["host", "user-agent", "proxy-connection", "connection"].includes(name)
					)
						throw new Error("Invalid native proxy headers");
					names.add(name);
					if (name === "host" && entry[2] !== `${target}:443`) throw new Error("Native proxy host mismatch");
				}
				host = target;
				buffered = buffered.subarray(end + 4);
				peer.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			}
			const name = nativeClientHelloServerName(buffered);
			if (name === undefined) return;
			if (name !== host) throw new Error("Native TLS destination mismatch");
			connecting = true;
			peer.pause();
			peer.removeListener("data", receive);
			const addresses = await transport.resolve(host, attemptSignal);
			attemptSignal.throwIfAborted();
			if (
				!addresses.length ||
				addresses.length > 16 ||
				addresses.some((address) => !nativeEgressPublicAddress(address))
			)
				throw new Error("Native egress address denied");
			// Resolve once and dial the checked literal, never resolve again at connect.
			upstream = transport.connect(addresses[0]);
			upstreams.add(upstream);
			upstream.once("close", () => {
				if (upstream) upstreams.delete(upstream);
				close();
			});
			upstream.on("error", close);
			upstream.setTimeout(30_000, close);
			upstream.once("connect", () => {
				if (attemptSignal.aborted) {
					close();
					return;
				}
				clearTimeout(deadline);
				upstream?.write(buffered);
				buffered = Buffer.alloc(0);
				if (upstream) {
					peer.pipe(upstream);
					upstream.pipe(peer);
				}
				peer.resume();
			});
		};
		const receive = (bytes: Buffer): void => {
			if (connecting || signal.aborted) return;
			if (++fragments > 128) {
				close();
				return;
			}
			if (buffered.length + bytes.length > MAX_HELLO_BYTES + 4096) {
				close();
				return;
			}
			buffered = Buffer.concat([buffered, bytes]);
			void accept().catch(close);
		};
		peer.on("data", receive);
	});
	const abort = (): void => {
		for (const peer of peers) peer.destroy();
		for (const upstream of upstreams) upstream.destroy();
		server.close();
	};
	server.on("error", () => controller.abort());
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const failed = (): void => {
				signal.removeEventListener("abort", failed);
				reject(new Error("Native egress unavailable"));
			};
			signal.addEventListener("abort", failed, { once: true });
			server.listen(path, () => {
				signal.removeEventListener("abort", failed);
				resolve();
			});
		});
		await chmod(path, 0o600);
		signal.throwIfAborted();
		let closing: Promise<void> | undefined;
		return {
			path,
			close() {
				closing ??= new Promise<void>((resolve) => {
					controller.abort();
					signal.removeEventListener("abort", abort);
					server.close(() => resolve());
				});
				return closing;
			},
		};
	} catch (error) {
		controller.abort();
		signal.removeEventListener("abort", abort);
		throw error;
	}
}
