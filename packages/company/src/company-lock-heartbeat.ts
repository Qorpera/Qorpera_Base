import { readFileSync, utimesSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const data = workerData as { path: string; token: string; intervalMs: number };
const timer = setInterval(() => {
	try {
		const record = JSON.parse(readFileSync(data.path, "utf-8")) as { token?: unknown };
		if (record.token !== data.token) process.exit(0);
		const now = new Date();
		utimesSync(data.path, now, now);
	} catch {
		process.exit(0);
	}
}, data.intervalMs);
timer.unref();

parentPort?.once("message", () => {
	clearInterval(timer);
	process.exit(0);
});
