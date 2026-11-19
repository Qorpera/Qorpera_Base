import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { createMemberCors } from "../src/member-cors.ts";
import { forgetMemberProgramUploads, serveMemberProgramUpload } from "../src/member-program-uploads.ts";

const environmentId = "35000000-0000-4000-8000-000000000020";
const profileId = "35000000-0000-4000-8000-000000000010";
const userId = "35000000-0000-4000-8000-000000000001";
const otherUser = "35000000-0000-4000-8000-000000000002";
const memberToken = "synthetic-member-jwt";
const otherToken = "synthetic-other-jwt";
const path = "apps/lagerliste/versions/1/Lagerliste-1.0-setup.exe";
const MiB = 1024 * 1024;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const servers: Server[] = [];

afterEach(async () => {
	forgetMemberProgramUploads();
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

type Entry = { fileSha256: string; bytes: number; kind?: "file" | "folder" };

async function gateway(
	options: {
		member?: (token: string) => unknown;
		present?: string[];
		folder?: Map<string, Entry>;
		write?: () => Record<string, unknown>;
		renewRefused?: boolean;
		commitHold?: Promise<unknown>;
	} = {},
) {
	forgetMemberProgramUploads();
	const folder = options.folder ?? new Map<string, Entry>();
	const calls: { side: "member" | "publisher"; method: string; args: Record<string, unknown>; token?: string }[] = [];
	const stored = new Map<string, Uint8Array>();
	const manifests = new Map<string, string>();
	let intents = 0;
	let clock = Date.parse("2026-11-18T12:00:00Z");
	const authority = {
		async member(method: string, token: string, args: Record<string, unknown>) {
			calls.push({ side: "member", method, args, token });
			if (method === "qorpera_member_folder_read") {
				const entry = folder.get(args.p_path as string);
				const fileKeys = (found: Entry) => ({
					manifestSha256: "c".repeat(64),
					fileSha256: found.fileSha256,
					bytes: found.bytes,
					mediaType: "application/octet-stream",
					executable: false,
				});
				return {
					schema: "qorpera.folder-read/v1",
					asOfSeq: 9,
					found: entry !== undefined,
					entry: entry
						? {
								path: args.p_path,
								kind: entry.kind ?? "file",
								version: "35000000-0000-4000-8000-0000000000e1",
								seq: 9,
								updatedAt: "2026-11-18T12:00:00Z",
								...(entry.kind === "folder" ? {} : fileKeys(entry)),
							}
						: null,
				};
			}
			if (options.member) return options.member(token);
			if (token !== memberToken && token !== otherToken) throw new ObjectDependencyError(403);
			return {
				schema: "qorpera.member-folder-writer/v1",
				actor: { kind: "member", userId: token === memberToken ? userId : otherUser },
				profileId,
			};
		},
		async publisher(method: string, args: Record<string, unknown>) {
			calls.push({ side: "publisher", method, args });
			switch (method) {
				case "qorpera_folder_open_upload": {
					const intentId = `35000000-0000-4000-8000-${String(++intents).padStart(12, "0")}`;
					manifests.set(intentId, args.p_manifest as string);
					return {
						schema: "qorpera.folder-upload/v1",
						intentId,
						manifestSha256: digest(args.p_manifest as string),
						expiresAt: "x",
						present: options.present ?? [],
					};
				}
				case "qorpera_folder_authorize_object_upload":
					return { schema: "qorpera.folder-object-upload/v1", profileId };
				case "qorpera_folder_confirm_object":
					return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes, stored: true };
				case "qorpera_folder_renew_upload":
					if (options.renewRefused) throw new ObjectDependencyError(403);
					return {
						schema: "qorpera.folder-upload-renew/v1",
						intentId: args.p_intent,
						state: "open",
						expiresAt: "y",
					};
				case "qorpera_folder_seal_upload": {
					const manifest = JSON.parse(manifests.get(args.p_intent as string) as string);
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId: args.p_intent,
						file: {
							manifestSha256: digest(manifests.get(args.p_intent as string) as string),
							fileSha256: manifest.fileSha256,
							bytes: manifest.bytes,
							mediaType: manifest.mediaType,
							executable: manifest.executable,
						},
					};
				}
				case "qorpera_folder_commit":
					await options.commitHold;
					return {
						schema: "qorpera.folder-commit/v1",
						commitId: "35000000-0000-4000-8000-0000000000c1",
						seq: 9,
						replay: false,
						units: (args.p_units as { op: string; path: string }[]).map((unit, index) => ({
							unit: index + 1,
							op: unit.op,
							path: unit.path,
							...(unit.op === "mkdir" && index < 2
								? { outcome: "conflict", reason: "exists" }
								: unit.op === "write" && options.write
									? options.write()
									: { outcome: "saved", version: "35000000-0000-4000-8000-0000000000e2" }),
						})),
					};
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	const replication = {
		async uploadWithAuthority(
			profile: string,
			hash: string,
			bytes: Uint8Array,
			callbacks: { authorize(): Promise<void>; confirm(): Promise<void> },
		) {
			expect(profile).toBe(profileId);
			expect(digest(bytes)).toBe(hash);
			await callbacks.authorize();
			stored.set(hash, bytes);
			await callbacks.confirm();
			return "stored" as const;
		},
	};
	const cors = createMemberCors(["https://app.qorpera.com"]);
	const server = createServer((request, response) => {
		if (cors(request, response)) return;
		serveMemberProgramUpload(request, response, {
			authority: authority as never,
			replication,
			now: () => clock,
		}).catch((error: unknown) => {
			response.writeHead(error instanceof ObjectDependencyError ? error.status : 500);
			response.end();
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	const base = `http://127.0.0.1:${port}/v1/member-program-uploads/${environmentId}`;
	const post = (at: string, body: unknown, token = memberToken) =>
		fetch(at, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const open = (file: ReturnType<typeof program>, at = path, token = memberToken) =>
		post(
			base,
			{
				schema: "qorpera.member-program-upload/v1",
				path: at,
				bytes: file.bytes.length,
				fileSha256: file.fileSha256,
				pieces: file.pieces.map((piece) => digest(piece)),
			},
			token,
		);
	const piece = (upload: string, index: number, bytes: Uint8Array, token = memberToken) =>
		fetch(`${base}/${upload}/${index}`, {
			method: "PUT",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
			body: bytes,
		});
	const finish = (upload: string, token = memberToken) =>
		post(`${base}/${upload}`, { schema: "qorpera.member-program-finish/v1", operationKey: "web:add-1" }, token);
	const stop = (upload: string) => post(`${base}/${upload}/stop`, {});
	const methods = () => calls.map((call) => call.method);
	return {
		calls,
		stored,
		base,
		open,
		piece,
		finish,
		stop,
		methods,
		later: (ms: number) => {
			clock += ms;
		},
	};
}

function program(size: number) {
	const bytes = randomBytes(size);
	const pieces: Uint8Array[] = [];
	for (let start = 0; start < size; start += 4 * MiB) pieces.push(bytes.subarray(start, start + 4 * MiB));
	return { bytes, pieces, fileSha256: digest(bytes) };
}

const uploadOf = async (response: Response) => {
	expect(response.status).toBe(200);
	return ((await response.json()) as { uploadId: string; have: number[] }).uploadId;
};

describe("a member's program file put into the company's place for programs", () => {
	it("stages each piece as the member, checks the whole, and commits the file at its path as the member", async () => {
		const g = await gateway();
		const file = program(9 * MiB + 17);
		const upload = await uploadOf(await g.open(file));
		for (const index of [1, 0, 2]) expect((await g.piece(upload, index, file.pieces[index]!)).status).toBe(200);
		const answer = await g.finish(upload);
		expect(answer.status).toBe(200);
		expect(await answer.json()).toEqual({
			schema: "qorpera.member-program-finish/v1",
			outcome: "saved",
			version: "35000000-0000-4000-8000-0000000000e2",
		});
		expect(g.calls.filter((call) => call.side === "member").at(-1)).toMatchObject({
			method: "qorpera_member_folder_read",
			args: { p_environment_id: environmentId, p_path: path },
			token: memberToken,
		});
		expect(g.calls.filter((call) => call.side === "member").map((call) => call.token)).toEqual(
			Array(6).fill(memberToken),
		);
		for (const call of g.calls.filter((each) => each.side === "publisher"))
			expect(call.args.p_actor).toEqual({ kind: "member", userId });
		const manifest = g.calls.find((call) => call.method === "qorpera_folder_open_upload")?.args.p_manifest as string;
		expect(JSON.parse(manifest)).toEqual({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: file.fileSha256,
			bytes: file.bytes.length,
			mediaType: "application/octet-stream",
			executable: false,
			chunks: file.pieces.map((piece) => ({ sha256: digest(piece), bytes: piece.length })),
		});
		expect([...g.stored.keys()].sort()).toEqual([digest(manifest), ...file.pieces.map(digest)].sort());
		const commit = g.calls.find((call) => call.method === "qorpera_folder_commit");
		expect(commit?.args.p_operation_key).toBe(`member:${userId}:web:add-1`);
		expect(commit?.args.p_units).toEqual([
			{ op: "mkdir", path: "apps" },
			{ op: "mkdir", path: "apps/lagerliste" },
			{ op: "mkdir", path: "apps/lagerliste/versions" },
			{ op: "mkdir", path: "apps/lagerliste/versions/1" },
			{
				op: "write",
				path,
				file: {
					manifestSha256: digest(manifest),
					fileSha256: file.fileSha256,
					bytes: file.bytes.length,
					mediaType: "application/octet-stream",
					executable: false,
				},
			},
		]);
		expect(g.methods().indexOf("qorpera_folder_seal_upload")).toBeLessThan(
			g.methods().indexOf("qorpera_folder_commit"),
		);
		const again = await g.finish(upload);
		expect(again.status).toBe(200);
		expect(
			g.calls.filter((call) => call.method === "qorpera_folder_commit").map((call) => call.args.p_operation_key),
		).toEqual([`member:${userId}:web:add-1`, `member:${userId}:web:add-1`]);
	});

	it("puts a file only where none is: another file there is refused unsaved, the same file is answered as saved", async () => {
		const file = program(10);
		const finished = async (entry: Entry | undefined, write?: () => Record<string, unknown>) => {
			const g = await gateway({
				folder: new Map<string, Entry>(entry ? [[path, entry]] : []),
				...(write ? { write } : {}),
			});
			const upload = await uploadOf(await g.open(file));
			expect((await g.piece(upload, 0, file.pieces[0]!)).status).toBe(200);
			const response = await g.finish(upload);
			expect(response.status).toBe(200);
			const answer = (await response.json()) as { outcome: string; version: string | null };
			return { g, answer, upload };
		};
		const other = await finished({ fileSha256: "d".repeat(64), bytes: 10 });
		expect(other.answer).toEqual({ schema: "qorpera.member-program-finish/v1", outcome: "exists", version: null });
		expect(other.g.methods()).not.toContain("qorpera_folder_commit");
		expect((await other.g.piece(other.upload, 0, file.pieces[0]!)).status).toBe(404);
		const folderThere = await finished({ fileSha256: "", bytes: 0, kind: "folder" });
		expect(folderThere.answer.outcome).toBe("exists");
		const same = await finished({ fileSha256: file.fileSha256, bytes: 10 });
		expect(same.answer).toEqual({
			schema: "qorpera.member-program-finish/v1",
			outcome: "saved",
			version: "35000000-0000-4000-8000-0000000000e1",
		});
		expect(same.g.methods()).not.toContain("qorpera_folder_commit");
		const absent = await finished(undefined);
		expect(absent.answer.outcome).toBe("saved");
		expect(absent.g.methods()).toContain("qorpera_folder_commit");
	});

	it("answers the core's own refusal of the write, and reads again when another file landed meanwhile", async () => {
		const file = program(10);
		for (const [write, outcome] of [
			[() => ({ outcome: "denied", reason: "denied" }), "denied"],
			[() => ({ outcome: "refused", reason: "invalid" }), "refused"],
			[() => ({ outcome: "conflict", reason: "exists" }), "conflict"],
		] as const) {
			const g = await gateway({ write });
			const upload = await uploadOf(await g.open(file));
			await g.piece(upload, 0, file.pieces[0]!);
			const answer = (await (await g.finish(upload)).json()) as { outcome: string; reason?: string };
			expect(answer.outcome).toBe(outcome);
			expect(answer.reason).toBe(write().reason);
		}
		const folder = new Map<string, Entry>();
		const g = await gateway({
			folder,
			write: () => {
				folder.set(path, { fileSha256: file.fileSha256, bytes: 10 });
				return { outcome: "conflict", reason: "exists" };
			},
		});
		const upload = await uploadOf(await g.open(file));
		await g.piece(upload, 0, file.pieces[0]!);
		expect(((await (await g.finish(upload)).json()) as { outcome: string }).outcome).toBe("saved");
	});

	it("keeps an upload whose finish is running through the member's stop, so a retried finish still answers", async () => {
		const file = program(10);
		let release = () => {};
		const g = await gateway({
			commitHold: new Promise<void>((resolve) => {
				release = resolve;
			}),
		});
		const upload = await uploadOf(await g.open(file));
		expect((await g.piece(upload, 0, file.pieces[0]!)).status).toBe(200);
		const finishing = g.finish(upload);
		for (let n = 0; n < 200 && !g.methods().includes("qorpera_folder_commit"); n++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect((await g.stop(upload)).status).toBe(204);
		release();
		expect(((await (await finishing).json()) as { outcome: string }).outcome).toBe("saved");
		expect(((await (await g.finish(upload)).json()) as { outcome: string }).outcome).toBe("saved");
		const fresh = await uploadOf(await g.open(program(10)));
		expect((await g.stop(fresh)).status).toBe(204);
		expect((await g.piece(fresh, 0, randomBytes(10))).status).toBe(404);
	});

	it("takes bytes for no other folder path, refused before anyone is asked", async () => {
		const g = await gateway();
		const file = program(10);
		for (const at of [
			"apps/lagerliste/index.html",
			"apps/lagerliste/app.toml",
			"apps/lagerliste/versions/1/sub/Lagerliste.exe",
			"apps/Lagerliste/versions/1/Lagerliste.exe",
			"apps/lagerliste/versions/../Lagerliste.exe",
			'apps/lagerliste/versions/1/Lager"liste.exe',
			"QorperaOS/agents/nora/agent.md",
			"code/product/main/Lagerliste.exe",
		]) {
			const response = await g.open(file, at);
			expect([400, 403]).toContain(response.status);
		}
		expect(g.calls).toEqual([]);
	});

	it("refuses a file past 256 MiB, a piece of another size, and before any byte is staged", async () => {
		const g = await gateway();
		const response = await fetch(g.base, {
			method: "POST",
			headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.member-program-upload/v1",
				path,
				bytes: 256 * MiB + 1,
				fileSha256: "a".repeat(64),
				pieces: Array(65).fill("b".repeat(64)),
			}),
		});
		expect(response.status).toBe(413);
		expect(g.calls).toEqual([]);
		const file = program(5 * MiB);
		const upload = await uploadOf(await g.open(file));
		const staged = g.stored.size;
		expect((await g.piece(upload, 0, randomBytes(10))).status).toBe(400);
		expect((await g.piece(upload, 1, randomBytes(10))).status).toBe(400);
		expect((await g.piece(upload, 2, randomBytes(10))).status).toBe(404);
		expect(g.stored.size).toBe(staged);
	});

	it("refuses a piece that is not its hash, and a whole that is not the hash the member named", async () => {
		const g = await gateway();
		const file = program(10);
		const upload = await uploadOf(await g.open(file));
		expect((await g.piece(upload, 0, randomBytes(10))).status).toBe(400);
		const named = { ...program(10) };
		const lying = { bytes: named.bytes, pieces: named.pieces, fileSha256: "f".repeat(64) };
		expect((await g.stop(upload)).status).toBe(204);
		const second = await uploadOf(await g.open(lying));
		expect((await g.piece(second, 0, named.pieces[0]!)).status).toBe(200);
		expect((await g.finish(second)).status).toBe(400);
		expect(g.methods()).not.toContain("qorpera_folder_seal_upload");
		expect(g.methods()).not.toContain("qorpera_folder_commit");
	});

	it("keeps one upload in flight per member: a second waits (429), the same file resumes, an idle one gives way", async () => {
		const g = await gateway();
		const first = program(9 * MiB);
		const upload = await uploadOf(await g.open(first));
		expect((await g.piece(upload, 0, first.pieces[0]!)).status).toBe(200);
		expect((await g.open(program(10))).status).toBe(429);
		expect((await g.open(program(10), path, otherToken)).status).toBe(200);
		const resumed = await g.open(first);
		expect(await resumed.json()).toEqual({ schema: "qorpera.member-program-upload/v1", uploadId: upload, have: [0] });
		expect((await g.piece(upload, 0, randomBytes(10), otherToken)).status).toBe(404);
		g.later(61_000);
		const next = await uploadOf(await g.open(program(10)));
		expect(next).not.toBe(upload);
		expect((await g.piece(upload, 1, randomBytes(10))).status).toBe(404);
	});

	it("leaves nothing in the folder for an upload not finished, stopped or too far ahead", async () => {
		const g = await gateway();
		const file = program(25 * MiB);
		const upload = await uploadOf(await g.open(file));
		expect((await g.piece(upload, 5, file.pieces[5]!)).status).toBe(409);
		expect((await g.piece(upload, 1, file.pieces[1]!)).status).toBe(200);
		expect((await g.finish(upload)).status).toBe(409);
		expect((await g.stop(upload)).status).toBe(204);
		expect((await g.piece(upload, 0, randomBytes(10))).status).toBe(404);
		expect((await g.finish(upload)).status).toBe(404);
		expect(g.methods()).not.toContain("qorpera_folder_seal_upload");
		expect(g.methods()).not.toContain("qorpera_folder_commit");
	});

	it("puts no object the member's intent already holds, and renews a long upload's intent", async () => {
		const file = program(6 * MiB);
		const g = await gateway({ present: [digest(file.pieces[0]!)] });
		const upload = await uploadOf(await g.open(file));
		expect((await g.piece(upload, 0, file.pieces[0]!)).status).toBe(200);
		expect(g.stored.has(digest(file.pieces[0]!))).toBe(false);
		for (let minute = 0; minute < 11; minute++) {
			g.later(59_000);
			expect(((await (await g.open(file)).json()) as { uploadId: string }).uploadId).toBe(upload);
		}
		expect((await g.piece(upload, 1, file.pieces[1]!)).status).toBe(200);
		expect(g.methods().filter((method) => method === "qorpera_folder_renew_upload")).toHaveLength(1);
		expect((await g.finish(upload)).status).toBe(200);
	});

	it("opens afresh instead of resuming an upload whose intent can have run out, and forgets one the core refused", async () => {
		const file = program(9 * MiB);
		const g = await gateway();
		const upload = await uploadOf(await g.open(file));
		expect((await g.piece(upload, 0, file.pieces[0]!)).status).toBe(200);
		for (let step = 0; step < 15; step++) {
			g.later(55_000);
			const resumed = (await (await g.open(file)).json()) as { uploadId: string };
			if (step < 14) expect(resumed.uploadId).toBe(upload);
			else expect(resumed.uploadId).not.toBe(upload);
		}
		expect(g.methods().filter((method) => method === "qorpera_folder_open_upload")).toHaveLength(2);
		const refused = await gateway({ renewRefused: true });
		const first = await uploadOf(await refused.open(file));
		for (let minute = 0; minute < 11; minute++) {
			refused.later(59_000);
			await refused.open(file);
		}
		expect((await refused.piece(first, 0, file.pieces[0]!)).status).toBe(403);
		expect((await refused.piece(first, 1, randomBytes(10))).status).toBe(404);
		const again = await uploadOf(await refused.open(file));
		expect(again).not.toBe(first);
	});

	it("forgets an upload nobody touched for a minute at the next request of anyone, with the pieces it held", async () => {
		const file = program(9 * MiB);
		const g = await gateway();
		const upload = await uploadOf(await g.open(file));
		expect((await g.piece(upload, 1, file.pieces[1]!)).status).toBe(200);
		g.later(61_000);
		expect((await g.open(program(10), path, otherToken)).status).toBe(200);
		expect((await g.piece(upload, 0, randomBytes(10))).status).toBe(404);
	});

	it("answers the writer check's refusals: signed out, not a member, a paused company", async () => {
		for (const [status, error] of [
			[403, new ObjectDependencyError(403)],
			[423, new ObjectDependencyError(423)],
		] as const) {
			const g = await gateway({
				member: () => {
					throw error;
				},
			});
			expect((await g.open(program(10))).status).toBe(status);
			expect(g.calls.filter((call) => call.side === "publisher")).toEqual([]);
		}
		const g = await gateway();
		const unsigned = await fetch(g.base, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(unsigned.status).toBe(401);
		expect((await fetch(`${g.base}/${userId}/0`, { method: "POST" })).status).toBe(405);
	});

	it("answers its browser preflights: POST for the steps, PUT for a piece", async () => {
		const g = await gateway();
		for (const [at, method] of [
			[g.base, "POST"],
			[`${g.base}/${userId}`, "POST"],
			[`${g.base}/${userId}/stop`, "POST"],
			[`${g.base}/${userId}/63`, "PUT"],
		] as const) {
			const response = await fetch(at, {
				method: "OPTIONS",
				headers: {
					origin: "https://app.qorpera.com",
					"access-control-request-method": method,
					"access-control-request-headers": "authorization, content-type",
				},
			});
			expect(response.status).toBe(204);
			expect(response.headers.get("access-control-allow-methods")).toBe(method);
		}
	});
});
