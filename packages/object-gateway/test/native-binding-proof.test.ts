import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectGatewayJournal } from "../src/journal.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

// G2-6a: a native host's request on the folder route proves its run's lease (x-qorpera-identity:
// job.<job id>.<lease token>) before the gateway asks anything else about its binding.
const companyId = "32000000-0000-4000-8000-000000000010";
const environmentId = "32000000-0000-4000-8000-000000000020";
const jobId = "32000000-0000-4000-8000-0000000abc03";
const leaseToken = "L".repeat(43);
const holder = `job.${jobId}.${leaseToken}`;
const binding = Buffer.from(
	JSON.stringify({
		leaseId: "32000000-0000-4000-8000-000000000101",
		runId: "32000000-0000-4000-8000-000000000102",
		jobId,
		runnerId: "32000000-0000-4000-8000-000000000104",
		assignmentId: "32000000-0000-4000-8000-000000000105",
		credentialCapsuleId: "32000000-0000-4000-8000-000000000106",
		computeIdentityId: "32000000-0000-4000-8000-000000000107",
		provider: "openai",
		nativeHarness: "codex-cli",
		model: "gpt-synthetic",
	}),
).toString("base64url");
const bytes = Buffer.from("object");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-binding-proof-"));
	await mkdir(join(root, "objects"), { mode: 0o700 });
	const store = new FileSystemObjectStore(join(root, "objects"));
	await store.put(companyId, sha256, bytes);
	const nativeToken = randomBytes(32).toString("base64url");
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "sb_publishable_fixture",
		secretKey: "sb_secret_fixture",
		requestTimeoutMs: 1_000,
		circuitCooldownMs: 0,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const name = new URL(request.url).pathname.split("/").at(-1)!;
			const args = (await request.json()) as Record<string, unknown>;
			calls.push({ name, args });
			// The database's proof: only this run's own lease token holds.
			if (name === "qorpera_native_binding_proven")
				return args.p_holder === holder
					? Response.json(true)
					: Response.json({ code: "42501", message: "native binding proof is refused" }, { status: 403 });
			if (name === "qorpera_folder_authorize_object_download")
				return Response.json({
					schema: "qorpera.folder-object-download/v1",
					profileId: companyId,
					bytes: bytes.length,
				});
			return Response.json({ code: "42883" }, { status: 404 });
		},
	});
	const replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(root, "journal")), store, authority);
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			replication,
			controlToken: "synthetic-control",
			nativeObjects: { token: nativeToken, folder: authority },
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${address.port}`;
	const read = (identity: string | undefined) =>
		fetch(`${origin}/v1/folder-objects/${environmentId}/${sha256}`, {
			headers: {
				authorization: `Bearer ${nativeToken}`,
				"x-qorpera-native-binding": binding,
				...(identity === undefined ? {} : { "x-qorpera-identity": identity }),
			},
		});
	return { calls, read };
}

describe("the folder route's lease proof", () => {
	it("serves a run's object only after its own lease proves the binding", async () => {
		const { calls, read } = await fixture();
		const served = await read(holder);
		expect(served.status).toBe(200);
		expect(Buffer.from(await served.arrayBuffer()).toString()).toBe("object");
		// The proof comes first, with the binding the request carries and the holder it sent.
		expect(calls[0]).toMatchObject({ name: "qorpera_native_binding_proven", args: { p_holder: holder } });
		expect((calls[0]!.args.p_binding as Record<string, unknown>).jobId).toBe(jobId);
		expect(calls.length).toBeGreaterThan(1);
	});

	it("refuses without the run's own lease, before any other check", async () => {
		const { calls, read } = await fixture();
		// No holder, or a malformed one: refused before the database is asked anything.
		for (const identity of [
			undefined,
			"",
			leaseToken,
			`identity.${leaseToken}`,
			`job.${jobId.toUpperCase()}.${leaseToken}`,
			`${holder}x`,
		]) {
			const response = await read(identity);
			expect(response.status).toBe(401);
			expect(await response.text()).not.toContain(leaseToken);
		}
		expect(calls).toEqual([]);
		// Another run's lease token, or this token for another job: the proof refuses, and nothing else is asked.
		for (const identity of [
			`job.${jobId}.${"W".repeat(43)}`,
			`job.32000000-0000-4000-8000-0000000000ff.${leaseToken}`,
		]) {
			const response = await read(identity);
			expect(response.status).toBe(403);
			expect(await response.text()).not.toContain(leaseToken);
		}
		expect(calls.map((call) => call.name)).toEqual([
			"qorpera_native_binding_proven",
			"qorpera_native_binding_proven",
		]);
	});
});
