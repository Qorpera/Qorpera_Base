import { createHash, createHmac, randomUUID } from "node:crypto";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	type CloudCompanyFolderFile,
	type CloudCompanyFolderUnit,
} from "@qorpera/runtime/cloud-company-folder-client";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyFolderRpcError } from "@qorpera/runtime/cloud-company-path-refusal";
import {
	CloudRunLog,
	CloudRunLogGone,
	type CloudRunLogOrigin,
	type CloudRunLogPreconditions,
} from "@qorpera/runtime/cloud-run-log";
import { CloudRunLogCompanyFolder } from "@qorpera/runtime/cloud-run-log-folder";
import { CloudRuntimeDiagnosticError } from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const signal = new AbortController().signal;
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const ORIGIN_PROBLEM =
	"run.toml names the run's conversation, parent step, the run it continues and whether it is narrow";
const logs: CloudRunLog[] = [];
afterEach(async () => {
	for (const log of logs.splice(0)) await log.close(AbortSignal.abort()).catch(() => undefined);
});

interface WireUnit {
	op: "write" | "mkdir" | "new_folder";
	path: string;
	file?: CloudCompanyFolderFile;
	expectedVersion?: string;
	contents?: { path: string; kind: "file" | "folder"; file?: CloudCompanyFolderFile }[];
	structured?: { path: string; kind: string; text?: string; parse?: { kind: string }; problems?: unknown[] }[];
}
interface WireOutcome {
	unit: number;
	op: WireUnit["op"];
	path: string;
	outcome: "saved" | "refused" | "conflict";
	version?: string;
	reason?: string;
	problems?: { code: string; message: string }[];
}

/** The ordinary client, structured parser and log are real; only the platform wire/bytes are simulated. These tests
 * verify the documented W1 port, not the still-gated SQL migration's real integration. */
function fixture(group = false) {
	const {
		binding,
		authority: { identity },
	} = nativeToolAuthorityFixture();
	const runId = binding.runId;
	let origin: CloudRunLogOrigin = {
		conversation: randomUUID(),
		parent: null,
		step: null,
		continues: null,
		narrow: false,
	};
	let root = `${group ? "agents/groups/research/memory" : "agents/scout/memory/thread"}/runs/${runId}`;
	let gone = false;
	let generation = 0;
	let seq = 0;
	let placeOverride: (() => unknown) | undefined;
	let beforeCommit:
		| ((units: WireUnit[], preconditions: CloudRunLogPreconditions, attempt: number) => WireOutcome[] | undefined)
		| undefined;
	const stored = new Map<string, Uint8Array>();
	const files = new Map<string, { version: string; file: CloudCompanyFolderFile }>();
	const folders = new Set<string>();
	const receipts = new Map<string, unknown>();
	const commits: { key: string; units: WireUnit[]; preconditions: CloudRunLogPreconditions }[] = [];
	const calls: { method: CloudCompanyPathRpc; args: Record<string, unknown> }[] = [];
	const bytes: CloudCompanyFolderBytes = {
		put: vi.fn(async (data, mediaType): Promise<CloudFileReference> => {
			const hash = digest(data);
			stored.set(hash, Uint8Array.from(data));
			return { manifestSha256: digest(`manifest:${hash}`), fileSha256: hash, bytes: data.byteLength, mediaType };
		}),
		get: vi.fn(async (file) => {
			const data = stored.get(file.fileSha256);
			if (!data) throw new Error("Missing fixture bytes");
			return data;
		}),
		range: vi.fn(async () => {
			throw new Error("No range read");
		}),
	};
	const text = (file: CloudCompanyFolderFile) => Buffer.from(stored.get(file.fileSha256)!).toString("utf8");
	const putFile = (path: string, value: string, mediaType = "application/jsonl") => {
		const file = {
			manifestSha256: digest(`manifest:${digest(value)}`),
			fileSha256: digest(value),
			bytes: Buffer.byteLength(value),
			mediaType,
			executable: false,
		};
		stored.set(file.fileSha256, Buffer.from(value));
		files.set(path, { version: randomUUID(), file });
	};
	const toml = () =>
		[
			"format = 1",
			`run = "${runId}"`,
			`conversation = "${origin.conversation}"`,
			...(origin.parent ? [`parent = "${origin.parent}"`, `step = ${origin.step}`] : []),
			...(origin.continues ? [`continues = "${origin.continues}"`] : []),
			...(origin.narrow ? ["narrow = true"] : []),
			"",
		].join("\n");
	const existing = () => {
		folders.add(root);
		folders.add(`${root}/log`);
		putFile(`${root}/run.toml`, toml(), "application/toml");
	};
	const place = () => {
		if (gone) return { gone: true };
		const exists = folders.has(root);
		const firsts = [...files.keys()]
			.filter((path) => path.startsWith(`${root}/log/`))
			.map((path) => Number(path.slice(-14, -6)));
		const ancestors = (group ? [4, 5] : [3, 4, 5]).map((length) => root.split("/").slice(0, length).join("/"));
		return {
			path: root,
			exists,
			missing: exists ? [] : ancestors.filter((path) => !folders.has(path)),
			last: firsts.length ? Math.max(...firsts) : null,
			generation,
			gone: false,
			...(!exists ? { origin } : {}),
		};
	};
	const refusal = (units: WireUnit[], reason: string, problem?: string): WireOutcome[] =>
		units.map((unit, index) => ({
			unit: index + 1,
			op: unit.op,
			path: unit.path,
			outcome: "refused",
			reason,
			...(problem ? { problems: [{ code: "rule", message: problem }] } : {}),
		}));
	const apply = (unit: WireUnit, index: number): WireOutcome => {
		const base = { unit: index + 1, op: unit.op, path: unit.path };
		if (unit.op !== "write") {
			if (folders.has(unit.path)) return { ...base, outcome: "conflict", reason: "exists" };
			folders.add(unit.path);
			for (const item of unit.contents ?? []) {
				if (item.kind === "folder") folders.add(`${unit.path}/${item.path}`);
				else files.set(`${unit.path}/${item.path}`, { version: randomUUID(), file: item.file! });
			}
			return { ...base, outcome: "saved" };
		}
		const previous = files.get(unit.path);
		if (unit.expectedVersion === undefined ? previous : previous?.version !== unit.expectedVersion)
			return { ...base, outcome: "conflict", reason: "version_changed" };
		const version = randomUUID();
		files.set(unit.path, { version, file: unit.file! });
		return { ...base, version, outcome: "saved" };
	};
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method, args) => {
			calls.push({ method, args: structuredClone(args) });
			if (method === "qorpera_memory_run_log_place") return placeOverride ? placeOverride() : place();
			if (method === "qorpera_folder_read") {
				const path = args.p_path as string;
				const file = files.get(path);
				return {
					schema: "qorpera.folder-read/v1",
					asOfSeq: seq,
					found: !!file,
					entry: file
						? {
								path,
								kind: "file",
								version: file.version,
								seq,
								updatedAt: "2026-10-09T10:00:00Z",
								...file.file,
								authority: {
									resourceId: randomUUID(),
									resourceRevision: 1,
									grantId: null,
									grantRevision: null,
								},
							}
						: null,
				};
			}
			if (method !== "qorpera_folder_memory_commit") throw new Error(`Unexpected call ${method}`);
			const key = args.p_operation_key as string;
			if (receipts.has(key)) return receipts.get(key);
			const units = args.p_units as WireUnit[];
			const preconditions = args.p_preconditions as CloudRunLogPreconditions;
			commits.push({ key, units: structuredClone(units), preconditions: structuredClone(preconditions) });
			const overridden = beforeCommit?.(units, preconditions, commits.length);
			const reason = gone
				? "memory_run_log_gone"
				: preconditions.runLog.path !== root
					? "memory_run_log_moved"
					: preconditions.runGenerations?.some((entry) => entry.generation !== generation)
						? "memory_generation_stale"
						: null;
			const outcomes = overridden ?? (reason ? refusal(units, reason) : units.map(apply));
			const value = {
				schema: "qorpera.folder-commit/v1",
				commitId: randomUUID(),
				seq: outcomes.some((outcome) => outcome.outcome === "saved") ? ++seq : null,
				replay: false,
				units: outcomes,
			};
			receipts.set(key, value);
			return value;
		}),
	};
	const client = new CloudCompanyFolderClient({ binding, identity, control, bytes });
	const folder = new CloudRunLogCompanyFolder({
		environmentId: identity.environmentId,
		runId,
		folder: client,
		control,
	});
	const protection = {
		narrow: vi.fn(async () => false),
		hashes: vi.fn(async (_run: string, values: readonly string[]) =>
			values.map((value) =>
				createHmac("sha256", "synthetic-test-platform-key").update(`${runId}:${value}`).digest("hex"),
			),
		),
	};
	const log = new CloudRunLog({
		runId,
		conversationId: origin.conversation,
		folder,
		protection,
		signal,
		now: () => new Date("2026-10-09T10:00:00Z"),
	});
	logs.push(log);
	const move = (next: string) => {
		for (const [path, file] of [...files])
			if (path.startsWith(`${root}/`)) {
				files.delete(path);
				files.set(`${next}${path.slice(root.length)}`, file);
			}
		for (const path of [...folders])
			if (path === root || path.startsWith(`${root}/`)) {
				folders.delete(path);
				folders.add(`${next}${path.slice(root.length)}`);
			}
		root = next;
	};
	return {
		binding,
		identity,
		runId,
		client,
		folder,
		control,
		log,
		bytes,
		files,
		folders,
		commits,
		calls,
		protection,
		text,
		putFile,
		existing,
		place,
		refusal,
		move,
		get root() {
			return root;
		},
		get origin() {
			return origin;
		},
		set origin(value: CloudRunLogOrigin) {
			origin = value;
		},
		set gone(value: boolean) {
			gone = value;
		},
		set generation(value: number) {
			generation = value;
		},
		set placeOverride(value: (() => unknown) | undefined) {
			placeOverride = value;
		},
		set beforeCommit(value: typeof beforeCommit) {
			beforeCommit = value;
		},
	};
}

function step(log: CloudRunLog, call = randomUUID()) {
	return log.step({
		call,
		tool: "company_read",
		argumentsText: '{"path":"notes/public.md"}',
		argumentSha256: digest("arguments"),
	});
}
function finish(log: CloudRunLog, j: number) {
	log.finish(j, '{"status":"ok","content":{"text":"answer"}}', []);
}

describe("run log persistence through the ordinary folder client", () => {
	it.each([false, true])(
		"creates a thread/group log with normal staging and exact structured parses: group=%s",
		async (group) => {
			const f = fixture(group);
			f.origin = {
				conversation: randomUUID(),
				parent: randomUUID(),
				step: 7,
				continues: randomUUID(),
				narrow: false,
			};
			const j = step(f.log);
			finish(f.log, j);
			await f.log.flush(signal);
			expect(f.calls[0]).toEqual({
				method: "qorpera_memory_run_log_place",
				args: { p_environment_id: f.identity.environmentId, p_run_id: f.runId },
			});
			const commit = f.commits[0]!;
			expect(commit.preconditions).toEqual({ runLog: { run: f.runId, path: f.root } });
			const made = commit.units.find((unit) => unit.op === "new_folder")!;
			expect(made.structured).toEqual([
				{
					path: `${f.root}/run.toml`,
					kind: "memory-run",
					parserVersion: 1,
					text: expect.stringContaining(`conversation = "${f.origin.conversation}"`),
					parse: { kind: "memory-run" },
				},
			]);
			expect(made.structured?.[0]?.text).toContain(
				`parent = "${f.origin.parent}"\nstep = 7\ncontinues = "${f.origin.continues}"\n`,
			);
			expect(commit.units.at(-1)?.structured).toEqual([
				{
					path: `${f.root}/log/00000000.jsonl`,
					kind: "memory-steps",
					parserVersion: 1,
					text: expect.any(String),
					parse: { kind: "memory-steps" },
				},
			]);
			const sent = f.calls.find((call) => call.method === "qorpera_folder_memory_commit")!.args;
			expect(sent.p_actor).toEqual(f.client.actor);
			expect(sent.p_environment_id).toBe(f.identity.environmentId);
			expect(sent).not.toHaveProperty("p_binding");
			expect(sent).not.toHaveProperty("p_review_id");
			expect(sent).not.toHaveProperty("p_receipt_id");
			expect(f.bytes.put).toHaveBeenCalledTimes(2);
		},
	);

	it("reads the existing origin and log with ordinary run authority, preserving the committed version", async () => {
		const f = fixture();
		f.origin = { ...f.origin, narrow: true };
		f.existing();
		const j = step(f.log);
		await f.log.precommit(j, signal);
		const first = f.commits[0]!.units[0]!;
		expect(JSON.parse(f.text(first.file!))).toMatchObject({ j, narrow: true, finished: false });
		const version = f.files.get(first.path)!.version;
		finish(f.log, j);
		await f.log.flush(signal);
		expect(f.commits[1]!.units[0]!.expectedVersion).toBe(version);
		const located = await f.folder.locate(f.runId, signal);
		expect(located.origin?.narrow).toBe(true);
		expect(await f.folder.read(first.path, signal)).toEqual({
			version: f.files.get(first.path)!.version,
			text: f.text(f.files.get(first.path)!.file),
		});
		for (const call of f.calls.filter((call) => call.method === "qorpera_folder_read"))
			expect(call.args.p_actor).toEqual(f.client.actor);
		expect(f.calls.some((call) => call.method === "qorpera_folder_record_release")).toBe(false);
	});

	it("does not guess an origin or bypass a denied run-actor read", async () => {
		const f = fixture();
		f.existing();
		f.files.delete(`${f.root}/run.toml`);
		await expect(f.folder.locate(f.runId, signal)).rejects.toThrow("origin_unavailable");
		f.existing();
		const original = vi.mocked(f.control.call).getMockImplementation()!;
		vi.mocked(f.control.call).mockImplementation(async (method, args, requestSignal) => {
			if (method === "qorpera_folder_read") throw new CloudCompanyFolderRpcError("42501", "read denied");
			return original(method, args, requestSignal);
		});
		await expect(f.folder.locate(f.runId, signal)).rejects.toBeDefined();
		expect(f.bytes.put).not.toHaveBeenCalled();
	});

	it("requires a checked origin, closed place and correct bound paths", async () => {
		const f = fixture();
		const good = f.place();
		for (const patch of [
			{ extra: true },
			{ path: `projects/runs/${f.runId}` },
			{ path: `${f.root}/extra` },
			{ missing: ["projects"] },
			{ missing: ["agents/scout/memory/thread", "agents/scout/memory"] },
			{ generation: -1 },
			{ last: 0 },
			{ origin: { ...f.origin, step: 0 } },
			{ origin: { ...f.origin, extra: false } },
			{ origin: { ...f.origin, conversation: `${f.origin.conversation}\n` } },
		]) {
			f.placeOverride = () => ({ ...good, ...patch });
			await expect(f.folder.locate(f.runId, signal)).rejects.toThrow("folder_response_invalid");
		}
		await expect(f.folder.locate(randomUUID(), signal)).rejects.toThrow("folder_run_mismatch");
		f.placeOverride = () => ({ gone: true, path: f.root });
		await expect(f.folder.locate(f.runId, signal)).rejects.toThrow("folder_response_invalid");
		f.placeOverride = () => ({ gone: true });
		await expect(f.folder.locate(f.runId, signal)).rejects.toBeInstanceOf(CloudRunLogGone);
	});

	it("rejects unrelated mutations before staging and validates stored log bytes on read", async () => {
		const f = fixture();
		await f.folder.locate(f.runId, signal);
		const preconditions = { runLog: { run: f.runId, path: f.root } };
		const unrelated: CloudCompanyFolderUnit[] = [
			{ op: "write", path: "projects/secret.md", content: { text: "words" } },
			{ op: "delete", path: `${f.root}/log/00000000.jsonl`, expectedVersion: randomUUID() },
			{ op: "move", from: f.root, to: "projects", expectedVersion: randomUUID() },
			{
				op: "new_folder",
				path: f.root,
				contents: [{ kind: "file", path: "secret.md", content: { text: "words" } }],
			},
		];
		for (const unit of unrelated)
			await expect(f.folder.commit("unrelated-write", [unit], preconditions, signal)).rejects.toThrow(
				"folder_path_invalid",
			);
		expect(f.bytes.put).not.toHaveBeenCalled();
		await expect(f.folder.read("projects/secret.md", signal)).rejects.toThrow("folder_path_invalid");
		f.putFile(`${f.root}/log/00000000.jsonl`, '{"j":0}\n');
		await expect(f.folder.read(`${f.root}/log/00000000.jsonl`, signal)).rejects.toThrow("folder_response_invalid");
	});

	it("uses generation preconditions only for tree batches and sends tree blocks through the shared parser", async () => {
		const f = fixture();
		f.existing();
		f.generation = 5;
		const text = '{"l":0,"k":0,"free":true,"text":"summary"}\n';
		expect(await f.log.treeRead("t0/00000000.jsonl", signal)).toBeNull();
		expect(
			await f.log.commitTree("tree-batch-1", [{ path: "t0/00000000.jsonl", text, version: null }], 5, signal),
		).toBe("landed");
		expect(f.commits[0]!.preconditions).toEqual({
			runLog: { run: f.runId, path: f.root },
			runGenerations: [{ runId: f.runId, generation: 5 }],
		});
		expect(f.commits[0]!.units.at(-1)?.structured?.[0]?.parse).toEqual({ kind: "memory-run-block" });
		expect((await f.log.treeRead("t0/00000000.jsonl", signal))?.text).toBe(text);
		f.generation = 6;
		expect(
			await f.log.commitTree("tree-batch-2", [{ path: "t0/00000001.jsonl", text, version: null }], 5, signal),
		).toBe("stale");
	});

	it("relocates an existing log after a moved refusal before the effect may run", async () => {
		const f = fixture();
		f.existing();
		f.beforeCommit = (_units, _conditions, attempt) => {
			if (attempt === 1) f.move(f.root.replace("/scout/", "/analyst/"));
			return undefined;
		};
		const j = step(f.log);
		await f.log.precommit(j, signal);
		expect(f.commits).toHaveLength(2);
		expect(f.commits[1]!.preconditions.runLog.path).toBe(f.root);
		expect(f.commits[1]!.units[0]!.path).toBe(`${f.root}/log/00000000.jsonl`);
		expect(f.log.steps()[0]?.result).toBeNull();
	});

	it.each(["memory_erase_open", "memory_run_log_gone"])(
		"a %s refusal never completes the pending effect's precommit",
		async (reason) => {
			const f = fixture();
			f.beforeCommit = (units) => f.refusal(units, reason);
			const effect = vi.fn();
			await expect(f.log.precommit(step(f.log), signal).then(effect)).rejects.toBeDefined();
			expect(effect).not.toHaveBeenCalled();
			expect(f.commits).toHaveLength(1);
		},
	);

	it("cancels before staging or committing an effect", async () => {
		const f = fixture();
		await expect(f.log.precommit(step(f.log), AbortSignal.abort())).rejects.toBeDefined();
		expect(f.bytes.put).not.toHaveBeenCalled();
		expect(f.commits).toHaveLength(0);
	});
});

describe("the two exact documented commit races", () => {
	it("re-locates first-batch origin once and makes every line narrow when inherited status changed", async () => {
		const f = fixture();
		f.beforeCommit = (units, _conditions, attempt) => {
			if (attempt !== 1) return undefined;
			f.origin = { ...f.origin, narrow: true, continues: randomUUID() };
			return units.map((unit, index) => ({
				unit: index + 1,
				op: unit.op,
				path: unit.path,
				outcome: "refused",
				reason: unit.op === "new_folder" ? "structured_rule" : "parent_missing",
				...(unit.op === "new_folder" ? { problems: [{ code: "rule", message: ORIGIN_PROBLEM }] } : {}),
			}));
		};
		const j = step(f.log);
		finish(f.log, j);
		await f.log.flush(signal);
		expect(f.commits).toHaveLength(2);
		expect(f.commits[1]!.units.find((unit) => unit.op === "new_folder")?.structured?.[0]?.text).toContain(
			"narrow = true\n",
		);
		expect(JSON.parse(f.text(f.commits[1]!.units.at(-1)!.file!))).toMatchObject({
			narrow: true,
			finished: true,
			j: 0,
		});
		expect(f.commits[0]!.key).not.toBe(f.commits[1]!.key);
	});

	it("narrows changed lines after the machine race without rewriting fixed old lines or changing keyed args", async () => {
		const f = fixture();
		f.existing();
		const first = step(f.log);
		finish(f.log, first);
		await f.log.flush(signal);
		const old = f.text(f.commits[0]!.units[0]!.file!).trim();
		f.beforeCommit = (units, _conditions, attempt) =>
			attempt === 2
				? f.refusal(units, "structured_invalid", "step 1 comes after its machine went narrow and is written narrow")
				: undefined;
		const pending = step(f.log);
		await f.log.precommit(pending, signal);
		expect(f.commits).toHaveLength(3);
		const before = f.text(f.commits[1]!.units[0]!.file!).trim().split("\n");
		const after = f.text(f.commits[2]!.units[0]!.file!).trim().split("\n");
		expect(after[0]).toBe(old);
		expect(JSON.parse(after[1]!)).toMatchObject({
			j: 1,
			narrow: true,
			finished: false,
			args_hash: JSON.parse(before[1]!).args_hash,
		});
		expect(JSON.parse(after[1]!)).not.toHaveProperty("args_bytes");
		finish(f.log, pending);
		await f.log.flush(signal);
		expect(JSON.parse(f.text(f.commits[3]!.units[0]!.file!).trim().split("\n")[1]!)).toMatchObject({
			narrow: true,
			finished: true,
			result_hash: expect.any(String),
		});
	});

	it("does not retry an unrelated structured refusal or a repeated machine race", async () => {
		for (const message of [
			"invalid memory format",
			"step 99 comes after its machine went narrow and is written narrow",
			"step 0 comes after its machine went narrow and is written narrow",
		]) {
			const f = fixture();
			f.existing();
			f.beforeCommit = (units) => f.refusal(units, "structured_rule", message);
			await expect(f.log.precommit(step(f.log), signal)).rejects.toBeDefined();
			expect(f.commits).toHaveLength(message.startsWith("step 0 ") ? 2 : 1);
		}
	});
});

describe("memory folder control transport", () => {
	it("preserves exact commit SQLSTATEs for the ordinary client retry and accepts full path classification responses", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const control = new HttpCloudCompanyPathControl({
			supabaseUrl: "https://project.supabase.example",
			serviceRoleKey: "test-key",
			fetch: fetcher,
		});
		fetcher.mockResolvedValueOnce(
			new Response(JSON.stringify({ code: "QRC01", message: "authority changed", details: null, hint: null }), {
				status: 409,
			}),
		);
		await expect(control.call("qorpera_folder_memory_commit", {}, signal)).rejects.toBeInstanceOf(
			CloudCompanyFolderRpcError,
		);
		const value = {
			log: false,
			machine: false,
			restricted: Array.from({ length: 1024 }, (_, index) => `projects/${index}/${"x".repeat(500)}`),
		};
		fetcher.mockResolvedValueOnce(new Response(JSON.stringify(value)));
		expect(await control.call("qorpera_memory_step_narrow", { p_paths: value.restricted }, signal)).toEqual(value);
	});

	it("replays exactly the staged memory request after a lost answer", async () => {
		const f = fixture();
		f.existing();
		await f.folder.locate(f.runId, signal);
		const original = vi.mocked(f.control.call).getMockImplementation()!;
		let lost = true;
		vi.mocked(f.control.call).mockImplementation(async (method, args, requestSignal) => {
			const answer = await original(method, args, requestSignal);
			if (method === "qorpera_folder_memory_commit" && lost) {
				lost = false;
				throw new CloudRuntimeDiagnosticError("transport_unavailable", "lost");
			}
			return answer;
		});
		await f.log.precommit(step(f.log), signal);
		const sent = f.calls.filter((call) => call.method === "qorpera_folder_memory_commit");
		expect(sent).toHaveLength(2);
		expect(sent[0]!.args).toEqual(sent[1]!.args);
		expect(f.commits).toHaveLength(1);
	});
});
