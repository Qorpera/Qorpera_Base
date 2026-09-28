import { Resolver } from "node:dns/promises";
import { chmod, lstat, realpath } from "node:fs/promises";
import { createConnection, createServer, isIPv4, type Socket } from "node:net";
import { join } from "node:path";
import { companyComputerBrowserEgressHost } from "./cloud-company-computer-browser-egress.ts";
import { nativeEgressPublicAddress } from "./cloud-native-egress.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

export interface CompanyComputerShellEgressTransport {
	resolve(host: string, signal: AbortSignal): Promise<string[]>;
	connect(address: string, port: number): Socket;
}

/** Most header bytes a client may send before the relay knows where to go. */
const HEADER_LIMIT = 65536;
/** Open tunnels per relay: two descriptors each in the service. A storage bound, not a work limit. */
const PEER_LIMIT = 256;

/**
 * One proxied destination: a canonical DNS name or a public IPv4 literal, and
 * a port. Local names, private, shared, loopback, link-local (metadata) and
 * multicast addresses are refused here or after the one resolution.
 */
export function companyComputerShellEgressTarget(
	authority: string,
	defaultPort?: number,
): { host: string; port: number } {
	const match = /^([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/.exec(authority);
	if (!match || (match[2] === undefined && defaultPort === undefined))
		throw new Error("OFFICE_SHELL_DESTINATION_DENIED");
	const port = match[2] === undefined ? defaultPort! : Number(match[2]);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("OFFICE_SHELL_DESTINATION_DENIED");
	const host = match[1].toLowerCase();
	if (isIPv4(host)) {
		if (!nativeEgressPublicAddress(host)) throw new Error("OFFICE_SHELL_ADDRESS_DENIED");
		return { host, port };
	}
	try {
		return { host: companyComputerBrowserEgressHost(host), port };
	} catch {
		throw new Error("OFFICE_SHELL_DESTINATION_DENIED");
	}
}

async function resolveShellHost(host: string, signal: AbortSignal): Promise<string[]> {
	if (isIPv4(host)) return [host];
	const resolver = new Resolver({ timeout: 2000, tries: 2 });
	const cancel = (): void => resolver.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		return await resolver.resolve4(host);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

function refusal(status: "403 Forbidden" | "502 Bad Gateway", reason: string): string {
	const body = `Qorpera Company Computer: ${reason}\n`;
	return `HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

/**
 * Broker-private Unix relay for one shell or desktop namespace, whose network
 * has no device of its own. It speaks the HTTP proxy protocol: CONNECT to any
 * port, and plain `http://` requests forwarded one per connection. Every
 * destination is resolved once here and must be public IPv4; the checked
 * address is dialled, never resolved again. So the NAS, the node, the office
 * network, cloud metadata and the service's own listeners stay unreachable.
 * No TLS interception, credential forwarding or request logs. There is no
 * byte or time budget: a tunnel lives as long as both ends keep it.
 * `assertActive` is local (the owning screen is still up); the screen's own
 * pulse carries authority. Transport injection is for local proof only.
 */
export async function startCompanyComputerShellEgress(options: {
	root: string;
	assertActive(): void;
	signal: AbortSignal;
	transport?: CompanyComputerShellEgressTransport;
}): Promise<{ path: string; close(): Promise<void> }> {
	const info = await lstat(options.root);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o077) !== 0 ||
		(await realpath(options.root)) !== options.root
	)
		throw new Error("UNSAFE_OFFICE_SHELL_EGRESS_ROOT");
	const path = join(options.root, "egress.sock");
	if (Buffer.byteLength(path) > 103) throw new Error("OFFICE_SHELL_EGRESS_PATH_TOO_LONG");
	const transport = options.transport ?? {
		resolve: resolveShellHost,
		connect: (address: string, port: number) => createConnection({ host: address, port, family: 4 }),
	};
	const stop = new AbortController();
	const signal = AbortSignal.any([options.signal, stop.signal]);
	const sockets = new Set<Socket>();
	const pending = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;
	const track = (socket: Socket): void => {
		sockets.add(socket);
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		pending.add(closed);
		void closed.finally(() => {
			sockets.delete(socket);
			pending.delete(closed);
		});
	};
	const accept = (peer: Socket): void => {
		peer.on("error", () => undefined);
		if (signal.aborted || sockets.size >= PEER_LIMIT * 2) {
			peer.destroy();
			return;
		}
		try {
			options.assertActive();
		} catch {
			peer.destroy();
			return;
		}
		track(peer);
		let upstream: Socket | undefined;
		const end = (): void => {
			peer.destroy();
			upstream?.destroy();
		};
		const refuse = (status: "403 Forbidden" | "502 Bad Gateway", reason: string): void => {
			if (peer.destroyed) return;
			peer.end(refusal(status, reason));
			setTimeout(end, 1000).unref();
		};
		signal.addEventListener("abort", end, { once: true });
		peer.once("close", () => {
			signal.removeEventListener("abort", end);
			end();
		});
		// Only the request head is timed; an open tunnel may idle as long as it likes.
		const headTimer = setTimeout(end, 10000);
		let buffer = Buffer.alloc(0);
		const receive = (bytes: Buffer): void => {
			buffer = Buffer.concat([buffer, bytes]);
			const separator = buffer.indexOf("\r\n\r\n");
			if (separator < 0) {
				if (buffer.length > HEADER_LIMIT) end();
				return;
			}
			peer.removeListener("data", receive);
			peer.pause();
			clearTimeout(headTimer);
			const lines = buffer.subarray(0, separator).toString("latin1").split("\r\n");
			const rest = buffer.subarray(separator + 4);
			buffer = Buffer.alloc(0);
			let target: { host: string; port: number };
			let head: Buffer | undefined;
			try {
				const request = /^([A-Z]{1,16}) (\S{1,16384}) HTTP\/1\.([01])$/.exec(lines.shift() ?? "");
				if (!request) throw new Error("OFFICE_SHELL_PROXY_REQUEST_DENIED");
				const headers: string[] = [];
				for (const line of lines) {
					if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e\x80-\xff]*$/.test(line))
						throw new Error("OFFICE_SHELL_PROXY_REQUEST_DENIED");
					headers.push(line);
				}
				if (request[1] === "CONNECT") target = companyComputerShellEgressTarget(request[2]);
				else {
					// Plain HTTP through the proxy arrives in absolute form. It goes to the
					// named server in origin form, as the only request on this connection,
					// so a client reusing the connection for another host cannot reach it.
					const url = /^http:\/\/([^/?#@]+)([/?][^#]*)?$/i.exec(request[2]);
					if (!url) throw new Error("OFFICE_SHELL_PROXY_REQUEST_DENIED");
					target = companyComputerShellEgressTarget(url[1], 80);
					const kept = headers.filter(
						(line) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(line),
					);
					if (!kept.some((line) => /^host:/i.test(line))) kept.unshift(`Host: ${url[1]}`);
					const path = url[2] === undefined ? "/" : url[2].startsWith("?") ? `/${url[2]}` : url[2];
					head = Buffer.from(
						[`${request[1]} ${path} HTTP/1.${request[3]}`, ...kept, "Connection: close", "", ""].join("\r\n"),
						"latin1",
					);
				}
			} catch (error) {
				refuse(
					"403 Forbidden",
					error instanceof Error && error.message === "OFFICE_SHELL_ADDRESS_DENIED"
						? "local and private network addresses are not reachable from this computer."
						: "this request cannot go through the computer's internet proxy.",
				);
				return;
			}
			const attempt = new AbortController();
			const checked = AbortSignal.any([signal, attempt.signal]);
			const connectTimer = setTimeout(() => attempt.abort(), 15000);
			peer.once("close", () => {
				clearTimeout(connectTimer);
				attempt.abort();
			});
			void (async () => {
				let addresses: string[];
				try {
					options.assertActive();
					addresses = await transport.resolve(target.host, checked);
					checked.throwIfAborted();
				} catch {
					refuse("502 Bad Gateway", `could not find ${target.host}.`);
					return;
				}
				if (!addresses.length || addresses.length > 64 || addresses.some((a) => !nativeEgressPublicAddress(a))) {
					refuse("403 Forbidden", `${target.host} points at a local or private address, which is not reachable.`);
					return;
				}
				try {
					options.assertActive();
				} catch {
					end();
					return;
				}
				const current = transport.connect(addresses[0], target.port);
				upstream = current;
				track(current);
				let connected = false;
				const unreachable = (): void => {
					current.destroy();
					refuse("502 Bad Gateway", `could not connect to ${target.host}:${target.port}.`);
				};
				current.on("error", () => {
					if (connected) end();
					else unreachable();
				});
				current.once("close", () => {
					// The answer has been piped and ended towards the client; give it
					// time to read before the connection is dropped.
					if (connected) setTimeout(end, 30000).unref();
				});
				checked.addEventListener("abort", unreachable, { once: true });
				current.once("connect", () => {
					checked.removeEventListener("abort", unreachable);
					clearTimeout(connectTimer);
					if (signal.aborted) {
						end();
						return;
					}
					connected = true;
					current.setKeepAlive(true, 60000);
					if (head) current.write(head);
					else peer.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					if (rest.length) current.write(rest);
					peer.pipe(current);
					current.pipe(peer);
					peer.resume();
				});
			})();
		};
		peer.on("data", receive);
		peer.resume();
	};
	const server = createServer({ pauseOnConnect: true }, accept);
	server.maxConnections = PEER_LIMIT;
	const abort = (): void => {
		for (const socket of sockets) socket.destroy();
		server.close();
	};
	signal.addEventListener("abort", abort, { once: true });
	const close = (): Promise<void> => {
		closing ??= cloudToolRequest(
			async () => {
				stop.abort();
				signal.removeEventListener("abort", abort);
				await new Promise<void>((resolve) => server.close(() => resolve()));
				for (const socket of sockets) socket.destroy();
				await Promise.allSettled([...pending]);
				if (sockets.size) throw new Error("OFFICE_SHELL_EGRESS_DRAIN_UNCONFIRMED");
			},
			new AbortController().signal,
			5000,
		);
		return closing;
	};
	try {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		signal.throwIfAborted();
		return { path, close };
	} catch (error) {
		await close();
		throw error;
	}
}
