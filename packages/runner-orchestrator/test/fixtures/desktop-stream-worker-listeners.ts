import { writeFileSync } from "node:fs";
import { connect } from "node:net";

// The tcp fixture's worker (its spec's name is `<port>:<file>`), counting the abort listeners it holds: added minus
// removed, written to the file every 100 ms. A worker that left one behind every release cycle (review r11 of #1746)
// would hold one more for every cycle; the member's signal lives as long as its stream.
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
const { runDesktopStreamWorker } = await import("../../src/company-machine-stream-worker.ts");
runDesktopStreamWorker((spec) => {
	const [port, file] = spec.name.split(/:(.*)/s) as [string, string];
	setInterval(() => writeFileSync(file, String(held)), 100).unref();
	return (stdout, stdin, signal) =>
		new Promise<number>((resolve) => {
			const socket = connect(Number(port), "127.0.0.1");
			socket.on("data", (chunk: Buffer) => stdout(chunk));
			socket.on("close", () => resolve(96));
			socket.on("error", () => resolve(96));
			signal.addEventListener("abort", () => socket.destroy(), { once: true });
			void (async () => {
				for await (const message of stdin) if (!socket.destroyed) socket.write(message);
			})();
		});
});
