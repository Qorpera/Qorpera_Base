import { RFB_VERSION } from "../../src/company-machine-stream.ts";
import { runDesktopStreamWorker } from "../../src/company-machine-stream-worker.ts";

// Review r11 of #1746: a desktop that sends a whole 3840 x 2160 update ONE BYTE AT A TIME, as a guest can through the
// relay (which flushes every recv, and LXD hands each over as its own message). The real worker and the real
// DesktopStream read it; the test watches the executor's main loop meanwhile.
runDesktopStreamWorker(() => (stdout, _stdin, signal) => {
	const init = Buffer.alloc(30);
	init.writeUInt16BE(3840, 0);
	init.writeUInt16BE(2160, 2);
	init.writeUInt32BE(6, 20);
	init.write("Xvnc:1", 24, "latin1");
	for (const part of [RFB_VERSION, Buffer.from([1, 1]), Buffer.alloc(4), init]) stdout(Buffer.from(part));
	const head = Buffer.alloc(16);
	head.writeUInt16BE(1, 2);
	head.writeUInt16BE(3840, 8);
	head.writeUInt16BE(2160, 10);
	const total = 16 + 3840 * 2160 * 4;
	let sent = 0;
	return new Promise<number>((resolve) => {
		signal.addEventListener("abort", () => resolve(137), { once: true });
		const more = () => {
			if (signal.aborted) return;
			// As fast as it can, a byte a piece: 20,000 pieces a turn of its own loop.
			for (let n = 0; n < 20_000 && sent < total; n++, sent++)
				stdout(Buffer.from([sent < 16 ? (head[sent] as number) : sent & 0xff]));
			if (sent < total) setImmediate(more);
		};
		setImmediate(more);
	});
});
