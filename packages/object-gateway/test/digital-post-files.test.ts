import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DIGITAL_POST_INDEX,
	DIGITAL_POST_INDEX_MAX_BYTES,
	DigitalPostLetterWriter,
	digitalPostIndexText,
	parseDigitalPostLetterClaim,
} from "../src/digital-post-files.ts";
import { PlatformFolderProblem } from "../src/platform-folder-writer.ts";

/* The Digital Post letters' writer (digital-post-files.ts): claim a kept letter, read its staged files back in pieces and
 * check them, make the folders it lacks, put the letter's folder whole and the index in one change set as the platform,
 * finish. A folder already there gets only the files it lacks. */

const workerId = "98700000-0000-4000-8000-0000000000e1";
const environmentId = "92400000-0000-4000-8000-000000000020";
const profileId = "92400000-0000-4000-8000-000000000010";
const letterId = "98700000-0000-4000-8000-0000000000a1";
const intentId = "98700000-0000-4000-8000-0000000000f0";
const version = "98700000-0000-4000-8000-0000000000c1";
const folderPath = "digital-post/2026/2026-10-22 Skattestyrelsen - Årsopgørelse (6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a)";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const MD = Buffer.from("# Årsopgørelse\n");
const JSON_FILE = Buffer.from("{}\n");
const PDF = Buffer.alloc(1024 * 1024 + 600 * 1024, 7);
const files = [
	{ name: "letter.md", mediaType: "text/markdown", bytes: MD.byteLength, sha256: digest(MD), version: null },
	{
		name: "letter.json",
		mediaType: "application/json",
		bytes: JSON_FILE.byteLength,
		sha256: digest(JSON_FILE),
		version: null,
	},
	{ name: "brev.pdf", mediaType: "application/pdf", bytes: PDF.byteLength, sha256: digest(PDF), version: null },
];
const staged = [MD, JSON_FILE, PDF];
const summary = { messageUuid: "6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a", folder: folderPath, title: "Årsopgørelse" };

function claim(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.digital-post-letter-claim/v1",
		letterId,
		profileId,
		environmentId,
		attempt: 1,
		operationKey: `digital-post:${letterId}:1`,
		folder: folderPath,
		rootPresent: false,
		yearPresent: false,
		folderPresent: false,
		files,
		indexVersion: null,
		index: [summary],
		leaseUntil: "2026-10-22T12:05:00Z",
		...overrides,
	};
}

/** The database and the store as the writer sees them: every call recorded, commits answered unit by unit. */
function folder(
	options: { claims?: unknown[]; outcome?: (unit: Record<string, unknown>) => string; content?: Buffer[] } = {},
) {
	const objects = new Map<string, Uint8Array>();
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const claims = [...(options.claims ?? [])];
	const content = options.content ?? staged;
	let manifest = "";
	const authority = {
		async publisher(method: string, args: Record<string, unknown>) {
			calls.push({ method, args });
			switch (method) {
				case "qorpera_claim_digital_post_letter_file":
					return claims.shift() ?? null;
				case "qorpera_read_digital_post_chunk": {
					expect(args.p_worker).toBe(workerId);
					expect(args.p_length as number).toBeLessThanOrEqual(512 * 1024);
					const whole = content[args.p_file_index as number] as Buffer;
					const start = (args.p_chunk_index as number) * 1024 * 1024 + (args.p_offset as number);
					return {
						schema: "qorpera.digital-post-chunk-piece/v1",
						content: whole.subarray(start, start + (args.p_length as number)).toString("base64"),
					};
				}
				case "qorpera_finish_digital_post_letter_file":
					return { schema: "qorpera.digital-post-letter-finish/v1", finished: true };
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
						units: (args.p_units as Record<string, unknown>[]).map((unit, index) => ({
							unit: index + 1,
							outcome: options.outcome?.(unit) ?? "saved",
							...(options.outcome?.(unit) === "conflict" ? { reason: "stale" } : {}),
						})),
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
	const writer = new DigitalPostLetterWriter({ workerId, authority: authority as never, store, replication });
	const commits = () => calls.filter((call) => call.method === "qorpera_folder_commit");
	const finishes = () =>
		calls
			.filter((call) => call.method === "qorpera_finish_digital_post_letter_file")
			.map((call) => call.args.p_problem);
	const bytes = (file: { fileSha256: string }) => objects.get(file.fileSha256);
	return { writer, calls, commits, finishes, bytes };
}

describe("DigitalPostLetterWriter", () => {
	it("makes the folders, puts the letter's folder whole and the index in one change set, and finishes", async () => {
		const f = folder({ claims: [claim()] });
		expect(await f.writer.writeOne()).toBe(true);
		const [commit] = f.commits();
		expect(commit?.args.p_operation_key).toBe(`digital-post:${letterId}:1`);
		expect(commit?.args.p_actor).toEqual({ kind: "platform" });
		const units = commit?.args.p_units as Record<string, unknown>[];
		expect(units.map((unit) => [unit.op, unit.path])).toEqual([
			["mkdir", "digital-post"],
			["mkdir", "digital-post/2026"],
			["new_folder", folderPath],
			["write", DIGITAL_POST_INDEX],
		]);
		const contents = units[2]?.contents as { path: string; kind: string; file: { fileSha256: string } }[];
		expect(contents.map((item) => [item.path, item.kind])).toEqual([
			["letter.md", "file"],
			["letter.json", "file"],
			["brev.pdf", "file"],
		]);
		expect(Buffer.from(f.bytes(contents[2]?.file as { fileSha256: string }) ?? [])).toEqual(PDF);
		const index = JSON.parse(new TextDecoder().decode(f.bytes(units[3]?.file as { fileSha256: string })));
		expect(index).toEqual({ schema: "qorpera.digital-post-letters/v1", letters: [summary] });
		expect(units[3]).not.toHaveProperty("expectedVersion");
		// The PDF was read in pieces of at most 512 KiB: 1.6 MiB is four.
		const reads = f.calls.filter(
			(call) => call.method === "qorpera_read_digital_post_chunk" && call.args.p_file_index === 2,
		);
		expect(reads.map((call) => [call.args.p_chunk_index, call.args.p_offset, call.args.p_length])).toEqual([
			[0, 0, 512 * 1024],
			[0, 512 * 1024, 512 * 1024],
			[1, 0, 512 * 1024],
			[1, 512 * 1024, 88 * 1024],
		]);
		expect(f.finishes()).toEqual([null]);
		expect(await f.writer.writeOne()).toBe(false);
	});

	it("gives a letter's folder that is already there only the files it lacks, at the index's version", async () => {
		const f = folder({
			claims: [
				claim({
					rootPresent: true,
					yearPresent: true,
					folderPresent: true,
					files: [{ ...files[0], version }, { ...files[1], version }, files[2]],
					indexVersion: version,
				}),
			],
		});
		await f.writer.writeOne();
		const units = f.commits()[0]?.args.p_units as Record<string, unknown>[];
		expect(units.map((unit) => [unit.op, unit.path])).toEqual([
			["write", `${folderPath}/brev.pdf`],
			["write", DIGITAL_POST_INDEX],
		]);
		expect(units[1]?.expectedVersion).toBe(version);
		expect(
			f.calls.some((call) => call.method === "qorpera_read_digital_post_chunk" && call.args.p_file_index === 0),
		).toBe(false);
		expect(f.finishes()).toEqual([null]);
	});

	it("backs off when a unit is not saved, and when a staged file differs from what was kept", async () => {
		const stale = folder({
			claims: [claim()],
			outcome: (unit) => (unit.path === DIGITAL_POST_INDEX ? "conflict" : "saved"),
		});
		await stale.writer.writeOne();
		expect(stale.finishes()).toEqual(["stale"]);
		const changed = folder({ claims: [claim()], content: [MD, JSON_FILE, Buffer.alloc(PDF.byteLength, 8)] });
		await changed.writer.writeOne();
		expect(changed.finishes()).toEqual(["chunk_invalid"]);
		expect(changed.commits()).toEqual([]);
	});

	it("finishes a claim it cannot read with its problem when it names the letter", async () => {
		const f = folder({ claims: [claim({ operationKey: "digital-post:other:1" })] });
		await expect(f.writer.writeOne()).rejects.toBeInstanceOf(PlatformFolderProblem);
		expect(f.finishes()).toEqual(["claim_invalid"]);
	});
});

describe("parseDigitalPostLetterClaim", () => {
	it("refuses a folder or a file outside the letter's place", () => {
		expect(parseDigitalPostLetterClaim(null)).toBeNull();
		expect(parseDigitalPostLetterClaim(claim())?.files[2]).toEqual(files[2]);
		for (const bad of [
			claim({ folder: "elsewhere/2026/x" }),
			claim({ folder: "digital-post/2026/a:b" }),
			claim({ files: [files[0], { ...files[1], name: "../x" }, files[2]] }),
			claim({ files: [files[0], { ...files[1], mediaType: "Text/Plain" }, files[2]] }),
			claim({ files: [files[0], { ...files[1], version: "not-a-version" }, files[2]] }),
			claim({ extra: true }),
		])
			expect(() => parseDigitalPostLetterClaim(bad)).toThrow(PlatformFolderProblem);
	});
});

describe("digitalPostIndexText", () => {
	it("leaves out the oldest letters until the index fits what the Mailbox reads", () => {
		const letters = Array.from({ length: 400 }, (_, index) => ({ ...summary, title: `${index} ${"x".repeat(900)}` }));
		const text = digitalPostIndexText(letters);
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(DIGITAL_POST_INDEX_MAX_BYTES);
		const kept = JSON.parse(text).letters as { title: string }[];
		expect(kept.length).toBeGreaterThan(100);
		expect(kept.length).toBeLessThan(400);
		expect(kept[0]?.title.startsWith("0 ")).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
	});
});
