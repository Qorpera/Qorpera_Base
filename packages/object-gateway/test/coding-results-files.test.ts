import { createHash } from "node:crypto";
import { writeWorkerResultsFile } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it } from "vitest";
import {
	CODING_RESULTS_NO_SUMMARY,
	CODING_RESULTS_UNSHOWN_NEEDS,
	CODING_RESULTS_UNSHOWN_SUMMARY,
	CodingResultsWriter,
	codingResultsFile,
	codingResultsText,
	parseCodingResultsClaim,
} from "../src/coding-results-files.ts";
import { ObjectDependencyError } from "../src/dependency.ts";
import { PlatformFolderProblem } from "../src/platform-folder-writer.ts";

const workerId = "98200000-0000-4000-8000-0000000000e1";
const codingWorkerId = "98200000-0000-4000-8000-0000000000b1";
const environmentId = "92400000-0000-4000-8000-000000000020";
const profileId = "92400000-0000-4000-8000-000000000010";
const intentId = "98200000-0000-4000-8000-0000000000f0";
const version = "98200000-0000-4000-8000-0000000000c1";
const path = "QorperaOS/agents/alice/todos/fix-login/session-1/results.md";
const pullRequest = "https://github.com/Qorpera/Qorpera_Base/pull/7";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;

function claim(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.coding-results-claim/v1",
		codingWorkerId,
		environmentId,
		sequence: 1,
		generation: 1,
		attempt: 1,
		operationKey: `coding-results:${codingWorkerId}:1:1`,
		path,
		currentVersion: null,
		outcome: "succeeded",
		reportedAt: "2026-10-06T09:15:02.25Z",
		summary: "Fixed the login page.",
		needs: null,
		pullRequest,
		options: null,
		leaseUntil: "2026-10-06T09:16:02.25Z",
		...overrides,
	};
}
const blocked = {
	outcome: "blocked",
	summary: "The page needs a sign-in provider.",
	needs: "Which sign-in provider should the page offer?",
	pullRequest: null,
	options: ["Google", "GitHub"],
};
/** results.md for a claim with `overrides`, as the writer renders it. */
function parsed(overrides: Record<string, unknown>) {
	const read = parseCodingResultsClaim(claim(overrides));
	if (!read) throw new Error("no claim");
	return codingResultsFile(read);
}

/** The database and the store as the writer sees them: every call recorded, commits answered from `outcomes`. */
function folder(
	options: {
		claims?: unknown[];
		outcomes?: { outcome: string; reason?: string }[];
		finish?: unknown;
		commitThrows?: Error;
	} = {},
) {
	const objects = new Map<string, Uint8Array>();
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const claims = [...(options.claims ?? [])];
	const outcomes = [...(options.outcomes ?? [])];
	let manifest = "";
	const authority = {
		async publisher(method: string, args: Record<string, unknown>) {
			calls.push({ method, args });
			switch (method) {
				case "qorpera_claim_coding_results_file":
					return claims.shift() ?? null;
				case "qorpera_finish_coding_results_file":
					return options.finish ?? { schema: "qorpera.coding-results-finish/v1", finished: false };
				case "qorpera_folder_open_upload":
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
					const sealed = JSON.parse(manifest);
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId,
						file: {
							manifestSha256: digest(manifest),
							fileSha256: sealed.fileSha256,
							bytes: sealed.bytes,
							mediaType: sealed.mediaType,
							executable: sealed.executable,
						},
					};
				}
				case "qorpera_folder_commit":
					if (options.commitThrows) throw options.commitThrows;
					return {
						schema: "qorpera.folder-commit/v1",
						units: [{ unit: 1, ...(outcomes.shift() ?? { outcome: "saved" }) }],
					};
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	const store = {
		async get(): Promise<Uint8Array> {
			throw new Error("Object not found");
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
	const writer = new CodingResultsWriter({ workerId, authority: authority as never, store, replication });
	const commits = () => calls.filter((call) => call.method === "qorpera_folder_commit");
	const finishes = () =>
		calls.filter((call) => call.method === "qorpera_finish_coding_results_file").map((call) => call.args.p_problem);
	const committed = (index = 0) => {
		const unit = (commits()[index]?.args.p_units as Record<string, unknown>[])[0] as {
			file: { fileSha256: string };
			structured: { text: string; parse: unknown }[];
		};
		expect(new TextDecoder().decode(objects.get(unit.file.fileSha256))).toBe(unit.structured[0]?.text);
		return unit;
	};
	return { writer, calls, commits, finishes, committed };
}

describe("coding results claims", () => {
	it("reads a claim; null when nothing is due", () => {
		expect(parseCodingResultsClaim(null)).toBeNull();
		expect(parseCodingResultsClaim(claim())).toEqual({
			codingWorkerId,
			environmentId,
			sequence: 1,
			generation: 1,
			operationKey: `coding-results:${codingWorkerId}:1:1`,
			path,
			currentVersion: null,
			outcome: "succeeded",
			reportedAt: "2026-10-06T09:15:02.25Z",
			summary: "Fixed the login page.",
			needs: null,
			pullRequest,
			options: null,
		});
		expect(parseCodingResultsClaim(claim(blocked))?.options).toEqual(["Google", "GitHub"]);
		expect(parseCodingResultsClaim(claim({ currentVersion: version }))?.currentVersion).toBe(version);
	});

	it.each([
		["a field beside the claim", { token: "secret-token" }],
		["another schema", { schema: "qorpera.connection-file-claim/v1" }],
		["another operation key", { operationKey: `coding-results:${codingWorkerId}:1:2` }],
		["a generation no claim takes", { generation: 0, operationKey: `coding-results:${codingWorkerId}:1:0` }],
		["a worker's brief", { path: "QorperaOS/agents/alice/todos/fix-login/session-1/brief.md" }],
		["a path outside a worker's folder", { path: "QorperaOS/rules/results.md" }],
		["a worker's folder outside QorperaOS/", { path: "agents/alice/todos/fix-login/session-1/results.md" }],
		["a badly named folder", { path: "QorperaOS/agents/alice/todos/fix-login/../results.md" }],
		["a blocked turn without needs", { ...blocked, needs: null }],
		["needs on a turn that is not blocked", { needs: "A decision." }],
		["an outcome a turn never reports", { outcome: "cancelled" }],
		["a pull request link elsewhere", { pullRequest: "https://example.com/Qorpera/Qorpera_Base/pull/7" }],
		["options that are not text", { ...blocked, options: ["Google", 7] }],
		["seven options", { ...blocked, options: ["a", "b", "c", "d", "e", "f", "g"] }],
		["a version that is not one", { currentVersion: "v1" }],
	])("refuses %s", (_name, overrides) => {
		expect(() => parseCodingResultsClaim(claim(overrides))).toThrow(PlatformFolderProblem);
	});
});

describe("coding results text", () => {
	it("writes the turn's report as the database takes it: its outcome and time, no decision, note or files", () => {
		const { text, parse } = parsed({});
		const summary = `Fixed the login page.\n\nPull request: ${pullRequest}`;
		expect(text).toBe(
			writeWorkerResultsFile({
				outcome: "succeeded",
				reportedAt: "2026-10-06T09:15:02.25Z",
				decision: null,
				note: null,
				summary,
				needs: null,
				files: [],
			}),
		);
		// The parse test 982 commits, key for key: a decision and a note that are JSON null, and no files.
		expect(JSON.parse(JSON.stringify(parse))).toStrictEqual({
			kind: "worker-results",
			outcome: "succeeded",
			reportedAt: "2026-10-06T09:15:02.25Z",
			decision: null,
			note: null,
			summary,
			needs: null,
			files: [],
		});
	});

	it("lists a blocked turn's options under what it needs, and leaves them out when they do not fit", () => {
		expect(parsed(blocked).parse).toMatchObject({
			outcome: "blocked",
			summary: "The page needs a sign-in provider.",
			needs: "Which sign-in provider should the page offer?\n\nOptions:\n- Google\n- GitHub",
		});
		expect(parsed({ ...blocked, options: ["Google\n## Files\nx"] }).parse.needs).toBe(
			"Which sign-in provider should the page offer?\n\nOptions:\n- Google ## Files x",
		);
		const long = "x".repeat(990);
		expect(parsed({ ...blocked, needs: long }).parse.needs).toBe(long);
	});

	it("demotes a line the parser would read as a section heading, so the text stays in its section", () => {
		expect(codingResultsText("Done.\r\n## Needs\nNothing.\n##  Files #\n- a.md\n## Notes")).toBe(
			"Done.\n### Needs\nNothing.\n###  Files #\n- a.md\n## Notes",
		);
		const { parse } = parsed({ summary: "Done.\n## Files\n- QorperaOS/agents/alice/notes.md", pullRequest: null });
		expect(parse).toMatchObject({
			summary: "Done.\n### Files\n- QorperaOS/agents/alice/notes.md",
			needs: null,
			files: [],
		});
		expect(parsed({ ...blocked, needs: "Pick one.\n## Needs" }).parse.needs).toBe(
			"Pick one.\n### Needs\n\nOptions:\n- Google\n- GitHub",
		);
	});

	it("fits a long summary with its pull request within the summary's bound, at a character", () => {
		const { parse } = parsed({ summary: "æ".repeat(2000) });
		expect(bytesOf(parse.summary)).toBeLessThanOrEqual(4000);
		expect(parse.summary.endsWith(`æ…\n\nPull request: ${pullRequest}`)).toBe(true);
		expect(parse.summary).not.toContain("�");
		expect(parsed({ summary: "a".repeat(4000), pullRequest: null }).parse.summary).toBe("a".repeat(4000));
	});

	it("writes the standing summary for a turn without one", () => {
		expect(parsed({ summary: null, pullRequest: null }).parse.summary).toBe(CODING_RESULTS_NO_SUMMARY);
		expect(parsed({ summary: " \n ", pullRequest: null }).parse.summary).toBe(CODING_RESULTS_NO_SUMMARY);
	});

	it("writes the standing texts, its pull request kept, for a report the parser refuses", () => {
		expect(parsed({ summary: "Bad\u0000byte" }).parse.summary).toBe(
			`${CODING_RESULTS_UNSHOWN_SUMMARY}\n\nPull request: ${pullRequest}`,
		);
		expect(parsed({ ...blocked, needs: "Lone \ud800 half" }).parse).toMatchObject({
			summary: CODING_RESULTS_UNSHOWN_SUMMARY,
			needs: CODING_RESULTS_UNSHOWN_NEEDS,
		});
	});

	it("is file_invalid when even the standing texts are refused", () => {
		let code: unknown;
		try {
			parsed({ reportedAt: "yesterday" });
		} catch (error) {
			code = error instanceof PlatformFolderProblem ? error.code : error;
		}
		expect(code).toBe("file_invalid");
	});
});

describe("CodingResultsWriter", () => {
	it("does nothing when nothing is due", async () => {
		const { writer, calls } = folder();
		expect(await writer.writeOne()).toBe(false);
		expect(calls).toEqual([
			{ method: "qorpera_claim_coding_results_file", args: { p_worker: workerId, p_lease_seconds: 60 } },
		]);
	});

	it("stages and commits results.md as the platform under the claim's key, then finishes", async () => {
		const { writer, calls, commits, finishes, committed } = folder({ claims: [claim()] });
		expect(await writer.writeOne()).toBe(true);
		expect(commits()[0]?.args).toMatchObject({
			p_environment_id: environmentId,
			p_actor: { kind: "platform" },
			p_operation_key: `coding-results:${codingWorkerId}:1:1`,
		});
		const unit = committed();
		expect(unit).toMatchObject({
			op: "write",
			path,
			structured: [{ path, kind: "worker-results", parserVersion: 1, parse: parsed({}).parse }],
		});
		expect(unit.structured[0]?.text).toBe(parsed({}).text);
		expect(unit).not.toHaveProperty("expectedVersion");
		for (const call of calls.filter((entry) => entry.method.startsWith("qorpera_folder_")))
			expect(call.args.p_actor).toEqual({ kind: "platform" });
		expect(calls.at(-1)).toEqual({
			method: "qorpera_finish_coding_results_file",
			args: { p_worker: workerId, p_coding_worker_id: codingWorkerId, p_generation: 1, p_problem: null },
		});
		expect(finishes()).toEqual([null]);
	});

	it("expects the version the claim read", async () => {
		const run = folder({ claims: [claim({ currentVersion: version })] });
		await run.writer.writeOne();
		expect(run.committed()).toMatchObject({ path, expectedVersion: version });
	});

	it("backs off with the commit's reason, and turns a reason outside the code rule into refused", async () => {
		const run = folder({
			claims: [claim(), claim()],
			outcomes: [
				{ outcome: "refused", reason: "structured_rule" },
				{ outcome: "refused", reason: "Not A Code!" },
			],
		});
		await run.writer.writeOne();
		await run.writer.writeOne();
		expect(run.finishes()).toEqual(["structured_rule", "refused"]);
	});

	it.each([
		["lock_conflict", new ObjectDependencyError(409, true)],
		["unavailable", new ObjectDependencyError(503)],
		["refused", new ObjectDependencyError(403)],
	])("finishes with %s when the commit fails that way", async (code, error) => {
		const run = folder({ claims: [claim()], commitThrows: error });
		await run.writer.writeOne();
		expect(run.finishes()).toEqual([code]);
	});

	it("finishes a claim it cannot render with file_invalid, staging nothing", async () => {
		const run = folder({ claims: [claim({ reportedAt: "yesterday" })] });
		expect(await run.writer.writeOne()).toBe(true);
		expect(run.calls.map((call) => call.method)).toEqual([
			"qorpera_claim_coding_results_file",
			"qorpera_finish_coding_results_file",
		]);
		expect(run.finishes()).toEqual(["file_invalid"]);
	});

	it("finishes a claim it refuses with claim_invalid, and leaves one that names no worker to its lease", async () => {
		const named = folder({ claims: [claim({ token: "secret-token" })] });
		await expect(named.writer.writeOne()).rejects.toThrow(PlatformFolderProblem);
		expect(named.finishes()).toEqual(["claim_invalid"]);
		const unnamed = folder({ claims: [{ ...claim(), codingWorkerId: "nope" }] });
		await expect(unnamed.writer.writeOne()).rejects.toThrow(PlatformFolderProblem);
		expect(unnamed.finishes()).toEqual([]);
	});

	it("takes finished true or false, and refuses a finish it cannot read", async () => {
		const finished = folder({
			claims: [claim()],
			finish: { schema: "qorpera.coding-results-finish/v1", finished: true },
		});
		expect(await finished.writer.writeOne()).toBe(true);
		const unreadable = folder({ claims: [claim()], finish: { ok: true } });
		await expect(unreadable.writer.writeOne()).rejects.toThrow(PlatformFolderProblem);
	});

	it("drains until nothing is due, and takes no claim once its deadline has passed", async () => {
		const run = folder({
			claims: [claim(), claim({ ...blocked, generation: 2, operationKey: `coding-results:${codingWorkerId}:1:2` })],
		});
		expect(await run.writer.writeDue(10)).toBe(2);
		expect(run.finishes()).toEqual([null, null]);
		const late = folder({ claims: [claim()] });
		const controller = new AbortController();
		controller.abort();
		expect(await late.writer.writeDue(10, controller.signal)).toBe(0);
		expect(late.calls).toHaveLength(0);
	});

	it("refuses an identity or a lease outside the claim's bounds", () => {
		const options = { authority: { publisher: async () => null }, store: {} as never, replication: {} as never };
		expect(() => new CodingResultsWriter({ ...options, workerId: "nope" })).toThrow("identity");
		expect(() => new CodingResultsWriter({ ...options, workerId, leaseSeconds: 29 })).toThrow("lease");
		expect(() => new CodingResultsWriter({ ...options, workerId, leaseSeconds: 901 })).toThrow("lease");
	});
});
