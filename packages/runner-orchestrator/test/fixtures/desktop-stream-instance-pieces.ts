import { writeSync } from "node:fs";
import { Socket } from "node:net";
import { DESKTOP_STREAM_MESSAGE_BYTES, DESKTOP_STREAM_FRAME as F } from "../../src/company-machine-stream-process.ts";
import { message, pieces, plan } from "./desktop-stream-plan.ts";

// An instance that keeps to the protocol and cuts what it writes as the spec's name in main's HELLO says: main must
// spend no more than its budgets on it, hold no more than its bounds, and end nothing.
//   fragment         one largest SEND, written a byte at a time
//   random:<seed>    each member's planned cycles (desktop-stream-plan.ts), all its frames cut into random pieces from
//                    1 byte to 256 KiB with long runs of 1-byte pieces
//   smallflood       160 three-byte SENDs for every ok, each as soon as the last is SENT, the next RELEASE at once
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

let cycles: number[][][] = [];
const done = new Map<number, { cycle: number; index: number; sent: number }>();
const send = (member: number) => {
	const at = done.get(member) ?? { cycle: 0, index: 0, sent: 0 };
	done.set(member, at);
	const cycle = cycles[member - 1]?.[at.cycle];
	if (!cycle) return;
	const size = cycle[at.index];
	if (size === undefined) {
		// The cycle is through: the next one asks again (25 ms on, or main holds it).
		at.cycle++;
		at.index = 0;
		if (cycles[member - 1]?.[at.cycle]) setTimeout(() => write(frame(F.release, member)), 30);
		return;
	}
	write(frame(F.send, member, message(member, at.sent, size)));
	at.index++;
	at.sent++;
};

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
		if (mode.startsWith("random:")) {
			const seed = Number(mode.split(":")[1]);
			cycles = plan(seed, 3, 3);
			cut = pieces(seed);
		}
		write(frame(F.ready, 0));
		return;
	}
	if (type === F.ping) write(frame(F.pong, 0));
	if (type === F.watch) write(frame(F.release, member));
	if (type === F.verdict && payload[0] === 0) {
		if (mode === "fragment" || mode === "drip")
			write(frame(F.send, member, message(member, 0, DESKTOP_STREAM_MESSAGE_BYTES)));
		if (mode.startsWith("random:")) send(member);
		if (mode === "smallflood") {
			flood.set(member, 1);
			write(frame(F.send, member, Buffer.from([2, 0, 0])));
		}
	}
	if (type === F.sent) {
		if (mode.startsWith("random:")) send(member);
		if (mode === "smallflood") {
			const count = flood.get(member) ?? 0;
			if (count < 160) {
				flood.set(member, count + 1);
				write(frame(F.send, member, Buffer.from([2, 0, 0])));
			} else write(frame(F.release, member));
		}
	}
	if (type === F.verdict && payload[0] !== 0 && mode === "smallflood") write(frame(F.release, member));
}
flood = new Map();
