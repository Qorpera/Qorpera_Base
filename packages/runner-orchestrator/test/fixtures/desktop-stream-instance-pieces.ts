import { writeSync } from "node:fs";
import { Socket } from "node:net";
import { DESKTOP_STREAM_MESSAGE_BYTES, DESKTOP_STREAM_FRAME as F } from "../../src/company-machine-stream-process.ts";
import { message } from "./desktop-stream-plan.ts";

// An instance that keeps to the protocol and cuts what it writes as the spec's name in main's HELLO says: main must
// spend no more than its budgets on it, hold no more than its bounds, and end nothing.
//   fragment         one largest SEND, written a byte at a time
//   smallflood       the most small SENDs one ok allows (3), each as soon as the last is SENT, the next RELEASE at once
//   bigflood         1 MiB SENDs for every ok, as many as one cycle may carry (72 MiB), the next RELEASE at once
//   fourth           four small SENDs for one ok: one more than a cycle with little to send can have
//   pinner           member 1 three small SENDs every ok, member 2 1 MiB ones: what a stalled member 1 keeps must
//                    keep nothing else alive
//   drip             one largest SEND, a byte a write, as fast as it can, never finished soon
const connection = new Socket({ fd: 0, readable: true, writable: true });
const frame = (type: number, member: number, payload: Buffer = Buffer.alloc(0)) => {
	const head = Buffer.alloc(9);
	head.writeUInt32BE(payload.byteLength, 0);
	head[4] = type;
	head.writeUInt32BE(member, 5);
	return Buffer.concat([head, payload]);
};
let mode = "";
let cut: () => number = () => 1 << 30;

// What to write, in order, cut into pieces as the mode says; each piece one write of its own.
const queue: Buffer[] = [];
let writing = false;
const write = (bytes: Buffer) => {
	queue.push(bytes);
	if (!writing) {
		writing = true;
		setImmediate(flush);
	}
};
function flush(): void {
	// A drip writes one byte a turn of its loop; the others write as fast as they can.
	for (let n = 0; n < (mode === "drip" ? 1 : 4000) && queue.length > 0; n++) {
		const first = queue[0] as Buffer;
		const size = Math.min(first.byteLength, cut());
		let written = 0;
		try {
			written = writeSync(0, first, 0, size);
		} catch (error) {
			if ((error as { code?: string }).code !== "EAGAIN") process.exit(0);
			setTimeout(flush, 1);
			return;
		}
		if (written === first.byteLength) queue.shift();
		else queue[0] = first.subarray(written);
	}
	if (queue.length > 0) setImmediate(flush);
	else writing = false;
}

let flood = new Map<number, number>();
let held = Buffer.alloc(0);
connection.on("data", (piece: Buffer) => {
	held = Buffer.concat([held, piece]);
	while (held.byteLength >= 9 && held.byteLength >= 9 + held.readUInt32BE(0)) {
		const length = held.readUInt32BE(0);
		const type = held[4] as number;
		const member = held.readUInt32BE(5);
		const payload = held.subarray(9, 9 + length);
		held = held.subarray(9 + length);
		take(type, member, payload);
	}
});
connection.on("close", () => process.exit(0));
connection.on("error", () => process.exit(0));

function take(type: number, member: number, payload: Buffer): void {
	if (type === F.hello) {
		mode = (JSON.parse(payload.toString("utf8")) as { spec: { name: string } }).spec.name;
		if (mode === "fragment" || mode === "drip") cut = () => 1;
		write(frame(F.ready, 0));
		return;
	}
	if (type === F.ping) write(frame(F.pong, 0));
	if (type === F.watch) write(frame(F.release, member));
	if (type === F.verdict && payload[0] === 0) {
		if (mode === "fragment" || mode === "drip")
			write(frame(F.send, member, message(member, 0, DESKTOP_STREAM_MESSAGE_BYTES)));
		else {
			flood.set(member, 0);
			next(member);
		}
	}
	if (type === F.sent) next(member);
	if (type === F.verdict && payload[0] !== 0 && mode !== "fragment" && mode !== "drip")
		write(frame(F.release, member));
}

const SMALL = Buffer.from([2, 0, 0]);
const LARGE = message(2, 0, 1024 * 1024);
/** The next SEND of this ok, or the next RELEASE once the ok is used up. */
function next(member: number): void {
	const sent = flood.get(member) ?? 0;
	flood.set(member, sent + 1);
	const small = mode === "smallflood" || mode === "fourth" || (mode === "pinner" && member === 1);
	const most = mode === "fourth" ? 4 : small ? 3 : 72;
	if (sent < most) write(frame(F.send, member, small ? SMALL : LARGE));
	else write(frame(F.release, member));
}
flood = new Map();
