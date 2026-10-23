import { createHash } from "node:crypto";
import { companyStateSeedTree } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it } from "vitest";
import { CompanyFolderCreator, creationUnits, parseCompanyCreationClaim } from "../src/company-folder-creation.ts";
import { ObjectDependencyError } from "../src/dependency.ts";
import { type PlatformFileReference, PlatformFolderProblem } from "../src/platform-folder-writer.ts";

const workerId = "34000000-0000-4000-8000-00000000000a";
const creationId = "34000000-0000-4000-8000-0000000000c1";
const environmentId = "34000000-0000-4000-8000-000000000020";
const profileId = "34000000-0000-4000-8000-000000000010";
const cofounderId = "34000000-0000-4000-8000-0000000000a1";
const firstTodoId = "34000000-0000-4000-8000-0000000000b1";
const anna = "34000000-0000-4000-8000-000000000001";
const bo = "34000000-0000-4000-8000-000000000002";
const intentId = "34000000-0000-4000-8000-0000000000f0";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function claim(overrides: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.company-creation-claim/v1",
		creationId,
		profileId,
		environmentId,
		generation: 2,
		attempt: 2,
		leaseUntil: "2026-10-03T08:05:00Z",
		operationKey: `company-create:${creationId}`,
		cofounderId,
		firstTodoId,
		kickoffRequestedBy: anna,
		input: {
			schema: "qorpera.company-seed-input/v1",
			companyName: "Nordlys Kaffe",
			vision: "Specialty coffee, and wholesale to cafés in Aarhus.",
			kickoffRequestedBy: anna,
			founders: [
				{ userId: anna, displayName: "Anna", role: "" },
				{ userId: bo, displayName: "Bo", role: "Wholesale." },
			],
			...input,
		},
		...overrides,
	};
}

/** The database and the store as the worker sees them: every call recorded; create answered from `answer`. */
function database(
	options: {
		claims?: unknown[];
		answer?: unknown;
		createThrows?: Error;
		followUpThrows?: Error;
		sealIncomplete?: boolean;
		openInvalid?: boolean;
	} = {},
) {
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const claims = [...(options.claims ?? [])];
	const objects = new Map<string, Uint8Array>();
	let manifest = "";
	const authority = {
		async publisher(method: string, args: Record<string, unknown>) {
			calls.push({ method, args });
			switch (method) {
				case "qorpera_folder_company_creation_claim":
					return claims.shift() ?? null;
				case "qorpera_folder_company_create":
					if (options.createThrows) throw options.createThrows;
					return options.answer ?? { schema: "qorpera.company-creation/v1", creationId, state: "completed" };
				case "qorpera_folder_company_creation_release":
					return { schema: "qorpera.company-creation-release/v1", released: true };
				case "qorpera_folder_company_creation_fail":
					return { schema: "qorpera.company-creation-fail/v1", failed: true };
				case "qorpera_folder_follow_up_now":
					if (options.followUpThrows) throw options.followUpThrows;
					return { schema: "qorpera.folder-follow-up/v1", result: "done" };
				case "qorpera_folder_open_upload":
					if (options.openInvalid) return { schema: "qorpera.folder-upload/v0" };
					manifest = args.p_manifest as string;
					return {
						schema: "qorpera.folder-upload/v1",
						intentId,
						manifestSha256: digest(manifest),
						expiresAt: "x",
						present: [],
					};
				case "qorpera_folder_authorize_object_upload":
					return { schema: "qorpera.folder-object-upload/v1", profileId };
				case "qorpera_folder_confirm_object":
					return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes };
				case "qorpera_folder_seal_upload": {
					if (options.sealIncomplete)
						return { schema: "qorpera.folder-seal/v1", state: "incomplete", intentId, missing: [] };
					const parsed = JSON.parse(manifest);
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId,
						file: {
							manifestSha256: digest(manifest),
							fileSha256: parsed.fileSha256,
							bytes: parsed.bytes,
							mediaType: parsed.mediaType,
							executable: parsed.executable,
						},
					};
				}
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	const store = {
		async get(_profile: string, hash: string) {
			const object = objects.get(hash);
			if (!object) throw new Error("Object not found");
			return object;
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
			objects.set(hash, bytes);
			await callbacks.confirm();
			return "stored" as const;
		},
	};
	const creator = new CompanyFolderCreator({ workerId, authority, store, replication });
	const named = (method: string) => calls.filter((call) => call.method === method);
	return { creator, calls, named };
}

describe("parseCompanyCreationClaim", () => {
	it("reads a claim as a closed record, and nothing due as null", () => {
		expect(parseCompanyCreationClaim(null)).toBeNull();
		const parsed = parseCompanyCreationClaim(claim());
		expect(parsed).toMatchObject({
			creationId,
			environmentId,
			generation: 2,
			cofounderId,
			firstTodoId,
			kickoffRequestedBy: anna,
		});
		expect(parsed?.founders).toHaveLength(2);
		// The kickoff member's account may be gone: the create answers that.
		expect(parseCompanyCreationClaim(claim({ kickoffRequestedBy: null }))?.kickoffRequestedBy).toBeNull();
	});

	it("refuses anything else", () => {
		for (const bad of [
			claim({ extra: 1 }),
			claim({ schema: "qorpera.company-creation-claim/v2" }),
			claim({ operationKey: "company-create:other" }),
			claim({ generation: 0 }),
			claim({ cofounderId: "not-a-uuid" }),
			claim({ kickoffRequestedBy: bo }),
			claim({}, { extra: true }),
			claim({}, { founders: [{ userId: anna, displayName: "Anna" }] }),
			claim({}, { founders: "Anna" }),
			{ schema: "qorpera.company-creation-claim/v1" },
		]) {
			expect(() => parseCompanyCreationClaim(bad)).toThrow(PlatformFolderProblem);
		}
	});
});

describe("creationUnits", () => {
	it("makes the Co-Founder's folder, each interface and each table one new_folder unit, and every other entry a mkdir or a write", () => {
		const tree = companyStateSeedTree({
			companyName: "Nordlys Kaffe",
			cofounderId,
			vision: "Coffee.",
			founders: [{ displayName: "Anna", role: "" }],
			firstTodo: { id: firstTodoId, requestedBy: anna },
		});
		const files = new Map<string, PlatformFileReference>(
			tree
				.filter((entry) => entry.kind === "file")
				.map((entry) => [
					entry.path,
					{
						manifestSha256: digest(`m:${entry.path}`),
						fileSha256: digest(entry.text ?? ""),
						bytes: 1,
						mediaType: "text/markdown",
						executable: false,
					},
				]),
		);
		const units = creationUnits(tree, files) as {
			op: string;
			path: string;
			file?: PlatformFileReference;
			contents?: { path: string; kind: string; file?: PlatformFileReference }[];
			structured?: { path: string; kind: string; parserVersion: number }[];
		}[];
		expect(units.map((unit) => `${unit.op} ${unit.path}`)).toEqual([
			"mkdir vision",
			"write vision/vision.md",
			"mkdir agents",
			"write agents/sections.md",
			"new_folder agents/co-founder",
			"mkdir agents/groups",
			"mkdir connections",
			"mkdir human-tasks",
			"mkdir contacts",
			"mkdir skills",
			"mkdir skills/human-task",
			"write skills/human-task/SKILL.md",
			"mkdir rules",
			"mkdir interfaces",
			"new_folder interfaces/mailbox",
			"new_folder interfaces/members",
			"write interfaces/order.md",
			"mkdir tables",
			"new_folder tables/areas",
		]);
		const byPath = (path: string) => units.find((candidate) => candidate.path === path);
		const cofounder = byPath("agents/co-founder");
		expect(cofounder?.contents?.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
			"file agent.md",
			"folder memory",
			"folder skills",
			"folder routines",
			"folder todos",
			"file todos/start-with-the-founders.md",
		]);
		expect(cofounder?.contents?.[0]?.file).toBe(files.get("agents/co-founder/agent.md"));
		expect(cofounder?.structured?.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
			"agent agents/co-founder/agent.md",
			"todo agents/co-founder/todos/start-with-the-founders.md",
		]);
		expect(byPath("vision/vision.md")?.structured?.[0]?.kind).toBe("vision");
		expect(byPath("agents/sections.md")?.structured?.[0]?.kind).toBe("sections");
		// The seeded skill is no structured file: bytes only.
		expect(byPath("skills/human-task/SKILL.md")?.structured).toBeUndefined();
		expect(byPath("skills/human-task/SKILL.md")?.file).toBe(files.get("skills/human-task/SKILL.md"));
		// A table's definition and rows go in one unit, so its first rows read the definition it brings (P16).
		const areas = byPath("tables/areas");
		expect(areas?.contents?.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
			"file table.toml",
			"file rows.csv",
		]);
		expect(areas?.structured?.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
			"table tables/areas/table.toml",
			"table-rows tables/areas/rows.csv",
		]);
		expect(byPath("interfaces/order.md")?.structured?.[0]?.kind).toBe("interface-order");
		expect(byPath("interfaces/mailbox")?.structured?.[0]?.kind).toBe("interface");
	});

	it("refuses a file that was not staged", () => {
		const tree = companyStateSeedTree({ companyName: "Nordlys", cofounderId });
		expect(() => creationUnits(tree, new Map())).toThrow(PlatformFolderProblem);
	});
});

describe("CompanyFolderCreator", () => {
	it("claims, stages every seeded file as the platform and creates once", async () => {
		const { creator, named } = database({ claims: [claim()] });
		expect(await creator.createOne()).toBe(true);
		const create = named("qorpera_folder_company_create");
		expect(create).toHaveLength(1);
		expect(create[0]?.args).toMatchObject({ p_worker: workerId, p_creation_id: creationId, p_generation: 2 });
		expect((create[0]?.args.p_units as unknown[]).length).toBe(19);
		// One upload per file: the vision, the sections, the agent, the first todo and the skill, then the library's two
		// pages, its order and the areas table's two files.
		expect(named("qorpera_folder_open_upload")).toHaveLength(10);
		for (const open of named("qorpera_folder_open_upload")) expect(open.args.p_actor).toEqual({ kind: "platform" });
		// Markdown for the state files, plain text for interfaces and tables.
		const media = named("qorpera_folder_open_upload").map(
			(open) => JSON.parse(open.args.p_manifest as string).mediaType,
		);
		expect(media.filter((type) => type === "text/markdown")).toHaveLength(6);
		expect(media.filter((type) => type === "text/plain")).toHaveLength(4);
		const units = create[0]?.args.p_units as {
			path: string;
			contents?: { path: string; file?: { mediaType: string } }[];
		}[];
		expect(
			units.find((unit) => unit.path === "tables/areas")?.contents?.map((entry) => entry.file?.mediaType),
		).toEqual(["text/plain", "text/plain"]);
		expect(named("qorpera_folder_company_creation_release")).toHaveLength(0);
		expect(named("qorpera_folder_company_creation_fail")).toHaveLength(0);
	});

	it("kicks the follow-up queue for the new Co-Founder after a completed creation, best effort", async () => {
		const { creator, calls, named } = database({ claims: [claim()] });
		expect(await creator.createOne()).toBe(true);
		expect(named("qorpera_folder_follow_up_now").map((call) => call.args)).toEqual([
			{ p_environment_id: environmentId, p_subject_kind: "agent", p_subject_id: cofounderId },
		]);
		// After the create, in its own call.
		expect(calls.at(-1)?.method).toBe("qorpera_folder_follow_up_now");
		// A kick that fails changes nothing: the queue's step converges the Co-Founder.
		const refused = database({ claims: [claim()], followUpThrows: new ObjectDependencyError(409) });
		expect(await refused.creator.createOne()).toBe(true);
		expect(refused.named("qorpera_folder_follow_up_now")).toHaveLength(1);
		expect(refused.named("qorpera_folder_company_creation_release")).toHaveLength(0);
		expect(refused.named("qorpera_folder_company_creation_fail")).toHaveLength(0);
		// No kick for any other answer.
		for (const state of ["failed", "stale", "retry"]) {
			const other = database({
				claims: [claim()],
				answer: { schema: "qorpera.company-creation/v1", creationId, state, problem: "refused" },
			});
			expect(await other.creator.createOne()).toBe(true);
			expect(other.named("qorpera_folder_follow_up_now")).toHaveLength(0);
		}
	});

	it("reports nothing due", async () => {
		const { creator, named } = database();
		expect(await creator.createOne()).toBe(false);
		expect(named("qorpera_folder_company_create")).toHaveLength(0);
	});

	it("leaves a failed or stale answer as the database recorded it", async () => {
		for (const state of ["failed", "stale"]) {
			const { creator, named } = database({
				claims: [claim()],
				answer: { schema: "qorpera.company-creation/v1", creationId, state, problem: "refused" },
			});
			expect(await creator.createOne()).toBe(true);
			expect(named("qorpera_folder_company_creation_release")).toHaveLength(0);
			expect(named("qorpera_folder_company_creation_fail")).toHaveLength(0);
		}
	});

	it("releases a retry with a back-off, to restage", async () => {
		const { creator, named } = database({
			claims: [claim()],
			answer: { schema: "qorpera.company-creation/v1", creationId, state: "retry", problem: "bytes_unverified" },
		});
		expect(await creator.createOne()).toBe(true);
		expect(named("qorpera_folder_company_creation_release")[0]?.args).toEqual({
			p_worker: workerId,
			p_creation_id: creationId,
			p_generation: 2,
			p_problem: "bytes_unverified",
		});
	});

	it("releases on a database error, a paused or deleting company included", async () => {
		// A pause or a deletion reaches the gateway as 423 (55000), a lock conflict as 409: both back off.
		const { creator, named } = database({ claims: [claim()], createThrows: new ObjectDependencyError(423) });
		expect(await creator.createOne()).toBe(true);
		expect(named("qorpera_folder_company_creation_release")).toHaveLength(1);
		expect(named("qorpera_folder_company_creation_fail")).toHaveLength(0);
	});

	it("releases an answer it cannot read", async () => {
		const { creator, named } = database({
			claims: [claim()],
			answer: { schema: "qorpera.company-creation/v1", state: "maybe" },
		});
		expect(await creator.createOne()).toBe(true);
		expect(named("qorpera_folder_company_creation_release")[0]?.args.p_problem).toBe("create_invalid");
	});

	it("releases staging that did not complete, and fails only what no retry fixes", async () => {
		const incomplete = database({ claims: [claim()], sealIncomplete: true });
		expect(await incomplete.creator.createOne()).toBe(true);
		expect(incomplete.named("qorpera_folder_company_creation_release")[0]?.args.p_problem).toBe("stage_incomplete");
		expect(incomplete.named("qorpera_folder_company_create")).toHaveLength(0);

		// A name the seed tree cannot write: failed, nothing staged.
		const unwritable = database({ claims: [claim({}, { companyName: "Nordlys\nKaffe" })] });
		expect(await unwritable.creator.createOne()).toBe(true);
		expect(unwritable.named("qorpera_folder_company_creation_fail")[0]?.args).toEqual({
			p_worker: workerId,
			p_creation_id: creationId,
			p_generation: 2,
			p_code: "seed_invalid",
		});
		expect(unwritable.named("qorpera_folder_open_upload")).toHaveLength(0);
	});

	it("releases a claim it cannot read that names its creation, and throws; leaves any other to its lease", async () => {
		const { creator, named } = database({ claims: [claim({ extra: true })] });
		await expect(creator.createOne()).rejects.toThrow(PlatformFolderProblem);
		expect(named("qorpera_folder_company_creation_release")[0]?.args.p_problem).toBe("claim_invalid");
		expect(named("qorpera_folder_company_creation_fail")).toHaveLength(0);
		const nameless = database({ claims: [{ schema: "qorpera.company-creation-claim/v1" }] });
		await expect(nameless.creator.createOne()).rejects.toThrow(PlatformFolderProblem);
		expect(nameless.named("qorpera_folder_company_creation_release")).toHaveLength(0);
		expect(nameless.named("qorpera_folder_company_creation_fail")).toHaveLength(0);
	});

	it("fails a staging refusal", async () => {
		const { creator, named } = database({ claims: [claim()], openInvalid: true });
		expect(await creator.createOne()).toBe(true);
		expect(named("qorpera_folder_company_creation_fail")[0]?.args.p_code).toBe("stage_invalid");
		expect(named("qorpera_folder_company_create")).toHaveLength(0);
	});

	it("creates for a claim whose kickoff member is gone, and leaves a replay alone", async () => {
		const gone = database({
			claims: [claim({ kickoffRequestedBy: null })],
			answer: { schema: "qorpera.company-creation/v1", creationId, state: "failed", problem: "kickoff_member_left" },
		});
		expect(await gone.creator.createOne()).toBe(true);
		expect(gone.named("qorpera_folder_company_create")).toHaveLength(1);
		expect(gone.named("qorpera_folder_company_creation_release")).toHaveLength(0);
		const replay = database({
			claims: [claim()],
			answer: { schema: "qorpera.company-creation/v1", creationId, state: "completed", replay: true },
		});
		expect(await replay.creator.createOne()).toBe(true);
		expect(replay.named("qorpera_folder_company_creation_release")).toHaveLength(0);
		expect(replay.named("qorpera_folder_company_creation_fail")).toHaveLength(0);
	});

	it("drains due creations until none is left or the budget ends", async () => {
		const { creator, named } = database({ claims: [claim(), claim({ generation: 3 })] });
		expect(await creator.createDue(5)).toBe(2);
		expect(named("qorpera_folder_company_create")).toHaveLength(2);
		const capped = database({ claims: [claim(), claim(), claim()] });
		expect(await capped.creator.createDue(2)).toBe(2);
	});

	it("refuses a worker identity or lease out of range", () => {
		const base = {
			authority: { publisher: async () => null },
			store: { get: async () => new Uint8Array() },
			replication: { uploadWithAuthority: async () => "stored" as const },
		};
		expect(() => new CompanyFolderCreator({ ...base, workerId: "worker" })).toThrow();
		expect(() => new CompanyFolderCreator({ ...base, workerId, leaseSeconds: 10 })).toThrow();
	});
});
