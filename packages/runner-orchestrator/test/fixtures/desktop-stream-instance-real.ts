import { createHash } from "node:crypto";
import { appendFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { RFB_VERSION } from "../../src/company-machine-stream.ts";
import { runDesktopStreamInstance } from "../../src/company-machine-stream-process.ts";
import { pieces, seeded } from "./desktop-stream-plan.ts";

// The REAL instance (runDesktopStreamInstance, the real DesktopStream: its reader, ring, dedup, PNGs and #send) with a
// seeded desktop of its own, and everything it writes cut into random pieces from 1 byte to 256 KiB with long runs of
// 1-byte pieces. The spec's name is `<seed>:<file>`: each SEND it writes is recorded there (member, sha-256, size), so
// the test can check that every message arrived whole and in order, and main's per-send rule meets the real #send.
const socket = new Socket({ fd: 0, readable: true, writable: true });
let file = "";
let cut: () => number = () => 1 << 30;
const queue: Buffer[] = [];
let writing = false;
function flush(): void {
	for (let n = 0; n < 4000 && queue.length > 0; n++) {
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
// The instance's connection: what main sends comes from the socket; what the instance writes goes out in pieces.
const connection = new Duplex({
	read() {},
	write(chunk: Buffer, _encoding, done) {
		// A frame's header and its payload come as their own writes: record each SEND's payload as it is written.
		if (chunk.byteLength >= 9 && chunk[4] === 18 && chunk.readUInt32BE(0) > 0) pending = chunk.readUInt32BE(5);
		else if (pending !== null) {
			appendFileSync(file, `${pending} ${createHash("sha256").update(chunk).digest("hex")} ${chunk.byteLength}\n`);
			pending = null;
		}
		queue.push(Buffer.from(chunk));
		if (!writing) {
			writing = true;
			setImmediate(flush);
		}
		done();
	},
});
let pending: number | null = null;
socket.on("data", (piece: Buffer) => connection.push(piece));
socket.on("end", () => connection.push(null));
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(0));

runDesktopStreamInstance({
	connection,
	version: "test-version",
	openRelay: (spec) => {
		const [seedText, path] = spec.name.split(/:(.*)/s) as [string, string];
		const seed = Number(seedText);
		file = path;
		cut = pieces(seed);
		const random = seeded(seed);
		const [width, height] = [1024, 768];
		// A seeded desktop: every update request answered with 1 to 6 areas, now and then the whole screen or a pointer.
		return (stdout, stdin, signal) =>
			new Promise<number>((resolve) => {
				signal.addEventListener("abort", () => resolve(137), { once: true });
				const init = Buffer.alloc(30);
				init.writeUInt16BE(width, 0);
				init.writeUInt16BE(height, 2);
				init.writeUInt32BE(6, 20);
				init.write("Xvnc:1", 24, "latin1");
				stdout(Buffer.concat([RFB_VERSION, Buffer.from([1, 1]), Buffer.alloc(4), init]));
				let held = Buffer.alloc(0);
				let stage = 0;
				let updates = 0;
				const answer = () => {
					if (signal.aborted || updates >= 150) return;
					updates++;
					const parts: Buffer[] = [];
					const count = random() < 0.1 ? 1 : 1 + Math.floor(random() * 6);
					for (let n = 0; n < count; n++) {
						const whole = random() < 0.05;
						const w = whole ? width : 1 + Math.floor(random() * 64);
						const h = whole ? height : 1 + Math.floor(random() * 64);
						const x = whole ? 0 : Math.floor(random() * (width - w));
						const y = whole ? 0 : Math.floor(random() * (height - h));
						const head = Buffer.alloc(12);
						head.writeUInt16BE(x, 0);
						head.writeUInt16BE(y, 2);
						head.writeUInt16BE(w, 4);
						head.writeUInt16BE(h, 6);
						const pixels = Buffer.alloc(w * h * 4);
						const noisy = whole ? random() < 0.5 : random() < 0.3;
						const colour = Math.floor(random() * 0xffffff);
						for (let i = 0; i < w * h; i++)
							pixels.writeUInt32LE(noisy ? Math.floor(random() * 0xffffff) : colour, i * 4);
						parts.push(head, pixels);
					}
					if (random() < 0.1) {
						// A pointer shape (encoding -239): its pixels and its mask.
						const head = Buffer.alloc(12);
						head.writeUInt16BE(2, 0);
						head.writeUInt16BE(2, 2);
						head.writeUInt16BE(16, 4);
						head.writeUInt16BE(16, 6);
						head.writeInt32BE(-239, 8);
						parts.push(head, Buffer.alloc(16 * 16 * 4, 0x7f), Buffer.alloc(2 * 16, 0xff));
					}
					const update = Buffer.alloc(4);
					update.writeUInt16BE(parts.length / 2, 2);
					stdout(Buffer.concat([update, ...parts]));
				};
				void (async () => {
					for await (const message of stdin) {
						held = Buffer.concat([held, Buffer.from(message)]);
						for (;;) {
							if (stage === 0) {
								if (held.length < 12) break;
								held = held.subarray(12);
								stage = 1;
								continue;
							}
							if (stage === 1 || stage === 2) {
								if (held.length < 1) break;
								held = held.subarray(1);
								stage++;
								continue;
							}
							if (held.length < 1) break;
							const type = held[0];
							const size =
								type === 0
									? 20
									: type === 2
										? held.length >= 4
											? 4 + 4 * held.readUInt16BE(2)
											: 1e9
										: type === 3
											? 10
											: 1e9;
							if (held.length < size) break;
							held = held.subarray(size);
							if (type === 3) setTimeout(answer, Math.floor(random() * 20));
						}
					}
				})();
			});
	},
});
