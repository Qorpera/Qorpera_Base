// The run's side of the channel to its home (slice 1): the host in the run's slot opens one upgraded connection to
// the coding executor's ingress, with the same transport token and the same per-request holder credential that a
// machine command carries, and then speaks JSON-RPC lines with `codex exec-server` on the machine.
//
// Nothing of the model's is trusted here: the machine is named by the host from the run's own authority, and the
// ingress authorizes the session again in SQL before a byte reaches the machine.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { CloudCodexHomeChannel, CloudCodexHomeStream } from "./cloud-codex-home.ts";
import {
	CLOUD_HOME_CHANNEL_KEEPALIVE_MS,
	CLOUD_HOME_CHANNEL_OPEN_MS,
	CLOUD_HOME_CHANNEL_PATH,
	CLOUD_HOME_CHANNEL_PROTOCOL,
	CLOUD_HOME_CHANNEL_REASON,
	type CloudHomeChannelReady,
	CloudHomeChannelRefused,
	cloudHomeChannelHandshake,
	cloudHomeChannelKeepAlive,
	cloudHomeChannelLines,
	cloudHomeChannelWithoutKeepAlive,
} from "./cloud-home-channel.ts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

const ERROR = "cloud_home_channel_unavailable";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

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
	const base = new URL(options.url);
	if (
		!TOKEN.test(options.token) ||
		(base.protocol !== "https:" && !(base.protocol === "http:" && options.allowLoopback === true)) ||
		base.search !== "" ||
		base.hash !== ""
	)
		throw new Error(ERROR);
	return {
		open: async (input, signal) => {
			signal.throwIfAborted();
			// One deadline over the whole of the opening: the connection, the upgrade and the handshake (review round
			// 1, F11). A peer that accepts and says nothing cannot hold a run's turn, and a stopped run drops it at
			// once. It ends when the channel is open, deliberately: a deadline left on the request would destroy the
			// channel from under a run that is working on its machine (the request owns the socket it upgraded).
			const limit = new AbortController();
			const timer = setTimeout(
				() => limit.abort(new Error("the ingress did not answer")),
				CLOUD_HOME_CHANNEL_OPEN_MS,
			);
			const stopped = (): void => limit.abort(new Error("stopped"));
			signal.addEventListener("abort", stopped, { once: true });
			const deadline = limit.signal;
			const done = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", stopped);
			};
			try {
				return await openChannel();
			} finally {
				done();
			}

			async function openChannel(): Promise<CloudCodexHomeStream> {
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
					// The cause stays in this host's journal: the model is told the home is unavailable, never why in the
					// ingress's own words, and never an address.
					const fail = (why: string): void => {
						connection.destroy();
						reject(new Error(`${ERROR}: ${why}`));
					};
					// Until the upgrade, the deadline ends the request itself; after it, nothing of the opening holds the
					// socket, which is the channel from then on.
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
				let ready: CloudHomeChannelReady | undefined;
				let wake: (() => void) | undefined;
				try {
					socket.write(`${cloudHomeChannelHandshake({ ...input, binding: options.binding })}\n`);
					const first = await Promise.race([
						reader.next(),
						new Promise<never>((_resolve, reject) => {
							wake = (): void => reject(new Error(`${ERROR}: no answer to the handshake`));
							if (deadline.aborted) wake();
							else deadline.addEventListener("abort", wake, { once: true });
						}),
					]);
					if (!first.done) ready = JSON.parse(first.value) as CloudHomeChannelReady;
				} catch (error) {
					socket.destroy();
					throw new Error(`${ERROR}: ${String((error as Error)?.message ?? "")}`.trim());
				} finally {
					if (wake) deadline.removeEventListener("abort", wake);
				}
				if (!ready?.ok) {
					socket.destroy();
					// The reason is the ingress's own code (the machine is not running, this boot is over, the home is busy
					// with another run's work): the host turns it into words of its own, never an address or a session id.
					if (ready && typeof ready.reason === "string" && CLOUD_HOME_CHANNEL_REASON.test(ready.reason))
						throw new CloudHomeChannelRefused(ready.reason);
					throw new Error(ERROR);
				}
				// While the channel is open this end says it is there, and the ingress's own such lines are dropped here.
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
			}
		},
	};
}
