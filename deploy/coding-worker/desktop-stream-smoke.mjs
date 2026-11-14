// The desktop-stream units' smoke, run by the release right after it installs them on a node, as the executor's
// account, with no desktop and no member (README, "Each watched desktop in a process of its own"):
//   node desktop-stream-smoke.mjs <socket> <the program file the executor's loaded ExecStart names>
// Two connections, two HELLOs: one of another version must be refused (ENDED "another program version", closed); one of
// that file's version, for a machine that does not exist, must be taken (READY), then ended when its relay fails
// (ENDED, closed). One line a step, then STREAM UNITS SMOKE OK (exit 0) or one cause line (exit 1); 20 s at the most.
// Nothing is left behind: each instance ends with its connection. Plain node, no dependency.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

const [socket, program] = process.argv.slice(2);
const fail = (cause) => {
	console.log(`STREAM UNITS SMOKE FAILED: ${cause}`);
	process.exit(1);
};
if (!socket || !program) fail("usage: node desktop-stream-smoke.mjs <socket> <program file>");
setTimeout(() => fail("no answer within 20 s"), 20_000).unref();
const frame = (type, member, payload = Buffer.alloc(0)) => {
	const head = Buffer.alloc(9);
	head.writeUInt32BE(payload.length, 0);
	head[4] = type;
	head.writeUInt32BE(member, 5);
	return Buffer.concat([head, payload]);
};
const HELLO = 1, WATCH = 2, READY = 16, ENDED = 20;
const spec = { project: "default", name: "qorpera-desktop-stream-smoke-no-such-machine", command: ["/bin/true"], maxStdoutBytes: 65536 };
/** One connection: HELLO with `version` (and WATCH once READY); answers what came, in order, when it closes. */
const run = (version) =>
	new Promise((resolve) => {
		const seen = [];
		let held = Buffer.alloc(0);
		const conn = connect(socket);
		conn.on("error", (error) => resolve({ seen, error: error.code ?? error.message }));
		conn.on("close", () => resolve({ seen }));
		conn.on("connect", () => conn.write(frame(HELLO, 0, Buffer.from(JSON.stringify({ protocol: 1, version, spec })))));
		conn.on("data", (piece) => {
			held = Buffer.concat([held, piece]);
			while (held.length >= 9 && held.length >= 9 + held.readUInt32BE(0)) {
				const type = held[4];
				const payload = held.subarray(9, 9 + held.readUInt32BE(0)).toString("latin1");
				held = held.subarray(9 + held.readUInt32BE(0));
				seen.push({ type, payload });
				// Taken: a member watches, which starts its relay (to a machine that is not there).
				if (type === READY) conn.write(frame(WATCH, 1));
				if (type === ENDED) conn.end();
			}
		});
	});
const ended = (seen) => seen.find((one) => one.type === ENDED)?.payload.replace("\n", " (") ?? "";

const own = createHash("sha256").update(readFileSync(program)).digest("hex");
const other = await run("0".repeat(64));
if (other.error) fail(`cannot reach ${socket}: ${other.error}`);
if (!ended(other.seen).startsWith("STREAM_UNAVAILABLE (another program version"))
	fail(`step 1: a HELLO of another version was not refused (${other.seen.map((one) => one.type).join(",") || "nothing"})`);
console.log(`step 1: another version refused: ENDED ${ended(other.seen)}), closed`);
const mine = await run(own);
if (mine.error) fail(`cannot reach ${socket}: ${mine.error}`);
if (!mine.seen.some((one) => one.type === READY)) {
	const why = ended(mine.seen);
	fail(why.startsWith("STREAM_UNAVAILABLE (another program version")
		? `step 2: the instance runs another program than ${program}: the stream unit's ExecStart and the executor's must name one file`
		: `step 2: no READY (${why || "closed without a word"})`);
}
console.log("step 2: its own version taken: READY");
if (!ended(mine.seen)) fail("step 2: closed without ENDED after its relay failed");
console.log(`step 2: its relay to a machine that is not there ended it: ENDED ${ended(mine.seen)}), closed`);
console.log("STREAM UNITS SMOKE OK");
process.exit(0);
