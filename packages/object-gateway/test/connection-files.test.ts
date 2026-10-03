import { createHash } from "node:crypto";
import { parseCompanyStateFile, writeConnectionFile } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it } from "vitest";
import {
	ConnectionFileWriter,
	type ConnectionSettings,
	connectionFileText,
	numberedConnectionPath,
	parseConnectionFileClaim,
} from "../src/connection-files.ts";
import { PlatformFolderProblem } from "../src/platform-folder-writer.ts";

const workerId = "33000000-0000-4000-8000-00000000000a";
const secretId = "33000000-0000-4000-8000-0000000000e1";
const environmentId = "33000000-0000-4000-8000-000000000020";
const profileId = "33000000-0000-4000-8000-000000000010";
const memberId = "33000000-0000-4000-8000-000000000001";
const intentId = "33000000-0000-4000-8000-0000000000f0";
const version = "33000000-0000-4000-8000-0000000000b1";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const gmail = {
	id: secretId,
	service: "gmail",
	account: "team@nordlys.test",
	status: "connected",
	actions: ["read_message", "send_message"],
	connectedBy: memberId,
	connectedAt: "2026-10-03T08:00:00.5Z",
};
const gmailSettings = gmail as unknown as ConnectionSettings;
const website = {
	...gmail,
	service: "website",
	account: "ops+portal@nordlys.test",
	status: "pending",
	actions: [],
	site: "portal.example.com",
	twoStep: "authenticator",
	openedFor: null,
};

function claim(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.connection-file-claim/v1",
		secretId,
		environmentId,
		generation: 3,
		attempt: 1,
		operationKey: `connection-file:${secretId}:3`,
		leaseUntil: "2026-10-03T08:02:00Z",
		marks: 1,
		present: true,
		settings: gmail,
		path: "connections/gmail.md",
		current: null,
		...overrides,
	};
}

/** The database and the store as the writer sees them: every call recorded, commits answered from `outcomes`. */
function folder(options: { claims?: unknown[]; outcomes?: { outcome: string; reason?: string }[] } = {}) {
	const objects = new Map<string, Uint8Array>();
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const claims = [...(options.claims ?? [])];
	const outcomes = [...(options.outcomes ?? [])];
	let manifest = "";
	const put = (bytes: Uint8Array) => {
		objects.set(sha256(bytes), bytes);
		return sha256(bytes);
	};
	/** A file already in the folder: its bytes and manifest in the store, and the claim's `current`. */
	const existing = (path: string, text: string) => {
		const bytes = new TextEncoder().encode(text);
		const fileSha256 = put(bytes);
		const manifestSha256 = put(
			new TextEncoder().encode(
				JSON.stringify({
					schema: "qorpera.cloud-file-manifest/v2",
					fileSha256,
					bytes: bytes.byteLength,
					mediaType: "text/markdown",
					executable: false,
					chunks: [{ sha256: fileSha256, bytes: bytes.byteLength }],
				}),
			),
		);
		return { path, version, manifestSha256, fileSha256, bytes: bytes.byteLength, mediaType: "text/markdown" };
	};
	const authority = {
		async publisher(method: string, args: Record<string, unknown>) {
			calls.push({ method, args });
			switch (method) {
				case "qorpera_claim_connection_file":
					return claims.shift() ?? null;
				case "qorpera_finish_connection_file":
					return { schema: "qorpera.connection-file-finish/v1", finished: true };
				case "qorpera_folder_authorize_object_download": {
					const bytes = objects.get(args.p_sha256 as string);
					if (!bytes) throw new Error("missing object");
					return { schema: "qorpera.folder-object-download/v1", profileId, bytes: bytes.byteLength };
				}
				case "qorpera_folder_open_upload":
					manifest = args.p_manifest as string;
					return {
						schema: "qorpera.folder-upload/v1",
						intentId,
						manifestSha256: sha256(manifest),
						expiresAt: "x",
						present: [],
					};
				case "qorpera_folder_authorize_object_upload":
					return { schema: "qorpera.folder-object-upload/v1", profileId };
				case "qorpera_folder_confirm_object":
					return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes };
				case "qorpera_folder_seal_upload": {
					const parsed = JSON.parse(manifest);
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId,
						file: {
							manifestSha256: sha256(manifest),
							fileSha256: parsed.fileSha256,
							bytes: parsed.bytes,
							mediaType: parsed.mediaType,
							executable: parsed.executable,
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
		async get(profile: string, hash: string, bytes: number) {
			const object = objects.get(hash);
			if (profile !== profileId || !object || object.byteLength !== bytes) throw new Error("Object not found");
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
			expect(sha256(bytes)).toBe(hash);
			await callbacks.authorize();
			objects.set(hash, bytes);
			await callbacks.confirm();
			return "stored" as const;
		},
	};
	const writer = new ConnectionFileWriter({ workerId, authority: authority as never, store, replication });
	const commits = () => calls.filter((call) => call.method === "qorpera_folder_commit");
	const finishes = () =>
		calls.filter((call) => call.method === "qorpera_finish_connection_file").map((call) => call.args.p_problem);
	const committedText = (index = 0) => {
		const unit = (commits()[index]?.args.p_units as Record<string, unknown>[])[0] as {
			file: { fileSha256: string };
			structured: { text: string }[];
		};
		expect(new TextDecoder().decode(objects.get(unit.file.fileSha256))).toBe(unit.structured[0]?.text);
		return unit.structured[0]?.text as string;
	};
	const queue = (...next: unknown[]) => claims.push(...next);
	return { writer, calls, commits, finishes, committedText, existing, queue };
}

describe("connection file claims", () => {
	it("reads a claim and its allow-listed settings", () => {
		expect(parseConnectionFileClaim(null)).toBeNull();
		expect(parseConnectionFileClaim(claim())).toMatchObject({
			secretId,
			generation: 3,
			settings: gmail,
			path: "connections/gmail.md",
		});
		expect(
			parseConnectionFileClaim(claim({ settings: website, path: "connections/portal-example-com.md" }))?.settings,
		).toEqual(website);
		expect(parseConnectionFileClaim(claim({ present: false, settings: null, path: null }))?.present).toBe(false);
	});

	it.each([
		["a setting outside the allow-list", { settings: { ...gmail, purpose: "Mail" } }],
		["an envelope beside the settings", { settings: { ...gmail, envelope: "c2VjcmV0" } }],
		["a field beside the claim", { token: "secret-token" }],
		["website keys on another service", { settings: { ...gmail, site: "mail.example.com" } }],
		["a website status on another service", { settings: { ...gmail, status: "pending" } }],
		["another operation key", { operationKey: `connection-file:${secretId}:4` }],
		["a path outside connections/", { path: "rules/gmail.md" }],
		["settings for a file that goes", { present: false, path: null }],
	])("refuses %s", (_name, overrides) => {
		expect(() => parseConnectionFileClaim(claim(overrides))).toThrow(PlatformFolderProblem);
	});
});

describe("connection file text", () => {
	it("writes a new file with the canonical writer", () => {
		const text = connectionFileText("connections/gmail.md", gmailSettings, null);
		expect(text).toBe(writeConnectionFile({ ...gmailSettings, purpose: "" }));
		expect(parseCompanyStateFile("connections/gmail.md", text)).toMatchObject({ ok: true });
	});

	it("changes only the settings that differ and keeps the company's text and layout", () => {
		const before = `---\r\nid: ${secretId}\r\nservice: gmail\r\naccount: old@nordlys.test # renamed later\r\nstatus: connected\r\nactions: [read_message, send_message]\r\nconnected_by: ${memberId}\r\nconnected_at: 2026-10-03T08:00:00.5Z\r\n---\r\nThe team inbox.\r\n`;
		const after = connectionFileText("connections/gmail.md", gmailSettings, before);
		expect(after).toBe(before.replace("account: old@nordlys.test # renamed later", "account: team@nordlys.test"));
		expect(connectionFileText("connections/gmail.md", gmailSettings, after)).toBe(after);
	});

	it("keeps the text below a settings block the parser refuses", () => {
		const text = connectionFileText("connections/gmail.md", gmailSettings, "---\nid: nope\n---\nWhat it is for.\n");
		expect(text).toBe(writeConnectionFile({ ...gmailSettings, purpose: "What it is for." }));
	});

	it("numbers a taken name within the name rule", () => {
		expect(numberedConnectionPath("connections/gmail.md", 2)).toBe("connections/gmail-2.md");
		expect(numberedConnectionPath(`connections/${"a".repeat(60)}-bbb.md`, 12)).toBe(
			`connections/${"a".repeat(60)}-12.md`,
		);
	});
});

describe("ConnectionFileWriter", () => {
	it("does nothing when nothing is due", async () => {
		const { writer, calls } = folder();
		expect(await writer.writeOne()).toBe(false);
		expect(calls.map((call) => call.method)).toEqual(["qorpera_claim_connection_file"]);
	});

	it("stages and commits a new file as the platform, then finishes", async () => {
		const { writer, calls, commits, finishes, committedText } = folder({ claims: [claim()] });
		expect(await writer.writeOne()).toBe(true);
		const commit = commits()[0]?.args as Record<string, unknown>;
		expect(commit).toMatchObject({
			p_environment_id: environmentId,
			p_actor: { kind: "platform" },
			p_operation_key: `connection-file:${secretId}:3`,
		});
		const unit = (commit.p_units as Record<string, unknown>[])[0];
		expect(unit).toMatchObject({
			op: "write",
			path: "connections/gmail.md",
			structured: [{ kind: "connection", parserVersion: 1 }],
		});
		expect(unit).not.toHaveProperty("expectedVersion");
		expect(committedText()).toBe(writeConnectionFile({ ...gmailSettings, purpose: "" }));
		for (const call of calls.filter((entry) => entry.method.startsWith("qorpera_folder_")))
			expect(call.args.p_actor).toEqual({ kind: "platform" });
		expect(finishes()).toEqual([null]);
	});

	it("rewrites an existing file at its version, keeping its text, and skips one that already matches", async () => {
		const run = folder();
		const current = run.existing(
			"connections/team.md",
			writeConnectionFile({ ...gmailSettings, account: "old@nordlys.test", purpose: "Ours." }),
		);
		const matching = run.existing("connections/team.md", writeConnectionFile({ ...gmailSettings, purpose: "Ours." }));
		run.queue(
			claim({ current }),
			claim({ current: matching, generation: 4, operationKey: `connection-file:${secretId}:4` }),
		);
		expect(await run.writer.writeOne()).toBe(true);
		expect(await run.writer.writeOne()).toBe(true);
		expect(run.commits()).toHaveLength(1);
		expect(run.commits()[0]?.args.p_units).toMatchObject([{ path: "connections/team.md", expectedVersion: version }]);
		expect(run.committedText()).toBe(writeConnectionFile({ ...gmailSettings, purpose: "Ours." }));
		expect(run.finishes()).toEqual([null, null]);
	});

	it("numbers a new file whose name is taken, with a new operation key per try", async () => {
		const { writer, commits, finishes } = folder({
			claims: [claim()],
			outcomes: [
				{ outcome: "conflict", reason: "exists" },
				{ outcome: "conflict", reason: "exists" },
				{ outcome: "saved" },
			],
		});
		await writer.writeOne();
		expect(
			commits().map((call) => [call.args.p_operation_key, (call.args.p_units as { path: string }[])[0]?.path]),
		).toEqual([
			[`connection-file:${secretId}:3`, "connections/gmail.md"],
			[`connection-file:${secretId}:3:2`, "connections/gmail-2.md"],
			[`connection-file:${secretId}:3:3`, "connections/gmail-3.md"],
		]);
		expect(finishes()).toEqual([null]);
	});

	it("backs off with the commit's reason when a member changed the file meanwhile", async () => {
		const run = folder({ outcomes: [{ outcome: "conflict", reason: "version_changed" }] });
		const current = run.existing(
			"connections/gmail.md",
			writeConnectionFile({ ...gmailSettings, account: "old@nordlys.test", purpose: "" }),
		);
		run.queue(claim({ current }));
		await run.writer.writeOne();
		expect(run.finishes()).toEqual(["version_changed"]);
	});

	it("deletes the file of a connection that is gone, at its version", async () => {
		const run = folder();
		const current = run.existing("connections/gmail.md", writeConnectionFile({ ...gmailSettings, purpose: "" }));
		run.queue(
			claim({ present: false, settings: null, path: null, current }),
			claim({
				present: false,
				settings: null,
				path: null,
				generation: 4,
				operationKey: `connection-file:${secretId}:4`,
			}),
		);
		await run.writer.writeOne();
		await run.writer.writeOne();
		expect(run.commits().map((call) => call.args.p_units)).toEqual([
			[{ op: "delete", path: "connections/gmail.md", expectedVersion: version }],
		]);
		expect(run.finishes()).toEqual([null, null]);
	});

	it("never stages or commits a claim that carries anything outside the allow-list, and finishes it with a code", async () => {
		const sentinel = "sentinel-secret-value";
		const { writer, calls, finishes } = folder({ claims: [claim({ settings: { ...gmail, password: sentinel } })] });
		await expect(writer.writeOne()).rejects.toThrow(PlatformFolderProblem);
		expect(calls.map((call) => call.method)).toEqual([
			"qorpera_claim_connection_file",
			"qorpera_finish_connection_file",
		]);
		expect(finishes()).toEqual(["claim_invalid"]);
		expect(JSON.stringify(calls.slice(1))).not.toContain(sentinel);
	});

	it("writes a website account's file with its own keys", async () => {
		const { writer, committedText } = folder({
			claims: [claim({ settings: website, path: "connections/portal-example-com.md" })],
		});
		await writer.writeOne();
		expect(parseCompanyStateFile("connections/portal-example-com.md", committedText())).toMatchObject({
			ok: true,
			file: {
				kind: "connection",
				site: "portal.example.com",
				twoStep: "authenticator",
				openedFor: null,
				status: "pending",
			},
		});
	});
});
