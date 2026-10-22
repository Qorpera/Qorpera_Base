import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	BANK_SUMMARY_MAX_BYTES,
	BANK_SUMMARY_PATH,
	BankSummaryWriter,
	bankSummaryText,
	parseBankSummaryClaim,
} from "../src/bank-summary-files.ts";
import { PlatformFolderProblem } from "../src/platform-folder-writer.ts";

/* The bank summary's writer (bank-summary-files.ts): claim a company whose newest summary the folder lacks, make bank/
 * when it is missing, write bank/summary.json as the platform under the claim's key, finish. */

const workerId = "98300000-0000-4000-8000-0000000000e1";
const environmentId = "92400000-0000-4000-8000-000000000020";
const profileId = "92400000-0000-4000-8000-000000000010";
const intentId = "98300000-0000-4000-8000-0000000000f0";
const version = "98300000-0000-4000-8000-0000000000c1";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const summary = { schema: "qorpera.bank-summary/v1", bank: "Danske Bank", pausedSince: null, saldo: 282730 };

function claim(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.bank-summary-claim/v1",
		profileId,
		environmentId,
		generation: 3,
		attempt: 1,
		operationKey: `bank-summary:${profileId}:3:1`,
		folderPresent: true,
		currentVersion: null,
		summary,
		leaseUntil: "2026-10-22T12:01:00Z",
		...overrides,
	};
}

/** The database and the store as the writer sees them: every call recorded, commits answered from `outcomes`. */
function folder(
	options: { claims?: unknown[]; outcomes?: { outcome: string; reason?: string }[]; finish?: unknown } = {},
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
				case "qorpera_claim_bank_summary_file":
					return claims.shift() ?? null;
				case "qorpera_finish_bank_summary_file":
					return options.finish ?? { schema: "qorpera.bank-summary-finish/v1", finished: true };
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
	const writer = new BankSummaryWriter({ workerId, authority: authority as never, store, replication });
	const commits = () => calls.filter((call) => call.method === "qorpera_folder_commit");
	const finishes = () =>
		calls.filter((call) => call.method === "qorpera_finish_bank_summary_file").map((call) => call.args.p_problem);
	const written = (unit: { file: { fileSha256: string } }) =>
		new TextDecoder().decode(objects.get(unit.file.fileSha256));
	return { writer, calls, commits, finishes, written };
}

describe("bank summary claims", () => {
	it("reads a claim; null when nothing is due", () => {
		expect(parseBankSummaryClaim(null)).toBeNull();
		expect(parseBankSummaryClaim(claim())).toEqual({
			profileId,
			environmentId,
			generation: 3,
			operationKey: `bank-summary:${profileId}:3:1`,
			folderPresent: true,
			currentVersion: null,
			summary,
		});
	});

	it("refuses a claim with a stray field, another key, or a summary of another kind", () => {
		for (const bad of [
			{ ...claim(), extra: 1 },
			claim({ operationKey: `bank-summary:${profileId}:4:1` }),
			claim({ summary: { schema: "other" } }),
			claim({ summary: [] }),
			claim({ currentVersion: "v1" }),
			claim({ generation: 0 }),
		]) {
			expect(() => parseBankSummaryClaim(bad)).toThrow(PlatformFolderProblem);
		}
	});
});

describe("BankSummaryWriter", () => {
	it("does nothing when nothing is due", async () => {
		const { writer, calls } = folder();
		expect(await writer.writeOne()).toBe(false);
		expect(calls).toEqual([
			{ method: "qorpera_claim_bank_summary_file", args: { p_worker: workerId, p_lease_seconds: 60 } },
		]);
	});

	it("makes bank/ when it is missing, writes the summary as the platform under the claim's key, then finishes", async () => {
		const { writer, calls, commits, finishes, written } = folder({ claims: [claim({ folderPresent: false })] });
		expect(await writer.writeOne()).toBe(true);
		expect(commits().map((call) => call.args.p_operation_key)).toEqual([
			`bank-summary:${profileId}:3:1:folder`,
			`bank-summary:${profileId}:3:1`,
		]);
		expect(commits()[0]?.args.p_units).toEqual([{ op: "mkdir", path: "bank" }]);
		const unit = (commits()[1]?.args.p_units as Record<string, unknown>[])[0] as {
			op: string;
			path: string;
			file: { fileSha256: string; mediaType: string };
		};
		expect(unit).toMatchObject({ op: "write", path: BANK_SUMMARY_PATH, file: { mediaType: "application/json" } });
		expect(unit).not.toHaveProperty("expectedVersion");
		expect(JSON.parse(written(unit))).toEqual(summary);
		expect(written(unit)).toBe(bankSummaryText(summary));
		for (const call of calls.filter((entry) => entry.method.startsWith("qorpera_folder_")))
			expect(call.args.p_actor).toEqual({ kind: "platform" });
		expect(calls.at(-1)).toEqual({
			method: "qorpera_finish_bank_summary_file",
			args: { p_worker: workerId, p_profile_id: profileId, p_generation: 3, p_problem: null },
		});
		expect(finishes()).toEqual([null]);
	});

	it("takes a bank/ a member made meanwhile, and expects the file's version the claim read", async () => {
		const run = folder({
			claims: [claim({ folderPresent: false, currentVersion: version })],
			outcomes: [{ outcome: "refused", reason: "exists" }, { outcome: "saved" }],
		});
		await run.writer.writeOne();
		expect((run.commits()[1]?.args.p_units as Record<string, unknown>[])[0]).toMatchObject({
			path: BANK_SUMMARY_PATH,
			expectedVersion: version,
		});
		expect(run.finishes()).toEqual([null]);
	});

	it("backs off with the commit's reason, and turns a reason outside the code rule into refused", async () => {
		const run = folder({
			claims: [claim(), claim({ folderPresent: false })],
			outcomes: [
				{ outcome: "conflict", reason: "stale" },
				{ outcome: "refused", reason: "Not A Code!" },
			],
		});
		await run.writer.writeOne();
		await run.writer.writeOne();
		expect(run.finishes()).toEqual(["stale", "refused"]);
		// The second claim stopped at bank/: no file was written.
		expect(run.commits()).toHaveLength(2);
	});

	it("writes a summary up to the Bank page's read limit, and backs off without writing one past it", async () => {
		// The page reads a file: source up to its own limit; the writer keeps to exactly that one.
		const reader = readFileSync(new URL("../../web/src/app/interface-folder.ts", import.meta.url), "utf8");
		expect(/const FILE_MAX_BYTES = 256 \* 1024;/.test(reader)).toBe(true);
		expect(BANK_SUMMARY_MAX_BYTES).toBe(256 * 1024);
		// A summary whose file is exactly the limit: the filler fills what the rest leaves.
		const rest = bankSummaryText({ ...summary, filler: "" }).length;
		const fits = { ...summary, filler: "x".repeat(BANK_SUMMARY_MAX_BYTES - rest) };
		const over = { ...summary, filler: "x".repeat(BANK_SUMMARY_MAX_BYTES - rest + 1) };
		const run = folder({ claims: [claim({ summary: fits }), claim({ summary: over })] });
		await run.writer.writeOne();
		const unit = (run.commits()[0]?.args.p_units as Record<string, unknown>[])[0] as { file: { bytes: number } };
		expect(unit.file.bytes).toBe(BANK_SUMMARY_MAX_BYTES);
		await run.writer.writeOne();
		expect(run.commits()).toHaveLength(1);
		expect(run.finishes()).toEqual([null, "file_too_large"]);
	});

	it("finishes a malformed claim that names its company with the problem, and refuses a malformed finish", async () => {
		const run = folder({ claims: [{ ...claim(), extra: 1 }] });
		await expect(run.writer.writeOne()).rejects.toThrow(PlatformFolderProblem);
		expect(run.finishes()).toEqual(["claim_invalid"]);
		const bad = folder({ claims: [claim()], finish: { schema: "other" } });
		await expect(bad.writer.writeOne()).rejects.toThrow(PlatformFolderProblem);
	});
});
