/**
 * A member's live picture of an agent's desktop (20260930745000): in the large view, the desktop's changed areas as they
 * change, over one WebSocket to the machine-stream address the build names (node 1's own door, `wss://screens.…`), opened
 * with a ticket the member bought on the pointer route (single use, 30 s, for this page's Origin). It only SHOWS: the
 * page never sends a data message on it (the executor ends a stream that does), and nothing on it reaches the desktop.
 *
 * Messages (runner-orchestrator's company-machine-stream.ts):
 *   1 SIZE    width u16, height u16: the screen's size (first, and again when it changes; what was drawn goes).
 *   2 RECTS   count u16, then each x, y, width, height (u16) and bytes (u32) of a PNG: changed areas, drawn in order.
 *   3 CURSOR  hotX, hotY, width, height (u16), bytes (u32) of an RGBA PNG: the pointer's shape (none: 0 bytes).
 * A close says why it ended: 4001 the pass ran out or the stream is old (buy another), 4003 a release cycle refused
 * (its reason), 4004 the desktop ended, 1000 closed, anything else failed.
 */

export const MACHINE_STREAM_PROTOCOL = "qorpera.machine-stream.v1";
/** The largest screen side the machine's node streams. */
const MAX_SIDE = 4096;
/** At most this many areas in one message, and bytes in one: what the machine's node can build at most (8 MiB), so the
 * page never holds more than one such message while it decodes it. */
const MAX_RECTS = 0xffff;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024 + 1024;
/** A pointer shape larger than this is not one (X's cursors are at most 64 px; the browser takes at most 128). */
const MAX_CURSOR_SIDE = 128;
/** The stream answers its first message within this, or it is given up (a door that is off, a ticket refused). */
const OPEN_WITHIN_MS = 10_000;
const TICKET = /^[A-Za-z0-9_-]{43}$/;

export interface MachineStreamRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly png: Blob;
}
export type MachineStreamMessage =
	| { readonly kind: "size"; readonly width: number; readonly height: number }
	| { readonly kind: "rects"; readonly rects: readonly MachineStreamRect[] }
	| {
			readonly kind: "cursor";
			readonly hotX: number;
			readonly hotY: number;
			readonly width: number;
			readonly height: number;
			readonly png: Blob | null;
	  };

/** Why a stream ended, as the page acts on it. `delivered`: it sent at least one message. */
export type MachineStreamEnd = { readonly delivered: boolean } & (
	| { readonly kind: "closed" }
	| { readonly kind: "renew"; readonly reason: string }
	| { readonly kind: "refused"; readonly code: string }
	| { readonly kind: "desktop"; readonly code: string }
	| { readonly kind: "failed" }
	/** No ticket: the executor has no live picture (a node before 20260930745000), or no stream address. */
	| { readonly kind: "unavailable" }
);

/** One message as the machine's node sent it, or null when it is not one (the stream then ends). */
export function readMachineStreamMessage(data: ArrayBuffer): MachineStreamMessage | null {
	if (!(data instanceof ArrayBuffer) || data.byteLength < 1 || data.byteLength > MAX_MESSAGE_BYTES) return null;
	const view = new DataView(data);
	const kind = view.getUint8(0);
	if (kind === 1) {
		if (data.byteLength !== 5) return null;
		const width = view.getUint16(1);
		const height = view.getUint16(3);
		if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null;
		return { kind: "size", width, height };
	}
	if (kind === 2) {
		if (data.byteLength < 3) return null;
		const count = view.getUint16(1);
		if (count < 1 || count > MAX_RECTS) return null;
		const rects: MachineStreamRect[] = [];
		let at = 3;
		for (let n = 0; n < count; n++) {
			if (at + 12 > data.byteLength) return null;
			const x = view.getUint16(at);
			const y = view.getUint16(at + 2);
			const width = view.getUint16(at + 4);
			const height = view.getUint16(at + 6);
			const bytes = view.getUint32(at + 8);
			at += 12;
			if (width < 1 || height < 1 || x + width > MAX_SIDE || y + height > MAX_SIDE || bytes < 8) return null;
			if (at + bytes > data.byteLength) return null;
			rects.push({ x, y, width, height, png: new Blob([data.slice(at, at + bytes)], { type: "image/png" }) });
			at += bytes;
		}
		return at === data.byteLength ? { kind: "rects", rects } : null;
	}
	if (kind === 3) {
		if (data.byteLength < 13) return null;
		const hotX = view.getUint16(1);
		const hotY = view.getUint16(3);
		const width = view.getUint16(5);
		const height = view.getUint16(7);
		const bytes = view.getUint32(9);
		if (13 + bytes !== data.byteLength || width > MAX_CURSOR_SIDE || height > MAX_CURSOR_SIDE) return null;
		if (bytes === 0) return { kind: "cursor", hotX: 0, hotY: 0, width: 0, height: 0, png: null };
		if (width < 1 || height < 1 || hotX >= width || hotY >= height) return null;
		return { kind: "cursor", hotX, hotY, width, height, png: new Blob([data.slice(13)], { type: "image/png" }) };
	}
	return null;
}

/** Why a close ended the stream. */
export function machineStreamEnd(code: number, reason: string, delivered: boolean): MachineStreamEnd {
	const named = /^[A-Z][A-Z_]{1,63}$/.test(reason) ? reason : "";
	if (code === 1000) return { kind: "closed", delivered };
	if (code === 4001) return { kind: "renew", reason: named || "POINTER_PASS_ENDED", delivered };
	if (code === 4003) return { kind: "refused", code: named || "STREAM_UNAVAILABLE", delivered };
	if (code === 4004) return { kind: "desktop", code: named || "DESKTOP_ENDED", delivered };
	return { kind: "failed", delivered };
}

/**
 * Opens one stream on `ticket` and hands every message to `onMessage` in order, until it ends (why) or `signal` aborts
 * (closed by the page: `closed`). The socket, its listeners and its timer go with it, whichever comes first.
 */
export function openMachineStream(options: {
	readonly url: string;
	readonly ticket: string;
	readonly onMessage: (message: MachineStreamMessage) => void;
	readonly signal: AbortSignal;
	readonly WebSocket?: typeof WebSocket;
}): Promise<MachineStreamEnd> {
	return new Promise<MachineStreamEnd>((resolve) => {
		if (options.signal.aborted) {
			resolve({ kind: "closed", delivered: false });
			return;
		}
		if (!TICKET.test(options.ticket)) {
			resolve({ kind: "failed", delivered: false });
			return;
		}
		let socket: WebSocket;
		try {
			const base = new URL(options.url);
			if (base.protocol !== "wss:" && !(base.protocol === "ws:" && /^(127\.0\.0\.1|localhost)$/.test(base.hostname)))
				throw new Error("not a stream address");
			socket = new (options.WebSocket ?? WebSocket)(
				`${base.origin}/v1/member-machine-streams/${options.ticket}`,
				MACHINE_STREAM_PROTOCOL,
			);
		} catch {
			resolve({ kind: "failed", delivered: false });
			return;
		}
		socket.binaryType = "arraybuffer";
		let delivered = false;
		let settled = false;
		const finish = (end: MachineStreamEnd) => {
			if (settled) return;
			settled = true;
			clearTimeout(opening);
			options.signal.removeEventListener("abort", aborted);
			socket.removeEventListener("message", message);
			socket.removeEventListener("close", closed);
			socket.removeEventListener("error", failed);
			// Connecting (0) or open (1): closed from this side.
			if (socket.readyState === 0 || socket.readyState === 1) {
				try {
					socket.close(1000);
				} catch {
					// Closed meanwhile.
				}
			}
			resolve(end);
		};
		const aborted = () => finish({ kind: "closed", delivered });
		const opening = setTimeout(() => {
			if (!delivered) finish({ kind: "failed", delivered });
		}, OPEN_WITHIN_MS);
		const message = (event: MessageEvent) => {
			const read = event.data instanceof ArrayBuffer ? readMachineStreamMessage(event.data) : null;
			if (!read || (!delivered && read.kind !== "size")) {
				// Not a message of the stream, or no size first: ended, never guessed at.
				finish({ kind: "failed", delivered });
				return;
			}
			delivered = true;
			options.onMessage(read);
		};
		const closed = (event: CloseEvent) => finish(machineStreamEnd(event.code, event.reason, delivered));
		const failed = () => finish({ kind: "failed", delivered });
		options.signal.addEventListener("abort", aborted, { once: true });
		socket.addEventListener("message", message);
		socket.addEventListener("close", closed);
		socket.addEventListener("error", failed);
	});
}
