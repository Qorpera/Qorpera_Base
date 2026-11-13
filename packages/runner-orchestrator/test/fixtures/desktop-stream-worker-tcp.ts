import { connect } from "node:net";
import { runDesktopStreamWorker } from "../../src/company-machine-stream-worker.ts";

// A desktop stream worker whose relay is a TCP connection to a test's fake VNC server on the loopback (the spec's name
// is its port): the real worker, the real DesktopStream, only the transport is the test's. The server closing the
// connection is the relay ending as when the desktop ended (96).
runDesktopStreamWorker(
	(spec) => (stdout, stdin, signal) =>
		new Promise<number>((resolve, reject) => {
			const socket = connect(Number(spec.name), "127.0.0.1");
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
		}),
);
