import { Resolver } from "node:dns/promises";
import { chmod, lstat, realpath } from "node:fs/promises";
import { createConnection, createServer, isIP, type Socket } from "node:net";
import { join } from "node:path";
import { nativeEgressPublicAddress } from "./cloud-native-egress.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

export interface CompanyComputerBrowserEgressTransport {
	resolve(host: string, signal: AbortSignal): Promise<string[]>;
	connect(address: string): Socket;
}

/** A browser may reach public HTTPS origins, never host/LAN/metadata services.
 * Only canonical DNS names are accepted; literals and alternate numeric address
 * forms cannot bypass the one-resolution, checked-address connection policy. */
export function companyComputerBrowserEgressHost(value: string): string {
	if (value.length > 253 || value !== value.toLowerCase() || isIP(value) || !value.includes("."))
		throw new Error("OFFICE_BROWSER_DESTINATION_DENIED");
	const labels = value.split(".");
	if (
		labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
		!/[a-z]/.test(labels.at(-1)!) ||
		labels.at(-1) === "localhost" ||
		labels.at(-1) === "local"
	)
		throw new Error("OFFICE_BROWSER_DESTINATION_DENIED");
	return value;
}

async function resolveBrowserHost(host: string, signal: AbortSignal): Promise<string[]> {
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

/** Broker-private Unix CONNECT relay, mounted only into the granted browser's
 * network namespace. No TLS interception, credential forwarding, request URL/body
 * logs, host networking, redirects or client-side DNS. Browser TLS remains end
 * to end. The guest's privacy/drain owner must close this relay before ack.
 * Transport injection is for local proof, never member/model configuration. */
export async function startCompanyComputerBrowserEgress(options: {
	root: string;
	assertActive(signal: AbortSignal): Promise<void>;
	signal: AbortSignal;
	onFailure(): void;
	transport?: CompanyComputerBrowserEgressTransport;
}): Promise<{ path: string; close(): Promise<void> }> {
	const info = await lstat(options.root);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o077) !== 0 ||
		(await realpath(options.root)) !== options.root
	)
		throw new Error("UNSAFE_OFFICE_BROWSER_EGRESS_ROOT");
	const path = join(options.root, "egress.sock");
	if (Buffer.byteLength(path) > 103) throw new Error("OFFICE_BROWSER_EGRESS_PATH_TOO_LONG");
	const transport = options.transport ?? {
		resolve: resolveBrowserHost,
		connect: (address: string) => createConnection({ host: address, port: 443, family: 4 }),
	};
	const stop = new AbortController();
	const signal = AbortSignal.any([options.signal, stop.signal]);
	const peers = new Set<Socket>();
	const upstreams = new Set<Socket>();
	const pending = new Set<Promise<unknown>>();
	let transfers = 0;
	let attempts = 0;
	let checking = false;
	let closing: Promise<void> | undefined;
	const fail = (): void => {
		if (!signal.aborted) {
			stop.abort();
			options.onFailure();
		}
	};
	const track = <T>(promise: Promise<T>): Promise<T> => {
		pending.add(promise);
		void promise.finally(() => pending.delete(promise)).catch(() => undefined);
		return promise;
	};
	const check = (checked: AbortSignal): Promise<void> =>
		cloudToolRequest((s) => track(options.assertActive(s)), checked, 3000);
	const server = createServer({ pauseOnConnect: true }, (peer) => {
		if (signal.aborted || peers.size >= 64 || ++attempts > 4096) {
			peer.destroy();
			return;
		}
		peers.add(peer);
		track(new Promise<void>((resolve) => peer.once("close", () => resolve())));
		const attempt = new AbortController();
		const checked = AbortSignal.any([signal, attempt.signal]);
		const timer = setTimeout(() => attempt.abort(), 5000);
		let upstream: Socket | undefined;
		let buffer = Buffer.alloc(0);
		let headerComplete = false;
		const end = (): void => {
			peer.destroy();
			upstream?.destroy();
		};
		checked.addEventListener("abort", end, { once: true });
		peer.on("error", end);
		peer.once("close", () => {
			clearTimeout(timer);
			attempt.abort();
			checked.removeEventListener("abort", end);
			peers.delete(peer);
		});
		peer.setTimeout(30000, end);
		const account = (bytes: Buffer): void => {
			transfers += bytes.length;
			if (transfers > 512 * 1024 * 1024) fail();
		};
		peer.on("data", account);
		const receive = (bytes: Buffer): void => {
			if (headerComplete || checked.aborted) return;
			if (buffer.length + bytes.length > 65536) {
				end();
				return;
			}
			buffer = Buffer.concat([buffer, bytes]);
			const separator = buffer.indexOf("\r\n\r\n");
			if (separator < 0) {
				if (buffer.length > 4096) end();
				return;
			}
			if (separator > 4096) {
				end();
				return;
			}
			headerComplete = true;
			peer.pause();
			peer.removeListener("data", receive);
			const establish = async (): Promise<void> => {
				const lines = buffer.subarray(0, separator).toString("latin1").split("\r\n");
				const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(lines.shift() ?? "");
				if (!match) throw new Error("OFFICE_BROWSER_DESTINATION_DENIED");
				const host = companyComputerBrowserEgressHost(match[1]);
				const names = new Set<string>();
				for (const line of lines) {
					const entry = /^([a-zA-Z-]+):[ \t]*([\x20-\x7e]*)$/.exec(line);
					const name = entry?.[1].toLowerCase();
					if (
						!entry ||
						!name ||
						names.has(name) ||
						!["host", "user-agent", "proxy-connection", "connection"].includes(name)
					)
						throw new Error("OFFICE_BROWSER_PROXY_HEADERS_DENIED");
					names.add(name);
					if (name === "host" && entry[2] !== `${host}:443`) throw new Error("OFFICE_BROWSER_PROXY_HOST_MISMATCH");
				}
				if (!names.has("host")) throw new Error("OFFICE_BROWSER_PROXY_HOST_REQUIRED");
				await check(checked);
				const addresses = await transport.resolve(host, checked);
				checked.throwIfAborted();
				if (
					!addresses.length ||
					addresses.length > 16 ||
					addresses.some((address) => !nativeEgressPublicAddress(address))
				)
					throw new Error("OFFICE_BROWSER_ADDRESS_DENIED");
				await check(checked);
				checked.throwIfAborted();
				upstream = transport.connect(addresses[0]);
				upstreams.add(upstream);
				track(new Promise<void>((resolve) => upstream!.once("close", () => resolve())));
				upstream.on("error", end);
				upstream.once("close", () => {
					if (upstream) upstreams.delete(upstream);
					end();
				});
				upstream.on("data", account);
				upstream.setTimeout(30000, end);
				upstream.once("connect", () => {
					if (checked.aborted) {
						end();
						return;
					}
					clearTimeout(timer);
					peer.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					upstream!.write(buffer.subarray(separator + 4));
					buffer = Buffer.alloc(0);
					peer.pipe(upstream!);
					upstream!.pipe(peer);
					peer.resume();
				});
			};
			void track(establish()).catch(end);
		};
		peer.on("data", receive);
		peer.resume();
	});
	server.maxConnections = 64;
	const abort = (): void => {
		clearInterval(interval);
		for (const socket of [...peers, ...upstreams]) socket.destroy();
		server.close();
	};
	server.on("error", fail);
	signal.addEventListener("abort", abort, { once: true });
	const interval = setInterval(() => {
		if (checking || signal.aborted) return;
		checking = true;
		void check(signal)
			.catch(fail)
			.finally(() => {
				checking = false;
			});
	}, 1000);
	const close = (): Promise<void> => {
		closing ??= cloudToolRequest(
			async () => {
				clearInterval(interval);
				stop.abort();
				signal.removeEventListener("abort", abort);
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await Promise.allSettled([...pending]);
				if (peers.size || upstreams.size || pending.size)
					throw new Error("OFFICE_BROWSER_EGRESS_DRAIN_UNCONFIRMED");
			},
			new AbortController().signal,
			5000,
		);
		return closing;
	};
	try {
		await check(signal);
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const cancelled = (): void => reject(new Error("OFFICE_BROWSER_EGRESS_CANCELLED"));
			const failed = (): void => {
				signal.removeEventListener("abort", cancelled);
				reject(new Error("OFFICE_BROWSER_EGRESS_UNAVAILABLE"));
			};
			signal.addEventListener("abort", cancelled, { once: true });
			server.once("error", failed);
			server.listen(path, () => {
				signal.removeEventListener("abort", cancelled);
				server.removeListener("error", failed);
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
