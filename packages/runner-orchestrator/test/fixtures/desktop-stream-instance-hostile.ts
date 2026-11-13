import { Socket } from "node:net";
import { DESKTOP_STREAM_FRAME as F } from "../../src/company-machine-stream-process.ts";

// An instance that speaks the frames itself and breaks the protocol on purpose, as the spec's name in main's HELLO
// says. Main must end it where a correct instance never goes, and hold it back (never end it) where one could:
//   flood      sends for a member it was given no ok for
//   chatter    a hundred thousand pongs at once, then answers as it should
//   eager      asks a member's release again the moment each verdict comes (as a correct one whose clock runs ahead)
//   oversized  a frame longer than any frame may be
//   unknown    a frame of a type there is not
//   stranger   a release for a member it was never given
//   die        exits soon after its first member
//   silent     reads everything and answers nothing
const connection = new Socket({ fd: 0, readable: true, writable: true });
const frame = (type: number, member: number, payload: Buffer = Buffer.alloc(0)) => {
	const head = Buffer.alloc(9);
	head.writeUInt32BE(payload.byteLength, 0);
	head[4] = type;
	head.writeUInt32BE(member, 5);
	return Buffer.concat([head, payload]);
};
let held = Buffer.alloc(0);
let mode = "";
connection.on("data", (piece: Buffer) => {
	held = Buffer.concat([held, piece]);
	while (held.byteLength >= 9) {
		const length = held.readUInt32BE(0);
		if (held.byteLength < 9 + length) return;
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
		connection.write(frame(F.ready, 0));
		if (mode === "chatter") {
			const pong = frame(F.pong, 0);
			connection.write(Buffer.concat(Array.from({ length: 100_000 }, () => pong)));
		}
		if (mode === "oversized") connection.write(frame(F.send, 0, Buffer.alloc(0)).fill(0xff, 0, 4));
		if (mode === "unknown") connection.write(frame(99, 0));
		return;
	}
	if (type === F.ping && mode !== "silent") connection.write(frame(F.pong, 0));
	if (type === F.watch) {
		if (mode === "flood")
			for (let n = 0; n < 1000; n++) connection.write(frame(F.send, member, Buffer.from([2, 0, 0])));
		if (mode === "eager") connection.write(frame(F.release, member));
		if (mode === "stranger") connection.write(frame(F.release, 77));
		if (mode === "die") setTimeout(() => process.exit(3), 50);
	}
	if (type === F.verdict && mode === "eager") connection.write(frame(F.release, member));
}
