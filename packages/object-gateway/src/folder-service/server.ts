import { createServer, type Server, type Socket } from "node:net";
import {
	type BridgeInfo,
	ErrorCode,
	encodeFrame,
	encodeJson,
	type Frame,
	FrameReader,
	HELLO_MAX_PAYLOAD,
	Kind,
	MAX_PAYLOAD,
	PROTOCOL,
	ProtocolError,
	parseAck,
	parseBridge,
	parseHello,
	parseList,
	parseRead,
} from "./protocol.ts";
import type { ChangeMessage, FolderService, ViewHandle } from "./service.ts";

/** The bridge's frame must arrive this soon after it connects, and the machine's hello this soon after that. */
const BRIDGE_MS = 5_000;
const HELLO_MS = 15_000;
/** A feed connection whose machine leaves this much unread is ended; the machine reconnects and drops its caches. */
const FEED_BACKLOG = 4 * 1024 * 1024;

/** Serves the folder protocol on the node's Unix socket. Only the vsock bridge can open that socket (systemd gives it
 * the bridge's group, mode 0660); its first frame names the machine, and no other frame may.
 *
 * Memory per connection stays bounded: frames are at most 4 KiB until the hello is accepted, one request is handled
 * at a time (the socket is paused meanwhile), and the next waits until the machine has read the last answer. */
export function createFolderServer(service: FolderService, log: (line: string) => void): Server {
	return createServer((socket) => serve(service, socket, log));
}

function serve(service: FolderService, socket: Socket, log: (line: string) => void): void {
	const reader = new FrameReader(HELLO_MAX_PAYLOAD);
	let bridge: BridgeInfo | undefined;
	let handle: ViewHandle | undefined;
	let role: "io" | "feed" | undefined;
	let busy = false;
	let opening = false;
	let ended = false;
	const queue: Frame[] = [];
	let deadline = setTimeout(() => end(), BRIDGE_MS);

	const send = (bytes: Buffer): void => {
		if (!ended) socket.write(bytes);
	};
	/** Resolves once the machine has read what was sent (or the connection ended). */
	const drained = (): Promise<void> =>
		new Promise((resolve) => {
			if (ended || !socket.writableNeedDrain) return resolve();
			const done = (): void => {
				socket.off("drain", done);
				socket.off("close", done);
				resolve();
			};
			socket.once("drain", done);
			socket.once("close", done);
		});
	const fail = (error: unknown): void => {
		const known = error instanceof ProtocolError;
		if (!known) log(`folder-service: connection from machine ${bridge?.cid ?? "?"}: ${(error as Error).message}`);
		send(
			encodeJson(Kind.error, {
				code: known ? error.code : ErrorCode.unavailable,
				message: known ? error.message : "The folder service failed",
			}),
		);
	};
	const end = (): void => {
		if (ended) return;
		ended = true;
		clearTimeout(deadline);
		handle?.release();
		socket.end();
		socket.destroySoon();
	};

	const next = async (): Promise<void> => {
		if (busy || ended) return;
		const frame = queue.shift();
		if (!frame) {
			socket.resume();
			return;
		}
		busy = true;
		try {
			await handleFrame(frame);
		} catch (error) {
			fail(error);
			// A refused hello, a protocol error or a closed view ends the connection; a failed request does not.
			if (!(error instanceof ProtocolError) || error.fatal || !requestError(error.code) || role !== "io") end();
		}
		await drained();
		busy = false;
		void next();
	};

	const handleFrame = async (frame: Frame): Promise<void> => {
		if (bridge === undefined) {
			if (frame.kind !== Kind.bridge) throw new ProtocolError(ErrorCode.badRequest, "Expected the bridge frame");
			bridge = parseBridge(frame.payload);
			clearTimeout(deadline);
			deadline = setTimeout(() => {
				if (!handle && !opening) end();
			}, HELLO_MS);
			return;
		}
		if (frame.kind === Kind.bridge)
			throw new ProtocolError(ErrorCode.badRequest, "Only the bridge names a machine", true);
		if (!handle) {
			if (frame.kind !== Kind.hello) throw new ProtocolError(ErrorCode.badRequest, "Expected a hello");
			const hello = parseHello(frame.payload);
			opening = true;
			clearTimeout(deadline);
			try {
				handle = await service.open(hello, bridge);
			} finally {
				opening = false;
			}
			if (ended) {
				handle.release();
				return;
			}
			role = hello.role;
			reader.limit = MAX_PAYLOAD;
			send(
				encodeJson(Kind.helloOk, {
					protocol: PROTOCOL,
					viewId: hello.viewId,
					asOfSeq: handle.asOfSeq,
					readOnly: true,
				}),
			);
			if (role === "feed")
				handle.subscribe({
					change: (message: ChangeMessage) => {
						if (socket.writableLength > FEED_BACKLOG) {
							log(`folder-service: machine ${bridge?.cid} is not reading its feed; ending the connection`);
							end();
							return;
						}
						send(encodeJson(Kind.change, message));
					},
					closed: (code, message) => {
						send(encodeJson(Kind.error, { code, message }));
						end();
					},
				});
			return;
		}
		if (role === "feed") {
			if (frame.kind !== Kind.ack)
				throw new ProtocolError(ErrorCode.badRequest, "A feed only takes acknowledgements");
			parseAck(frame.payload);
			return;
		}
		switch (frame.kind) {
			case Kind.list: {
				const request = parseList(frame.payload);
				send(encodeJson(Kind.listing, await handle.list(request.path, request.after)));
				return;
			}
			case Kind.read: {
				const bytes = await handle.read(parseRead(frame.payload));
				send(encodeFrame(Kind.data, bytes));
				return;
			}
			default:
				throw new ProtocolError(ErrorCode.badRequest, "Unknown request", true);
		}
	};

	socket.on("data", (data: Buffer) => {
		try {
			queue.push(...reader.push(data));
		} catch (error) {
			fail(error);
			end();
			return;
		}
		// No more reading while frames wait: a machine that sends faster than it is answered is held back.
		if (queue.length > 0) socket.pause();
		void next();
	});
	socket.on("error", () => end());
	socket.on("close", () => end());
}

/** Errors about one request; the connection carries on. */
function requestError(code: ErrorCode): boolean {
	return (
		code === ErrorCode.notFound ||
		code === ErrorCode.notAFolder ||
		code === ErrorCode.notAFile ||
		code === ErrorCode.stale ||
		code === ErrorCode.denied ||
		code === ErrorCode.unavailable ||
		code === ErrorCode.badRequest
	);
}
