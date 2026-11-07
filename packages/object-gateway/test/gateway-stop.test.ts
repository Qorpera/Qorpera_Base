import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopGateway } from "../src/gateway-stop.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication, type ObjectReplicationAuthority } from "../src/replication.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const bytes = Buffer.from("stop fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A real server, journal and store, with one answered upload whose audit line waits in memory. */
async function gateway() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-gateway-stop-"));
	roots.push(root);
	const journal = new ObjectGatewayJournal(join(root, "state"));
	const replication = new ObjectGatewayReplication(
		journal,
		new FileSystemObjectStore(join(root, "objects")),
		{} as ObjectReplicationAuthority,
	);
	await replication.uploadWithAuthority(profileId, sha256, bytes, {
		authorize: async () => undefined,
		confirm: async () => undefined,
	});
	const server = createServer((_request, response) => response.end());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { root, journal, replication, server };
}

/** Runs the stop with the gateway's own parts; resolves with what it said and the code it exited with. */
function stop(at: Awaited<ReturnType<typeof gateway>>, flush: () => Promise<void>, flushMs?: number) {
	const said: string[] = [];
	return new Promise<{ code: number; said: string[] }>((resolve) => {
		stopGateway({
			close: (done) => at.server.close(done),
			flush,
			say: (line) => said.push(line),
			exit: (code) => resolve({ code, said }),
			...(flushMs === undefined ? {} : { flushMs }),
		});
	});
}

describe("the gateway's clean stop", () => {
	it("closes the server, writes the audit lines waiting and exits", async () => {
		const at = await gateway();
		await expect(stop(at, () => at.replication.flushStoredLines())).resolves.toEqual({ code: 0, said: [] });
		expect(at.server.listening).toBe(false);
		expect(await readFile(join(at.root, "state", "audit.jsonl"), "utf-8")).toContain(
			"object_stored_replication_pending",
		);
	});

	it("waits for a write already going when it finds no lines left", async () => {
		const at = await gateway();
		const write = at.journal.audit.bind(at.journal);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(at.journal, "audit").mockImplementationOnce(async (...events) => {
			await held;
			await write(...events);
		});
		const going = at.replication.flushStoredLines();
		let exited = false;
		const stopped = stop(at, () => at.replication.flushStoredLines()).then((result) => {
			exited = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(exited).toBe(false);
		release();
		await going;
		await expect(stopped).resolves.toEqual({ code: 0, said: [] });
		expect(await readFile(join(at.root, "state", "audit.jsonl"), "utf-8")).toContain(
			"object_stored_replication_pending",
		);
	});

	it("says so and still exits when the audit refuses", async () => {
		const at = await gateway();
		vi.spyOn(at.journal, "audit").mockRejectedValue(new Error("Gateway audit capacity requires operator attention"));
		await expect(stop(at, () => at.replication.flushStoredLines())).resolves.toEqual({
			code: 0,
			said: ["Object gateway audit lines were not written at stop\n"],
		});
	});

	// A promise that never settles and a stub exit: a call truly hung also holds Node's real exit, until the unit's kill.
	it("says so and calls exit at its bound when the flush never settles", async () => {
		const at = await gateway();
		vi.spyOn(at.journal, "audit").mockImplementation(() => new Promise<void>(() => {}));
		const started = Date.now();
		await expect(stop(at, () => at.replication.flushStoredLines(), 30)).resolves.toEqual({
			code: 0,
			said: ["Object gateway audit lines were not written at stop\n"],
		});
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
