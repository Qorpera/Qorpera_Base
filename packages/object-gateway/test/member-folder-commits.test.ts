import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeAgentFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { createMemberCors } from "../src/member-cors.ts";
import { followUpMemberCommit, serveMemberFolderCommit } from "../src/member-folder-commits.ts";

const environmentId = "34000000-0000-4000-8000-000000000020";
const profileId = "34000000-0000-4000-8000-000000000010";
const userId = "34000000-0000-4000-8000-000000000001";
const agentId = "34000000-0000-4000-8000-0000000000a1";
const version = "34000000-0000-4000-8000-0000000000b1";
const memberToken = "synthetic-member-jwt";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

const agentText = (name = "Nora") =>
	writeAgentFile({
		id: agentId,
		name,
		role: "Research",
		agentKind: "agent",
		status: "active",
		colour: null,
		figure: null,
		model: null,
		effort: null,
		instructions: "Find what matters.",
	});

/** The database and the store as the route sees them: every call recorded. */
async function gateway(
	options: {
		member?: () => unknown;
		commit?: () => unknown;
		followUp?: (call: number) => unknown;
		/** No follow-up client: the route makes no follow-up. */
		noFollowUps?: boolean;
	} = {},
) {
	let followUps = 0;
	const calls: { side: "member" | "publisher"; method: string; args: Record<string, unknown>; token?: string }[] = [];
	const stored = new Map<string, Uint8Array>();
	const manifests = new Map<string, string>();
	let intents = 0;
	const authority = {
		async member(method: string, token: string, args: Record<string, unknown>) {
			calls.push({ side: "member", method, args, token });
			if (token !== memberToken) throw new ObjectDependencyError(403);
			return options.member
				? options.member()
				: { schema: "qorpera.member-folder-writer/v1", actor: { kind: "member", userId }, profileId };
		},
		async publisher(method: string, args: Record<string, unknown>) {
			calls.push({ side: "publisher", method, args });
			switch (method) {
				case "qorpera_folder_open_upload": {
					const intentId = `34000000-0000-4000-8000-${String(++intents).padStart(12, "0")}`;
					manifests.set(intentId, args.p_manifest as string);
					return {
						schema: "qorpera.folder-upload/v1",
						intentId,
						manifestSha256: digest(args.p_manifest as string),
						expiresAt: "x",
						present: [],
					};
				}
				case "qorpera_folder_authorize_object_upload":
					return { schema: "qorpera.folder-object-upload/v1", profileId };
				case "qorpera_folder_confirm_object":
					return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes };
				case "qorpera_folder_seal_upload": {
					const manifest = manifests.get(args.p_intent as string) as string;
					const parsed = JSON.parse(manifest);
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId: args.p_intent,
						file: {
							manifestSha256: digest(manifest),
							fileSha256: parsed.fileSha256,
							bytes: parsed.bytes,
							mediaType: parsed.mediaType,
							executable: parsed.executable,
						},
					};
				}
				case "qorpera_folder_commit":
					return options.commit
						? options.commit()
						: {
								schema: "qorpera.folder-commit/v1",
								commitId: "34000000-0000-4000-8000-0000000000c1",
								seq: 9,
								replay: false,
								units: (args.p_units as unknown[]).map((_, n) => ({ unit: n + 1, outcome: "saved" })),
							};
				case "qorpera_folder_follow_up_commit":
					// Before P15 the function does not exist: PostgREST answers 404.
					if (!options.followUp) throw new ObjectDependencyError(404);
					return options.followUp(++followUps);
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
	const store = {
		async get(): Promise<Uint8Array> {
			throw new Error("Object not found");
		},
	};
	const server = createServer((request, response) => {
		serveMemberFolderCommit(request, response, {
			authority: authority as never,
			...(options.noFollowUps ? {} : { followUps: authority as never }),
			store,
			replication,
		}).catch((error: unknown) => {
			response.writeHead(error instanceof ObjectDependencyError ? error.status : 500);
			response.end();
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	const send = (body: unknown, init: { token?: string | null; method?: string; path?: string } = {}) => {
		const text = typeof body === "string" ? body : JSON.stringify(body);
		return fetch(`http://127.0.0.1:${port}${init.path ?? `/v1/member-folder-commits/${environmentId}`}`, {
			method: init.method ?? "POST",
			headers: {
				...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? memberToken}` }),
				"content-type": "application/json",
			},
			...((init.method ?? "POST") === "GET" ? {} : { body: text }),
		});
	};
	const commits = () => calls.filter((call) => call.method === "qorpera_folder_commit");
	const staged = () => calls.filter((call) => call.method === "qorpera_folder_open_upload");
	return { calls, stored, send, commits, staged };
}

const request = (units: unknown[], operationKey = "web:34000000-0000-4000-8000-0000000000d1") => ({
	schema: "qorpera.member-folder-commit/v1",
	operationKey,
	units,
});

describe("a member's change set to a folder-v2 company", () => {
	it("stages each file and commits as the member the database named, with each state file's parse", async () => {
		const g = await gateway();
		const text = agentText("Nora B.");
		const response = await g.send(
			request([{ op: "write", path: "agents/nora/agent.md", text, expectedVersion: version }]),
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { units: unknown }).units).toEqual([{ unit: 1, outcome: "saved" }]);
		// The writer check ran with the member's own token, and the database answered the actor.
		expect(g.calls[0]).toEqual({
			side: "member",
			method: "qorpera_member_folder_writer",
			args: { p_environment_id: environmentId },
			token: memberToken,
		});
		// Every staging call and the commit went as that member, never as the platform.
		for (const call of g.calls.filter(
			(c) => c.side === "publisher" && c.method !== "qorpera_folder_follow_up_commit",
		))
			expect(call.args.p_actor).toEqual({ kind: "member", userId });
		const [commit] = g.commits();
		// The member's key, in a namespace of its own: the platform's writers never use it.
		expect(commit?.args.p_operation_key).toBe(`member:${userId}:web:34000000-0000-4000-8000-0000000000d1`);
		const [unit] = commit?.args.p_units as Record<string, unknown>[];
		const file = unit?.file as { fileSha256: string; mediaType: string; executable: boolean };
		expect(unit).toMatchObject({ op: "write", path: "agents/nora/agent.md", expectedVersion: version });
		expect(file.mediaType).toBe("text/markdown");
		expect(file.executable).toBe(false);
		// The parse is made from exactly the bytes staged.
		expect(new TextDecoder().decode(g.stored.get(file.fileSha256))).toBe(text);
		expect(unit?.structured).toEqual([
			expect.objectContaining({ path: "agents/nora/agent.md", kind: "agent", text, parserVersion: 1 }),
		]);
		expect((unit?.structured as { parse: { name: string } }[])[0]?.parse.name).toBe("Nora B.");
	});

	it("carries a new folder's files with their joined paths, and a state file's problems instead of a parse", async () => {
		const g = await gateway();
		const response = await g.send(
			request([
				{
					op: "new_folder",
					path: "agents/ada",
					contents: [
						{ path: "agent.md", kind: "file", text: agentText("Ada") },
						{ path: "memory", kind: "folder" },
						{ path: "notes.txt", kind: "file", text: "plain" },
					],
				},
				{ op: "write", path: "agents/nora/agent.md", text: "not front matter at all" },
			]),
		);
		expect(response.status).toBe(200);
		const [folder, broken] = g.commits()[0]?.args.p_units as Record<string, unknown>[];
		expect(folder).toMatchObject({ op: "new_folder", path: "agents/ada" });
		expect((folder?.contents as Record<string, unknown>[]).map((c) => [c.path, c.kind, "file" in c])).toEqual([
			["agent.md", "file", true],
			["memory", "folder", false],
			["notes.txt", "file", true],
		]);
		const notes = (folder?.contents as { file?: { mediaType: string } }[])[2]?.file;
		expect(notes?.mediaType).toBe("text/plain");
		expect((folder?.structured as { path: string; kind: string }[]).map((e) => [e.path, e.kind])).toEqual([
			["agents/ada/agent.md", "agent"],
		]);
		const entry = (broken?.structured as Record<string, unknown>[])[0];
		expect(entry).toMatchObject({ path: "agents/nora/agent.md", kind: "agent" });
		expect(entry).not.toHaveProperty("text");
		expect(entry).not.toHaveProperty("parse");
		expect(Array.isArray(entry?.problems) && entry.problems.length > 0).toBe(true);
	});

	it("passes deletes, moves and new folders through as the core takes them", async () => {
		const g = await gateway();
		const response = await g.send(
			request([
				{ op: "mkdir", path: "drafts" },
				{ op: "delete", path: "agents/otto", expectedVersion: version, asOfSeq: 8 },
				{ op: "move", from: "drafts", to: "notes", expectedVersion: version, asOfSeq: 8 },
			]),
		);
		expect(response.status).toBe(200);
		expect(g.staged()).toEqual([]);
		expect(g.commits()[0]?.args.p_units).toEqual([
			{ op: "mkdir", path: "drafts" },
			{ op: "delete", path: "agents/otto", expectedVersion: version, asOfSeq: 8 },
			{ op: "move", from: "drafts", to: "notes", expectedVersion: version, asOfSeq: 8 },
		]);
	});

	it("refuses anything at or under human-tasks/ until P31, whatever its case, before staging", async () => {
		for (const unit of [
			{ op: "write", path: "human-tasks/sign-lease.md", text: "x" },
			{ op: "mkdir", path: "human-tasks/sign-lease" },
			{ op: "new_folder", path: "Human-Tasks/sign-lease", contents: [] },
			{ op: "delete", path: "human-tasks", expectedVersion: version },
			{ op: "move", from: "agents/nora/proof.pdf", to: "HUMAN-TASKS/sign-lease/proof.pdf" },
			{ op: "move", from: "human-tasks/sign-lease/proof.pdf", to: "drafts/proof.pdf" },
		]) {
			const g = await gateway();
			const response = await g.send(request([{ op: "mkdir", path: "drafts" }, unit]));
			expect(response.status, JSON.stringify(unit)).toBe(403);
			expect(g.staged()).toEqual([]);
			expect(g.commits()).toEqual([]);
		}
		const g = await gateway();
		expect((await g.send(request([{ op: "mkdir", path: "human-tasks-archive" }]))).status).toBe(200);
	});

	it("refuses a caller the database doesn't name, and a request out of shape, before staging", async () => {
		const g = await gateway();
		expect((await g.send(request([{ op: "mkdir", path: "drafts" }]), { token: null })).status).toBe(401);
		expect((await g.send(request([{ op: "mkdir", path: "drafts" }]), { token: "someone-else" })).status).toBe(403);
		expect((await g.send({}, { method: "GET" })).status).toBe(405);
		expect(
			(await g.send(request([{ op: "mkdir", path: "drafts" }]), { path: "/v1/member-folder-commits/nope" })).status,
		).toBe(404);
		for (const body of [
			"not json",
			{ ...request([{ op: "mkdir", path: "drafts" }]), schema: "qorpera.member-folder-commit/v2" },
			{ ...request([{ op: "mkdir", path: "drafts" }]), extra: true },
			request([{ op: "mkdir", path: "drafts" }], "has spaces"),
			request([]),
			request(Array.from({ length: 17 }, () => ({ op: "mkdir", path: "drafts" }))),
			request([{ op: "copy", from: "a", to: "b" }]),
			request([{ op: "mkdir", path: "drafts", text: "x" }]),
			request([{ op: "mkdir", path: "/drafts" }]),
			request([{ op: "write", path: "a.md", text: "broken \ud800 text" }]),
			request([{ op: "write", path: "a.md", text: "x", expectedVersion: "v1" }]),
			request([{ op: "delete", path: "a.md", asOfSeq: -1 }]),
			request([{ op: "new_folder", path: "a", contents: [{ path: "b", kind: "link" }] }]),
		]) {
			const response = await g.send(body);
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		expect((await g.send(request([{ op: "write", path: "a.md", text: "x".repeat(64 * 1024 + 1) }]))).status).toBe(
			413,
		);
		const files = Array.from({ length: 33 }, (_, n) => ({ path: `f${n}.txt`, kind: "file", text: "x" }));
		expect((await g.send(request([{ op: "new_folder", path: "many", contents: files }]))).status).toBe(413);
		expect(g.staged()).toEqual([]);
		expect(g.commits()).toEqual([]);
	});

	it("trusts only a writer answer that names a member", async () => {
		for (const answer of [
			{ schema: "qorpera.member-folder-writer/v1", actor: { kind: "platform" }, profileId },
			{ schema: "qorpera.member-folder-writer/v1", actor: { kind: "member", userId, extra: 1 }, profileId },
			{ schema: "qorpera.member-folder-writer/v2", actor: { kind: "member", userId }, profileId },
			null,
		]) {
			const g = await gateway({ member: () => answer });
			expect((await g.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(403);
			expect(g.commits()).toEqual([]);
		}
	});

	it("takes one change set at a time from a member", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let commits = 0;
		const g = await gateway({
			commit: async () => {
				if (++commits === 1) await waiting;
				return {
					schema: "qorpera.folder-commit/v1",
					commitId: "34000000-0000-4000-8000-0000000000c1",
					seq: 9,
					replay: false,
					units: [{ unit: 1, op: "mkdir", path: "drafts", outcome: "saved" }],
				};
			},
		});
		const first = g.send(request([{ op: "mkdir", path: "drafts" }]));
		await expect.poll(() => g.commits().length).toBe(1);
		expect((await g.send(request([{ op: "mkdir", path: "drafts" }], "web:second-1"))).status).toBe(429);
		release();
		expect((await first).status).toBe(200);
		expect((await g.send(request([{ op: "mkdir", path: "drafts" }], "web:third-01"))).status).toBe(200);
	});

	it("answers 503 when the commit's answer is not the core's, and frees the member for the next change set", async () => {
		const g = await gateway({ commit: () => ({ schema: "something-else" }) });
		expect((await g.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(503);
		// Not 429: the failed change set gave its slot back.
		expect((await g.send(request([{ op: "mkdir", path: "drafts" }], "web:again-01"))).status).toBe(503);
	});

	it("checks a new folder's joined paths before staging any file", async () => {
		const g = await gateway();
		const long = "a".repeat(2100);
		const response = await g.send(
			request([
				{ op: "write", path: "first.md", text: "staged first, were the join checked late" },
				{ op: "new_folder", path: long, contents: [{ path: long, kind: "file", text: "x" }] },
			]),
		);
		expect(response.status).toBe(400);
		expect(g.staged()).toEqual([]);
		// A folder entry's joined path too.
		const folderEntry = await g.send(
			request([
				{ op: "write", path: "first.md", text: "staged first, were the join checked late" },
				{ op: "new_folder", path: long, contents: [{ path: long, kind: "folder" }] },
			]),
		);
		expect(folderEntry.status).toBe(400);
		expect(g.staged()).toEqual([]);
	});

	it("follows a saved commit up at once, one subject a call while the core says there is more", async () => {
		const answers = [true, true, false].map((more) => ({
			schema: "qorpera.folder-follow-up/v1",
			subjectKind: "agent",
			subjectId: agentId,
			result: "converged",
			more,
		}));
		const g = await gateway({ followUp: (n) => answers[n - 1] });
		expect((await g.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(200);
		const followUps = g.calls.filter((call) => call.method === "qorpera_folder_follow_up_commit");
		expect(followUps).toHaveLength(3);
		for (const call of followUps)
			expect(call.args).toEqual({
				p_environment_id: environmentId,
				p_commit_id: "34000000-0000-4000-8000-0000000000c1",
			});
		// After the commit, never before.
		expect(g.calls.findIndex((call) => call.method === "qorpera_folder_commit")).toBeLessThan(
			g.calls.findIndex((call) => call.method === "qorpera_folder_follow_up_commit"),
		);
	});

	it("keeps the follow-up a best effort: bounded, and never the member's failure", async () => {
		const always = await gateway({
			followUp: () => ({
				schema: "qorpera.folder-follow-up/v1",
				subjectKind: "agent",
				subjectId: agentId,
				result: "converged",
				more: true,
			}),
		});
		expect((await always.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(200);
		expect(always.calls.filter((call) => call.method === "qorpera_folder_follow_up_commit")).toHaveLength(8);
		// Before P15 the function is not there: the commit's answer still goes back.
		const missing = await gateway();
		expect((await missing.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(200);
		expect(missing.calls.filter((call) => call.method === "qorpera_folder_follow_up_commit")).toHaveLength(1);
		const failing = await gateway({
			followUp: () => {
				throw new ObjectDependencyError(409, true);
			},
		});
		expect((await failing.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(200);
		// A commit that saved nothing has nothing to follow up.
		const refused = await gateway({
			commit: () => ({
				schema: "qorpera.folder-commit/v1",
				commitId: "34000000-0000-4000-8000-0000000000c1",
				seq: null,
				replay: false,
				units: [{ unit: 1, op: "mkdir", path: "drafts", outcome: "refused", reason: "x" }],
			}),
			followUp: () => {
				throw new Error("not expected");
			},
		});
		expect((await refused.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(200);
		expect(refused.calls.filter((call) => call.method === "qorpera_folder_follow_up_commit")).toEqual([]);
	});

	it("makes no follow-up without its own client, and frees the member's slot before following up", async () => {
		const none = await gateway({
			noFollowUps: true,
			followUp: () => ({ schema: "qorpera.folder-follow-up/v1", more: false }),
		});
		expect((await none.send(request([{ op: "mkdir", path: "drafts" }]))).status).toBe(200);
		expect(none.calls.filter((call) => call.method === "qorpera_folder_follow_up_commit")).toEqual([]);
		// While the first change set's follow-up runs, the member's next change set is taken, not refused with 429.
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = await gateway({
			followUp: async (n) => {
				if (n === 1) await waiting;
				return { schema: "qorpera.folder-follow-up/v1", more: false };
			},
		});
		const first = slow.send(request([{ op: "mkdir", path: "drafts" }]));
		await expect
			.poll(() => slow.calls.filter((call) => call.method === "qorpera_folder_follow_up_commit").length)
			.toBe(1);
		expect((await slow.send(request([{ op: "mkdir", path: "drafts" }], "web:second-01"))).status).toBe(200);
		release();
		expect((await first).status).toBe(200);
	});

	it("bounds a follow-up by its time as well as its calls", async () => {
		const calls: string[] = [];
		const slow = {
			publisher: async (method: string) => {
				calls.push(method);
				await new Promise((resolve) => setTimeout(resolve, 40));
				return { schema: "qorpera.folder-follow-up/v1", more: true };
			},
		};
		const made = await followUpMemberCommit(slow as never, environmentId, version, new AbortController().signal, 100);
		expect(made).toBeGreaterThanOrEqual(2);
		expect(made).toBeLessThan(8);
		expect(calls.length).toBe(made);
	});

	it("lets a member's browser send it across origins", () => {
		const cors = createMemberCors(["https://app.example.test"]);
		const headers = new Map<string, string>();
		let status = 0;
		const handled = cors(
			{
				method: "OPTIONS",
				url: `/v1/member-folder-commits/${environmentId}`,
				headers: {
					origin: "https://app.example.test",
					"access-control-request-method": "POST",
					"access-control-request-headers": "authorization, content-type",
				},
			} as never,
			{
				setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), String(value)),
				writeHead: (code: number, written: Record<string, string> = {}) => {
					status = code;
					for (const [name, value] of Object.entries(written)) headers.set(name.toLowerCase(), value);
				},
				end: () => {},
			} as never,
		);
		expect(handled).toBe(true);
		expect(status).toBe(204);
		expect(headers.get("access-control-allow-methods")).toBe("POST");
		expect(headers.get("access-control-allow-headers")).toBe("authorization, content-type");
	});
});
