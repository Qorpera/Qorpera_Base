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
	CLOUD_HOME_CHANNEL_HANDSHAKE_MS,
	CLOUD_HOME_CHANNEL_LINE_BYTES,
	CLOUD_HOME_CHANNEL_PATH,
	CLOUD_HOME_CHANNEL_PROTOCOL,
	type CloudHomeChannelReady,
	cloudHomeChannelHandshake,
} from "./cloud-home-channel.ts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

const ERROR = "cloud_home_channel_unavailable";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** One channel of one run to its home, over the executor's ingress. */
export function createCloudHomeChannel(options: {
	url: string;
	token: string;
	binding: CloudNativeToolBinding;
	/** The run's holder credential, read per connection, as a machine command reads it per request. */
	holder: () => string;
	allowLoopback?: boolean;
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
					"x-qorpera-identity": options.holder(),
				},
			});
			const socket = await new Promise<Socket>((resolve, reject) => {
				// The cause stays in this host's journal: the model is told the home is unavailable, never why in the
				// ingress's own words, and never an address.
				const fail = (why: string): void => reject(new Error(`${ERROR}: ${why}`));
				connection.once("error", (error) => fail(String((error as NodeJS.ErrnoException)?.code ?? "unreachable")));
				connection.once("response", (answer) => {
					connection.destroy();
					fail(`refused ${answer.statusCode ?? 0} ${String(answer.headers["x-qorpera-home"] ?? "")}`.trim());
				});
				connection.once("upgrade", (_answer, upgraded) => resolve(upgraded as Socket));
				connection.end();
			});
			socket.on("error", () => undefined);
			const reader = lines(socket);
			let ready: CloudHomeChannelReady | undefined;
			try {
				socket.write(`${cloudHomeChannelHandshake({ ...input, binding: options.binding })}\n`);
				const first = await Promise.race([
					reader.next(),
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error(ERROR)), CLOUD_HOME_CHANNEL_HANDSHAKE_MS).unref(),
					),
				]);
				if (!first.done) ready = JSON.parse(first.value) as CloudHomeChannelReady;
			} catch (error) {
				socket.destroy();
				throw new Error(`${ERROR}: ${String((error as Error)?.message ?? "")}`.trim());
			}
			if (!ready?.ok) {
				socket.destroy();
				if (ready) throw new Error(`${ERROR}: ${ready.reason}`);
				// The reason is the ingress's own words (the machine is not running, this boot is over): the host shows
				// the model words of its own, never an address or a session id.
				throw new Error(ERROR);
			}
			return {
				write: (line) => {
					if (socket.writable) socket.write(`${line}\n`);
				},
				lines: reader,
				close: async () => {
					socket.destroy();
				},
			} satisfies CloudCodexHomeStream;
		},
	};
}

/** Each complete line of the socket. A line over the bound ends the channel, as it does on the ingress's side. */
async function* lines(socket: Socket): AsyncGenerator<string> {
	let rest = "";
	for await (const chunk of socket) {
		rest += (chunk as Buffer).toString("utf8");
		if (Buffer.byteLength(rest) > CLOUD_HOME_CHANNEL_LINE_BYTES) throw new Error(ERROR);
		let end = rest.indexOf("\n");
		while (end >= 0) {
			yield rest.slice(0, end);
			rest = rest.slice(end + 1);
			end = rest.indexOf("\n");
		}
	}
}
