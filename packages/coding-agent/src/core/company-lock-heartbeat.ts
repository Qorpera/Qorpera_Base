import { readFileSync, utimesSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

interface HeartbeatOptions {
	path: string;
	token: string;
	intervalMs: number;
}

const options = workerData as HeartbeatOptions;

function heartbeat(): void {
	try {
		const record = JSON.parse(readFileSync(options.path, "utf-8")) as { token?: unknown };
		if (record.token !== options.token) {
			clearInterval(timer);
			return;
		}
		const now = new Date();
		utimesSync(options.path, now, now);
	} catch {
		clearInterval(timer);
	}
}

const timer = setInterval(heartbeat, options.intervalMs);
parentPort?.once("message", () => clearInterval(timer));
heartbeat();
