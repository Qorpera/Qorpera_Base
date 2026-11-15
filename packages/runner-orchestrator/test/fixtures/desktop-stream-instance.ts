import { writeFileSync } from "node:fs";
import { connect, Socket } from "node:net";
import { RFB_VERSION } from "../../src/company-machine-stream.ts";
import { runDesktopStreamInstance } from "../../src/company-machine-stream-process.ts";

// The real instance (runDesktopStreamInstance: the real DesktopStream, the real frames, the real guard), started on a
// connection as its standard input, as systemd starts one; only its relay is the test's, by the spec's name:
//   tcp:<port>[:<file>]  a TCP connection to a test's fake VNC server; with a file, the abort listeners it holds
//                        (added minus removed) are written there every 100 ms
//   bytes                a whole 3840 x 2160 update ONE BYTE AT A TIME, as a guest can send it through the relay
//   spin                 its loop never returns once a member watches: only its guard can end it
let held = 0;
const add = EventTarget.prototype.addEventListener;
const remove = EventTarget.prototype.removeEventListener;
EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
	if (type === "abort") held++;
	return (add as (...args: unknown[]) => void).call(this, type, ...rest);
};
EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
	if (type === "abort") held--;
	return (remove as (...args: unknown[]) => void).call(this, type, ...rest);
};

runDesktopStreamInstance({
	connection: new Socket({ fd: 0, readable: true, writable: true }),
	version: "test-version",
	openRelay: (spec) => {
		const [mode, port, file] = spec.name.split(":") as [string, string?, string?];
		if (file) setInterval(() => writeFileSync(file, String(held)), 100).unref();
		if (mode === "spin")
			return () => {
				for (;;) {}
			};
		if (mode === "bytes")
			return (stdout, _stdin, signal) => {
				const init = Buffer.alloc(30);
				init.writeUInt16BE(3840, 0);
				init.writeUInt16BE(2160, 2);
				init.writeUInt32BE(6, 20);
				init.write("Xvnc:1", 24, "latin1");
				for (const part of [RFB_VERSION, Buffer.from([1, 1]), Buffer.alloc(4), init]) stdout(Buffer.from(part));
				const header = Buffer.alloc(16);
				header.writeUInt16BE(1, 2);
				header.writeUInt16BE(3840, 8);
				header.writeUInt16BE(2160, 10);
				const total = 16 + 3840 * 2160 * 4;
				let sent = 0;
				return new Promise<number>((resolve) => {
					signal.addEventListener("abort", () => resolve(137), { once: true });
					const more = () => {
						if (signal.aborted) return;
						for (let n = 0; n < 20_000 && sent < total; n++, sent++)
							stdout(Buffer.from([sent < 16 ? (header[sent] as number) : sent & 0xff]));
						if (sent < total) setImmediate(more);
					};
					setImmediate(more);
				});
			};
		return (stdout, stdin, signal) =>
			new Promise<number>((resolve, reject) => {
				const socket = connect(Number(port), "127.0.0.1");
				socket.on("data", (chunk: Buffer) => {
					try {
						stdout(chunk);
					} catch (error) {
						socket.destroy();
						reject(error);
					}
				});
				socket.on("close", () => resolve(96));
				socket.on("error", () => resolve(96));
				signal.addEventListener(
					"abort",
					() => {
						socket.destroy();
						resolve(137);
					},
					{ once: true },
				);
				void (async () => {
					for await (const message of stdin) if (!socket.destroyed) socket.write(message);
				})();
			});
	},
});
