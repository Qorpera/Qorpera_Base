import { createServer, type Server, type Socket } from "node:net";
import {
	ErrorCode,
	encodeFrame,
	encodeJson,
	type Frame,
	FrameReader,
	Kind,
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

/** Serves the folder protocol on the node's Unix socket. Only the vsock bridge can open that socket (systemd gives it
 * the bridge's group, mode 0660); its first frame names the machine's CID, and no other frame may. */
export function createFolderServer(service: FolderService, log: (line: string) => void): Server {
	return createServer((socket) => serve(service, socket, log));
}

function serve(service: FolderService, socket: Socket, log: (line: string) => void): void {
	const reader = new FrameReader();
	let cid: number | undefined;
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
	const fail = (error: unknown): void => {
		const known = error instanceof ProtocolError;
		if (!known) log(`folder-service: connection from machine ${cid ?? "?"}: ${(error as Error).message}`);
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
		if (!frame) return;
		busy = true;
		try {
			await handleFrame(frame);
		} catch (error) {
			fail(error);
			// A refused hello, a protocol error or a closed view ends the connection; a failed request does not.
			if (!(error instanceof ProtocolError) || error.fatal || !requestError(error.code) || role !== "io") end();
		} finally {
			busy = false;
		}
		void next();
	};

	const handleFrame = async (frame: Frame): Promise<void> => {
		if (cid === undefined) {
			if (frame.kind !== Kind.bridge) throw new ProtocolError(ErrorCode.badRequest, "Expected the bridge frame");
			cid = parseBridge(frame.payload);
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
				handle = await service.open(hello, cid);
			} finally {
				opening = false;
			}
			if (ended) {
				handle.release();
				return;
			}
			role = hello.role;
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
					change: (message: ChangeMessage) => send(encodeJson(Kind.change, message)),
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
