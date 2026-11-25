// The run's side of the channel to its home (slice 1): the host in the run's slot opens one upgraded connection to
// the coding executor's ingress, with the same transport token and the same per-request holder credential that a
// machine command carries, and then speaks JSON-RPC lines with `codex exec-server` on the machine.
//
// Nothing of the model's is trusted here: the machine is named by the host from the run's own authority, and the
// ingress authorizes the session again in SQL before a byte reaches the machine.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { CloudCodingCommandScope } from "@qorpera/contracts";
import type { CloudCodexHomeChannel, CloudCodexHomeStream } from "./cloud-codex-home.ts";
import {
	CLOUD_HOME_CHANNEL_KEEPALIVE_MS,
	CLOUD_HOME_CHANNEL_OPEN_MS,
	CLOUD_HOME_CHANNEL_PATH,
	CLOUD_HOME_CHANNEL_PROTOCOL,
	CLOUD_HOME_CHANNEL_REASON,
	type CloudCodingChannelReady,
	type CloudHomeChannelKind,
	type CloudHomeChannelReady,
	CloudHomeChannelRefused,
	cloudCodingChannelHandshake,
	cloudHomeChannelHandshake,
	cloudHomeChannelKeepAlive,
	cloudHomeChannelLines,
	cloudHomeChannelWithoutKeepAlive,
} from "./cloud-home-channel.ts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

const ERROR = "cloud_home_channel_unavailable";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface CloudCodingChannel {
	open(
		input: { readonly scope: CloudCodingCommandScope; readonly kind?: CloudHomeChannelKind },
		signal: AbortSignal,
	): Promise<CloudCodexHomeStream>;
}

interface ChannelClientOptions {
	url: string;
	token: string;
	binding: CloudNativeToolBinding;
	holder: (() => string) | null;
	allowLoopback?: boolean;
	keepAliveMs?: number;
}

function openUpgradedChannel(
	options: ChannelClientOptions,
	handshakeLine: () => string,
	signal: AbortSignal,
): Promise<CloudCodexHomeStream> {
	const base = new URL(options.url);
	signal.throwIfAborted();
	const limit = new AbortController();
	const timer = setTimeout(() => limit.abort(new Error("the ingress did not answer")), CLOUD_HOME_CHANNEL_OPEN_MS);
	const stopped = (): void => limit.abort(new Error("stopped"));
	signal.addEventListener("abort", stopped, { once: true });
	const deadline = limit.signal;
	const done = (): void => {
		clearTimeout(timer);
		signal.removeEventListener("abort", stopped);
	};

	return (async () => {
		try {
			const open = base.protocol === "https:" ? httpsRequest : httpRequest;
			const connection = open({
				protocol: base.protocol,
				hostname: base.hostname,
				port: base.port,
				path: CLOUD_HOME_CHANNEL_PATH,
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: CLOUD_HOME_CHANNEL_PROTOCOL,
					authorization: `Bearer ${options.token}`,
					...(options.holder ? { "x-qorpera-identity": options.holder() } : {}),
				},
			});
			const socket = await new Promise<Socket>((resolve, reject) => {
				const fail = (why: string): void => {
					connection.destroy();
					reject(new Error(`${ERROR}: ${why}`));
				};
				const abort = (): void => fail(String((deadline.reason as Error)?.message ?? "stopped"));
				deadline.addEventListener("abort", abort, { once: true });
				const settled = (): void => deadline.removeEventListener("abort", abort);
				connection.once("error", (error) => {
					settled();
					fail(String((error as NodeJS.ErrnoException)?.code ?? "unreachable"));
				});
				connection.once("response", (answer) => {
					settled();
					fail(`refused ${answer.statusCode ?? 0} ${String(answer.headers["x-qorpera-home"] ?? "")}`.trim());
				});
				connection.once("upgrade", (_answer, upgraded) => {
					settled();
					resolve(upgraded as Socket);
				});
				connection.end();
			});
			socket.on("error", () => undefined);
			const reader = cloudHomeChannelLines(socket);
			let ready: CloudHomeChannelReady | CloudCodingChannelReady | undefined;
			let wake: (() => void) | undefined;
			try {
				socket.write(`${handshakeLine()}\n`);
				const first = await Promise.race([
					reader.next(),
					new Promise<never>((_resolve, reject) => {
						wake = (): void => reject(new Error(`${ERROR}: no answer to the handshake`));
						if (deadline.aborted) wake();
						else deadline.addEventListener("abort", wake, { once: true });
					}),
				]);
				if (!first.done) ready = JSON.parse(first.value) as CloudHomeChannelReady | CloudCodingChannelReady;
			} catch (error) {
				socket.destroy();
				throw new Error(`${ERROR}: ${String((error as Error)?.message ?? "")}`.trim());
			} finally {
				if (wake) deadline.removeEventListener("abort", wake);
			}
			if (!ready?.ok) {
				socket.destroy();
				if (ready && typeof ready.reason === "string" && CLOUD_HOME_CHANNEL_REASON.test(ready.reason))
					throw new CloudHomeChannelRefused(ready.reason);
				throw new Error(ERROR);
			}
			const stopKeepAlive =
				socket.destroyed || socket.closed
					? () => undefined
					: cloudHomeChannelKeepAlive(socket, options.keepAliveMs ?? CLOUD_HOME_CHANNEL_KEEPALIVE_MS);
			if (socket.destroyed || socket.closed) stopKeepAlive();
			else socket.once("close", stopKeepAlive);
			const lines = (async function* (): AsyncGenerator<string> {
				try {
					yield* cloudHomeChannelWithoutKeepAlive(reader);
				} finally {
					stopKeepAlive();
				}
			})();
			return {
				write: (line) => {
					if (socket.writable) socket.write(`${line}\n`);
				},
				lines,
				close: async () => {
					stopKeepAlive();
					socket.destroy();
				},
			} satisfies CloudCodexHomeStream;
		} finally {
			done();
		}
	})();
}

function validateChannelOptions(options: ChannelClientOptions): void {
	const base = new URL(options.url);
	if (
		!TOKEN.test(options.token) ||
		(base.protocol !== "https:" && !(base.protocol === "http:" && options.allowLoopback === true)) ||
		base.search !== "" ||
		base.hash !== ""
	)
		throw new Error(ERROR);
}

/** One channel of one run to its home, over the executor's ingress. */
export function createCloudHomeChannel(options: {
	url: string;
	token: string;
	binding: CloudNativeToolBinding;
	/** The run's holder credential, read per connection, as a machine command reads it per request. Null for an
	 * executor forwarding a channel to a peer's listener, which takes none (as for a machine command). */
	holder: (() => string) | null;
	allowLoopback?: boolean;
	/** How often this end says it is still there (CLOUD_HOME_CHANNEL_KEEPALIVE): the tests' own shorter one. */
	keepAliveMs?: number;
}): CloudCodexHomeChannel {
	validateChannelOptions(options);
	return {
		open: (input, signal) =>
			openUpgradedChannel(options, () => cloudHomeChannelHandshake({ ...input, binding: options.binding }), signal),
	};
}

export function createCloudCodingChannel(options: {
	url: string;
	token: string;
	binding: CloudNativeToolBinding;
	holder: (() => string) | null;
	allowLoopback?: boolean;
	keepAliveMs?: number;
}): CloudCodingChannel {
	validateChannelOptions(options);
	return {
		open: (input, signal) =>
			openUpgradedChannel(
				options,
				() => cloudCodingChannelHandshake({ ...input, binding: options.binding }),
				signal,
			),
	};
}
