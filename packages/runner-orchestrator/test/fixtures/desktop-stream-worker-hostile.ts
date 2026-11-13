import { parentPort, workerData } from "node:worker_threads";

// A desktop stream worker that breaks the protocol on purpose, as its spec's name says: the main side must end it at
// its bound and end every member's stream, whatever it does.
//   flood    sends messages for a member that has no released cycle
//   chatter  answers with a hundred thousand pongs at once
//   die      exits soon after its first member
//   oom      fills its heap with small objects until it is out of memory
//   silent   stops answering anything (a loop that never yields)
//   hoard    keeps buffers outside its heap (which resourceLimits do not cap), 8 MiB a turn, answering pings all along
const port = parentPort;
if (!port) throw new Error("not a worker");
const behaviour = (workerData as { spec: { name: string } }).spec.name;
port.on("message", (message: { t?: string; m?: number }) => {
	if (message.t === "ping" && behaviour !== "silent") port.postMessage({ t: "pong" });
	if (message.t !== "watch") return;
	if (behaviour === "flood")
		for (let n = 0; n < 10_000; n++) {
			const bytes = new ArrayBuffer(8);
			new Uint8Array(bytes)[0] = 2;
			port.postMessage({ t: "send", m: message.m, b: bytes }, [bytes]);
		}
	if (behaviour === "chatter") for (let n = 0; n < 100_000; n++) port.postMessage({ t: "pong" });
	if (behaviour === "die") setTimeout(() => process.exit(3), 50);
	if (behaviour === "oom") {
		const kept: { n: number; next: unknown }[] = [];
		const fill = () => {
			for (let n = 0; n < 200_000; n++) kept.push({ n, next: kept[kept.length - 1] });
			setImmediate(fill);
		};
		fill();
	}
	if (behaviour === "hoard") {
		const kept: Buffer[] = [];
		const hoard = () => {
			kept.push(Buffer.alloc(8 * 1024 * 1024, 1));
			setImmediate(hoard);
		};
		hoard();
	}
	if (behaviour === "silent")
		setTimeout(() => {
			for (;;) {}
		}, 10);
});
