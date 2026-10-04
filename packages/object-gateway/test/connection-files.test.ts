import { createHash } from "node:crypto";
import { parseCompanyStateFile, writeConnectionFile } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it } from "vitest";
import {
	ConnectionFileWriter,
	type ConnectionSettings,
	connectionFileText,
	hookFileText,
	numberedConnectionPath,
	parseConnectionFileClaim,
} from "../src/connection-files.ts";
import { ObjectDependencyError } from "../src/dependency.ts";
import { drainPlatformClaims, PlatformFolderProblem } from "../src/platform-folder-writer.ts";

const workerId = "33000000-0000-4000-8000-00000000000a";
const secretId = "33000000-0000-4000-8000-0000000000e1";
const environmentId = "33000000-0000-4000-8000-000000000020";
const profileId = "33000000-0000-4000-8000-000000000010";
const memberId = "33000000-0000-4000-8000-000000000001";
const intentId = "33000000-0000-4000-8000-0000000000f0";
const version = "33000000-0000-4000-8000-0000000000b1";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

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
function folder(
	options: {
		claims?: unknown[];
		outcomes?: { outcome: string; reason?: string }[];
		storeMisses?: boolean;
		finish?: unknown;
		commitThrows?: Error;
	} = {},
) {
	const objects = new Map<string, Uint8Array>();
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const claims = [...(options.claims ?? [])];
	const outcomes = [...(options.outcomes ?? [])];
	let manifest = "";
	const put = (bytes: Uint8Array) => {
		objects.set(digest(bytes), bytes);
		return digest(bytes);
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
					return options.finish ?? { schema: "qorpera.connection-file-finish/v1", finished: true };
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
						manifestSha256: digest(manifest),
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
							manifestSha256: digest(manifest),
							fileSha256: parsed.fileSha256,
							bytes: parsed.bytes,
							mediaType: parsed.mediaType,
							executable: parsed.executable,
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
		async get(profile: string, hash: string, bytes: number) {
			if (options.storeMisses) throw new Error("Object not found");
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
			expect(digest(bytes)).toBe(hash);
			await callbacks.authorize();
			objects.set(hash, bytes);
			await callbacks.confirm();
			return "stored" as const;
		},
	};
	const readFallback = async (profile: string, hash: string) => {
		const object = objects.get(hash);
		if (profile !== profileId || !object) throw new Error("Object not found");
		return object;
	};
	const writer = new ConnectionFileWriter({
		workerId,
		authority: authority as never,
		store,
		replication,
		readFallback,
	});
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

describe("connection file writer, review round 1", () => {
	it("stages the canonical version-2 manifest the runtime makes, so the hashes agree", async () => {
		const { writer, calls, committedText } = folder({ claims: [claim()] });
		await writer.writeOne();
		const text = committedText();
		const hash = digest(text);
		const bytes = new TextEncoder().encode(text).byteLength;
		expect(calls.find((call) => call.method === "qorpera_folder_open_upload")?.args.p_manifest).toBe(
			`{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${hash}","bytes":${bytes},"mediaType":"text/markdown","executable":false,"chunks":[{"sha256":"${hash}","bytes":${bytes}}]}`,
		);
	});

	it("keeps a setting that did not change exactly as written, note included", () => {
		const before = `---\nid: ${secretId}\nservice: gmail # the shared one\naccount: old@nordlys.test\nstatus: connected\nactions: [read_message, send_message]\nconnected_by: ${memberId}\nconnected_at: 2026-10-03T08:00:00.5Z\n---\n`;
		const after = connectionFileText("connections/gmail.md", gmailSettings, before);
		expect(after).toContain("service: gmail # the shared one\n");
		expect(after).toContain("account: team@nordlys.test\n");
	});

	it("counts an account's length in characters, as the database does", () => {
		const account = "\u{1F600}".repeat(254);
		expect(
			(parseConnectionFileClaim(claim({ settings: { ...gmail, account } }))?.settings as ConnectionSettings).account,
		).toBe(account);
		expect(() => parseConnectionFileClaim(claim({ settings: { ...gmail, account: `${account}x` } }))).toThrow(
			PlatformFolderProblem,
		);
	});

	it("reads a file its own store lacks from the Storage copy", async () => {
		const run = folder({ storeMisses: true });
		const current = run.existing(
			"connections/gmail.md",
			writeConnectionFile({ ...gmailSettings, account: "old@nordlys.test", purpose: "Ours." }),
		);
		run.queue(claim({ current }));
		await run.writer.writeOne();
		expect(run.finishes()).toEqual([null]);
		expect(run.committedText()).toBe(writeConnectionFile({ ...gmailSettings, purpose: "Ours." }));
	});

	it("stages the bytes once for every name it tries", async () => {
		const { writer, calls, commits } = folder({
			claims: [claim()],
			outcomes: [{ outcome: "conflict", reason: "exists" }, { outcome: "saved" }],
		});
		await writer.writeOne();
		expect(commits()).toHaveLength(2);
		expect(calls.filter((call) => call.method === "qorpera_folder_open_upload")).toHaveLength(1);
	});

	it("accepts a finish another writer's claim superseded, and refuses an answer it cannot read", async () => {
		const superseded = folder({
			claims: [claim()],
			finish: { schema: "qorpera.connection-file-finish/v1", finished: false },
		});
		expect(await superseded.writer.writeOne()).toBe(true);
		const unreadable = folder({ claims: [claim()], finish: { ok: true } });
		await expect(unreadable.writer.writeOne()).rejects.toThrow(PlatformFolderProblem);
	});
});

describe("connection file writer, review round 2", () => {
	it("backs off when a delete finds the file moved, so the next claim finds it through the index", async () => {
		const run = folder({ outcomes: [{ outcome: "conflict", reason: "missing" }] });
		const current = run.existing("connections/gmail.md", writeConnectionFile({ ...gmailSettings, purpose: "" }));
		run.queue(claim({ present: false, settings: null, path: null, current }));
		await run.writer.writeOne();
		expect(run.finishes()).toEqual(["missing"]);
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

	it("turns a reason outside the code rule into refused", async () => {
		const run = folder({ claims: [claim()], outcomes: [{ outcome: "refused", reason: "Not A Code!" }] });
		await run.writer.writeOne();
		expect(run.finishes()).toEqual(["refused"]);
	});

	it("takes no new claim once its deadline has passed", async () => {
		const controller = new AbortController();
		let claims = 0;
		const handled = await drainPlatformClaims(
			10,
			async () => {
				claims++;
				controller.abort();
				return true;
			},
			controller.signal,
		);
		expect([handled, claims]).toEqual([1, 1]);
	});
});

describe("connection file writer, review round 3", () => {
	it("maps an unreadable reason on the delete path to refused", async () => {
		const run = folder({ outcomes: [{ outcome: "refused", reason: "Gone? Maybe!" }] });
		const current = run.existing("connections/gmail.md", writeConnectionFile({ ...gmailSettings, purpose: "" }));
		run.queue(claim({ present: false, settings: null, path: null, current }));
		await run.writer.writeOne();
		expect(run.finishes()).toEqual(["refused"]);
	});

	it("takes no claim once the drain's deadline has passed", async () => {
		const run = folder({ claims: [claim()] });
		const controller = new AbortController();
		controller.abort();
		expect(await run.writer.writeDue(10, controller.signal)).toBe(0);
		expect(run.calls).toHaveLength(0);
	});
});

describe("hook and mailbox files (E1)", () => {
	const hookSettings = {
		id: secretId,
		name: "stripe-payments",
		proof: "stripe",
		status: "active",
		maxBodyBytes: 65536,
		perMinute: 60,
		createdBy: memberId,
		createdAt: "2026-10-04T08:00:00Z",
	};
	const mailboxSettings = {
		id: secretId,
		address: "support@inbox.qorpera.com",
		status: "active",
		createdBy: memberId,
		createdAt: "2026-10-04T08:00:00Z",
	};
	const hookBody = "Payments from Stripe wake the Analyst.";
	const hookClaim = (overrides: Record<string, unknown> = {}) =>
		claim({
			subjectKind: "hook",
			operationKey: `hook-file:${secretId}:3`,
			settings: hookSettings,
			path: "connections/hook-stripe-payments.md",
			body: hookBody,
			...overrides,
		});

	it("reads a hook's and a mailbox's claim by their own allow-lists, and a claim from before E1 as a vault's", () => {
		expect(parseConnectionFileClaim(hookClaim())).toMatchObject({ subjectKind: "hook", body: hookBody });
		expect(
			parseConnectionFileClaim(
				claim({
					subjectKind: "mailbox",
					operationKey: `mailbox-file:${secretId}:3`,
					settings: mailboxSettings,
					path: "connections/mailbox-support.md",
					body: "Customer support.",
				}),
			)?.settings,
		).toEqual(mailboxSettings);
		expect(parseConnectionFileClaim(claim())?.subjectKind).toBe("vault");
		expect(parseConnectionFileClaim(claim({ subjectKind: "vault" }))?.subjectKind).toBe("vault");
		for (const overrides of [
			// A hook's address, a signing secret, or anything else outside the allow-list.
			{ settings: { ...hookSettings, address: "Zm9v" } },
			{ settings: { ...hookSettings, signingSecret: "whsec_x" } },
			// The vault's key, a vault's name, or a body on a vault claim.
			{ operationKey: `connection-file:${secretId}:3` },
			{ path: "connections/stripe-payments.md" },
			{
				subjectKind: "vault",
				operationKey: `connection-file:${secretId}:3`,
				settings: gmail,
				path: "connections/gmail.md",
			},
			{ settings: { ...hookSettings, id: memberId } },
			{ subjectKind: "website" },
		])
			expect(() => parseConnectionFileClaim(hookClaim(overrides))).toThrow(PlatformFolderProblem);
		expect(() => parseConnectionFileClaim(claim({ path: "connections/hook-gmail.md" }))).toThrow(
			PlatformFolderProblem,
		);
	});

	it("starts a new hook's file with its purpose, and changes only the settings that differ", () => {
		const fresh = hookFileText("hook", "connections/hook-x.md", hookSettings as never, null, "Stripe payments.");
		expect(parseCompanyStateFile("connections/hook-x.md", fresh)).toMatchObject({
			ok: true,
			file: { kind: "hook", name: "stripe-payments", purpose: "Stripe payments." },
		});
		const edited = fresh.replace("Stripe payments.", "Payments, and what the Analyst does with them.");
		const paused = hookFileText(
			"hook",
			"connections/hook-x.md",
			{ ...hookSettings, status: "paused" } as never,
			edited,
			"x",
		);
		expect(paused).toBe(edited.replace("status: active", "status: paused"));
	});

	it("writes, commits as a hook's file, and finishes with its kind", async () => {
		const { writer, calls, commits, committedText } = folder({ claims: [hookClaim()] });
		expect(await writer.writeOne()).toBe(true);
		const unit = (commits()[0]?.args.p_units as Record<string, unknown>[])[0] as {
			path: string;
			structured: { kind: string }[];
		};
		expect(unit.path).toBe("connections/hook-stripe-payments.md");
		expect(unit.structured[0]?.kind).toBe("hook");
		expect(commits()[0]?.args.p_operation_key).toBe(`hook-file:${secretId}:3`);
		expect(committedText()).toContain("Payments from Stripe wake the Analyst.");
		expect(committedText()).not.toContain("address");
		const finish = calls.find((call) => call.method === "qorpera_finish_connection_file");
		expect(finish?.args).toMatchObject({ p_subject_kind: "hook", p_secret_id: secretId, p_problem: null });
	});

	it("finishes a vault secret's claim without naming a kind, as a database from before E1 takes it", async () => {
		const { writer, calls } = folder({ claims: [claim()] });
		await writer.writeOne();
		const finish = calls.find((call) => call.method === "qorpera_finish_connection_file");
		expect(finish?.args).not.toHaveProperty("p_subject_kind");
	});
});
