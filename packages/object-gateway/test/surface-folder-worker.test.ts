import { createHash, randomUUID } from "node:crypto";
import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import { describe, expect, it } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import type { MemberCompanyPublisherRpc } from "../src/member-company-authority.ts";
import { SurfaceFolderWorker } from "../src/surface-folder-worker.ts";

interface StoredEntry {
	kind: "file" | "folder";
	version: string;
	content: Uint8Array | null;
	manifestSha256: string | null;
	fileSha256: string | null;
	mediaType: string;
}

function digestSha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function createHarness(
	initialFiles: Record<string, string>,
	options?: {
		readonly jobTimeoutMs?: number;
		readonly leaseRenewIntervalMs?: number;
		readonly hangStoreGet?: boolean;
		readonly commitDelayMs?: number;
		readonly onBeforeCommit?: () => void;
	},
) {
	const profileId = randomUUID();
	const environmentId = randomUUID();
	const surfaceId = randomUUID();
	const objects = new Map<string, Uint8Array>();
	const entries = new Map<string, StoredEntry>();
	const intents = new Map<
		string,
		{
			manifestSha256: string;
			fileSha256: string;
			bytes: number;
			mediaType: string;
			executable: boolean;
			required: Set<string>;
		}
	>();
	const externalSnapshots = new Map<string, Record<string, unknown>>();
	const committedByOpKey = new Map<string, Record<string, unknown>>();
	const completedMerges: Record<string, unknown>[] = [];
	const completedPublishes: Record<string, unknown>[] = [];
	const events: Record<string, unknown>[] = [];
	let pendingClaim: { merges?: unknown[]; publishes?: unknown[] } = { merges: [], publishes: [] };
	let commitCount = 0;
	let leaseRenewCount = 0;
	let completeMergeAttemptErrors: Error[] = [];
	let preCommitErrors: Error[] = [];
	let postCommitErrors: Error[] = [];

	const putFile = (path: string, text: string, version = randomUUID()): string => {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i += 1) {
			const dir = parts.slice(0, i).join("/");
			if (!entries.has(dir)) {
				entries.set(dir, {
					kind: "folder",
					version: randomUUID(),
					content: null,
					manifestSha256: null,
					fileSha256: null,
					mediaType: "inode/directory",
				});
			}
		}
		const bytes = new TextEncoder().encode(text);
		const fileSha = digestSha256(bytes);
		const manifestText = JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: fileSha,
			bytes: bytes.byteLength,
			mediaType: "application/json",
			executable: false,
			chunks: bytes.byteLength > 0 ? [{ sha256: fileSha, bytes: bytes.byteLength }] : [],
		});
		const manifestBytes = new TextEncoder().encode(manifestText);
		const manifestSha = digestSha256(manifestBytes);
		objects.set(fileSha, bytes);
		objects.set(manifestSha, manifestBytes);
		entries.set(path, {
			kind: "file",
			version,
			content: bytes,
			manifestSha256: manifestSha,
			fileSha256: fileSha,
			mediaType: "application/json",
		});
		return version;
	};

	for (const [path, text] of Object.entries(initialFiles)) {
		putFile(path, text);
	}

	const authority = {
		async publisher(
			method: MemberCompanyPublisherRpc,
			args: Record<string, unknown>,
			signal: AbortSignal,
		): Promise<unknown> {
			switch (method) {
				case "qorpera_surface_claim_pending_jobs_for_lane": {
					expect(args.p_lane).toBe("folder");
					const next = pendingClaim;
					pendingClaim = { merges: [], publishes: [] };
					return next;
				}
				case "qorpera_folder_read": {
					const path = String(args.p_path);
					const entry = entries.get(path);
					if (!entry) {
						return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: false, entry: null };
					}
					return {
						schema: "qorpera.folder-read/v1",
						asOfSeq: 1,
						found: true,
						entry: {
							path,
							kind: entry.kind,
							version: entry.version,
							manifestSha256: entry.manifestSha256,
							fileSha256: entry.fileSha256,
							bytes: entry.content?.byteLength ?? 0,
							mediaType: entry.mediaType,
							executable: false,
						},
					};
				}
				case "qorpera_folder_authorize_object_download": {
					const hash = String(args.p_sha256);
					const buf = objects.get(hash);
					if (!buf) throw new Error(`Missing object ${hash}`);
					return { schema: "qorpera.folder-object-download/v1", profileId, bytes: buf.byteLength };
				}
				case "qorpera_folder_open_upload": {
					const manifestText = String(args.p_manifest);
					const manifestBytes = new TextEncoder().encode(manifestText);
					const manifestSha = digestSha256(manifestBytes);
					const parsed = JSON.parse(manifestText) as {
						fileSha256: string;
						bytes: number;
						mediaType: string;
						executable: boolean;
						chunks: { sha256: string }[];
					};
					const intentId = randomUUID();
					const required = new Set<string>([manifestSha, ...parsed.chunks.map((c) => c.sha256)]);
					intents.set(intentId, {
						manifestSha256: manifestSha,
						fileSha256: parsed.fileSha256,
						bytes: parsed.bytes,
						mediaType: parsed.mediaType,
						executable: parsed.executable,
						required,
					});
					const present = [...required].filter((hash) => objects.has(hash));
					return { schema: "qorpera.folder-upload/v1", intentId, manifestSha256: manifestSha, present };
				}
				case "qorpera_folder_authorize_object_upload":
					return { schema: "qorpera.folder-object-upload/v1", profileId };
				case "qorpera_folder_confirm_object":
					return {
						schema: "qorpera.folder-object/v1",
						sha256: args.p_sha256,
						bytes: args.p_bytes,
					};
				case "qorpera_folder_seal_upload": {
					const intent = intents.get(String(args.p_intent));
					if (!intent) throw new Error("Unknown upload intent");
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId: args.p_intent,
						file: {
							manifestSha256: intent.manifestSha256,
							fileSha256: intent.fileSha256,
							bytes: intent.bytes,
							mediaType: intent.mediaType,
							executable: intent.executable,
						},
					};
				}
				case "qorpera_folder_commit": {
					commitCount += 1;
					options?.onBeforeCommit?.();
					const preCommitErr = preCommitErrors.shift();
					if (preCommitErr) {
						throw preCommitErr;
					}
					const opKey = String(args.p_operation_key ?? "");
					if (options?.commitDelayMs) {
						await new Promise((resolve) => setTimeout(resolve, options.commitDelayMs));
					}
					signal.throwIfAborted();
					let result = opKey ? committedByOpKey.get(opKey) : undefined;
					if (!result) {
						const units = args.p_units as {
							op: string;
							path: string;
							expectedVersion?: string;
							file?: { manifestSha256: string; fileSha256: string; bytes: number; mediaType: string };
						}[];
						const outcomes: Record<string, unknown>[] = [];
						const stagedMutations: (() => void)[] = [];
						let hasFailure = false;
						for (const unit of units) {
							const existing = entries.get(unit.path);
							if (unit.op === "mkdir") {
								const nextVersion = randomUUID();
								stagedMutations.push(() => {
									if (!entries.has(unit.path)) {
										entries.set(unit.path, {
											kind: "folder",
											version: nextVersion,
											content: null,
											manifestSha256: null,
											fileSha256: null,
											mediaType: "inode/directory",
										});
									}
								});
								outcomes.push({ outcome: "saved", version: nextVersion });
								continue;
							}
							if (unit.op === "write") {
								if (unit.expectedVersion && existing?.version !== unit.expectedVersion) {
									hasFailure = true;
									outcomes.push({ outcome: "refused", reason: "version_mismatch" });
									continue;
								}
								if (!unit.expectedVersion && existing) {
									hasFailure = true;
									outcomes.push({ outcome: "refused", reason: "exists" });
									continue;
								}
								const fileRef = unit.file!;
								const content = objects.get(fileRef.fileSha256) ?? new Uint8Array();
								const nextVersion = randomUUID();
								stagedMutations.push(() => {
									entries.set(unit.path, {
										kind: "file",
										version: nextVersion,
										content,
										manifestSha256: fileRef.manifestSha256,
										fileSha256: fileRef.fileSha256,
										mediaType: fileRef.mediaType,
									});
								});
								outcomes.push({ outcome: "saved", version: nextVersion });
								continue;
							}
							if (unit.op === "delete") {
								if (!existing || existing.version !== unit.expectedVersion) {
									hasFailure = true;
									outcomes.push({ outcome: "refused", reason: "version_mismatch" });
									continue;
								}
								stagedMutations.push(() => {
									entries.delete(unit.path);
								});
								outcomes.push({ outcome: "saved", version: null });
							}
						}
						if (!hasFailure) {
							for (const apply of stagedMutations) apply();
						}
						result = { schema: "qorpera.folder-commit/v1", units: outcomes };
						if (opKey && !hasFailure) {
							committedByOpKey.set(opKey, result);
						}
					}
					const postCommitErr = postCommitErrors.shift();
					if (postCommitErr) {
						throw postCommitErr;
					}
					return result;
				}
				case "qorpera_surface_save_folder_snapshot": {
					const snapshotId = String(args.p_snapshot_id);
					externalSnapshots.set(snapshotId, {
						snapshotId,
						folderRoot: args.p_folder_root,
						changeIds: args.p_change_ids,
						filesBefore: args.p_files_before,
						versionsAfter: args.p_versions_after,
						afterContentSha256: args.p_after_content_sha256,
					});
					return { saved: true, snapshotId };
				}
				case "qorpera_surface_load_folder_snapshot": {
					const snapshotId = typeof args.p_snapshot_id === "string" ? args.p_snapshot_id : null;
					if (snapshotId && externalSnapshots.has(snapshotId)) {
						return externalSnapshots.get(snapshotId);
					}
					return null;
				}
				case "qorpera_surface_complete_merge": {
					const nextError = completeMergeAttemptErrors.shift();
					if (nextError) {
						throw nextError;
					}
					completedMerges.push(args);
					return { jobId: args.p_job_id, status: args.p_status };
				}
				case "qorpera_surface_complete_publish":
					completedPublishes.push(args);
					return { jobId: args.p_job_id, status: args.p_status };
				case "qorpera_surface_renew_lease":
					leaseRenewCount += 1;
					return { renewed: true };
				default:
					throw new Error(`Unexpected RPC: ${method}`);
			}
		},
	};

	const store = {
		async get(_profileId: string, hash: string): Promise<Uint8Array> {
			if (options?.hangStoreGet) {
				return await new Promise<Uint8Array>(() => undefined);
			}
			const buf = objects.get(hash);
			if (!buf) throw new Error("Object not found");
			return buf;
		},
	};

	const replication = {
		async uploadWithAuthority(
			_profileId: string,
			hash: string,
			bytes: Uint8Array,
			hooks: { authorize: () => Promise<void>; confirm: () => Promise<void> },
		): Promise<"exists" | "stored"> {
			await hooks.authorize();
			const existed = objects.has(hash);
			objects.set(hash, new Uint8Array(bytes));
			await hooks.confirm();
			return existed ? "exists" : "stored";
		},
	};

	const worker = new SurfaceFolderWorker({
		authority,
		store,
		replication,
		...(options?.jobTimeoutMs !== undefined ? { jobTimeoutMs: options.jobTimeoutMs } : {}),
		...(options?.leaseRenewIntervalMs !== undefined ? { leaseRenewIntervalMs: options.leaseRenewIntervalMs } : {}),
		completionRetryDelaysMs: [5, 5],
		onEvent: (event) => events.push(event),
	});

	return {
		profileId,
		environmentId,
		surfaceId,
		entries,
		externalSnapshots,
		completedMerges,
		completedPublishes,
		events,
		getCommitCount: () => commitCount,
		getLeaseRenewCount: () => leaseRenewCount,
		setFailCompleteMergeAttempts(count: number) {
			completeMergeAttemptErrors = Array.from({ length: count }, () => new Error("transient complete merge 503"));
		},
		setCompleteMergeAttemptErrors(errors: Error[]) {
			completeMergeAttemptErrors = [...errors];
		},
		setPreCommitErrors(errors: Error[]) {
			preCommitErrors = [...errors];
		},
		setPostCommitErrors(errors: Error[]) {
			postCommitErrors = [...errors];
		},
		putFile,
		setPendingClaim(next: { merges?: unknown[]; publishes?: unknown[] }) {
			pendingClaim = next;
		},
		readText(path: string): string | null {
			const entry = entries.get(path);
			if (!entry || !entry.content) return null;
			return new TextDecoder().decode(entry.content);
		},
		worker,
	};
}

describe("SurfaceFolderWorker", () => {
	it("lands Studio folder patches with auto-compiled identity/tokens.css and rolls back cleanly with CAS", async () => {
		const h = createHarness({
			"identity/tokens.json": JSON.stringify({ colors: { accent: "#111111" } }),
		});
		const jobId = randomUUID();
		const changeId = randomUUID();
		const leaseToken = randomUUID();

		h.setPendingClaim({
			merges: [
				{
					jobId,
					kind: "land_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken,
					folderRoot: "identity",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Warm terracotta accent",
							summary: "Updates accent color",
							affectedPaths: ["tokens.json"],
							patchManifest: [
								{ op: "merge_json", path: "tokens.json", patch: { colors: { accent: "#c84b31" } } },
								{ op: "write_text", path: "voice.md", content: "Warm, concise Nordic voice." },
							],
						},
					],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		expect(JSON.parse(h.readText("identity/tokens.json") ?? "{}")).toEqual({ colors: { accent: "#c84b31" } });
		expect(h.readText("identity/tokens.css")).toContain("#c84b31");
		expect(h.readText("identity/voice.md")).toBe("Warm, concise Nordic voice.");
		expect(h.completedMerges).toHaveLength(1);
		expect(h.completedMerges[0]).toMatchObject({
			p_job_id: jobId,
			p_status: "landed",
			p_lease_token: leaseToken,
		});
		const snapshot = h.completedMerges[0]?.p_pre_merge_snapshot as Record<string, unknown>;
		expect(snapshot).toBeTruthy();

		const undoJobId = randomUUID();
		const undoLease = randomUUID();
		h.setPendingClaim({
			merges: [
				{
					jobId: undoJobId,
					kind: "undo_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken: undoLease,
					folderRoot: "identity",
					payload: { changeId },
					preMergeSnapshot: snapshot,
					approvedChanges: [],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		expect(JSON.parse(h.readText("identity/tokens.json") ?? "{}")).toEqual({ colors: { accent: "#111111" } });
		expect(h.readText("identity/tokens.css")).toBeNull();
		expect(h.readText("identity/voice.md")).toBeNull();
		expect(h.completedMerges[1]).toMatchObject({ p_job_id: undoJobId, p_status: "landed" });
	});

	it("offloads >96 KiB pre-merge snapshots externally and reports conflict if files changed before undo", async () => {
		const largeBefore = "A".repeat(110 * 1024);
		const h = createHarness({
			"brand/guide.md": largeBefore,
		});
		const jobId = randomUUID();
		const changeId = randomUUID();

		h.setPendingClaim({
			merges: [
				{
					jobId,
					kind: "land_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Tighten brand guide",
							summary: "Replaces guide",
							affectedPaths: ["guide.md"],
							patchManifest: [{ op: "write_text", path: "guide.md", content: "Short guide." }],
						},
					],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		const pointer = h.completedMerges[0]?.p_pre_merge_snapshot as { externalSnapshotId?: string };
		expect(typeof pointer?.externalSnapshotId).toBe("string");
		expect(h.externalSnapshots.size).toBe(1);

		h.putFile("brand/guide.md", "Edited by founder directly.");

		const undoJobId = randomUUID();
		h.setPendingClaim({
			merges: [
				{
					jobId: undoJobId,
					kind: "undo_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeId },
					preMergeSnapshot: pointer,
					approvedChanges: [],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		expect(h.completedMerges[1]).toMatchObject({
			p_job_id: undoJobId,
			p_status: "conflicted",
			p_conflict_paths: ["brand/guide.md"],
		});
		expect(h.readText("brand/guide.md")).toBe("Edited by founder directly.");
	});

	it("completes folder publish jobs cleanly", async () => {
		const h = createHarness({});
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		h.setPendingClaim({
			publishes: [
				{
					jobId,
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken,
				},
			],
		});
		expect(await h.worker.processDue(8)).toBe(1);
		expect(h.completedPublishes).toEqual([
			{
				p_job_id: jobId,
				p_status: "published",
				p_published_head_sha: null,
				p_error_detail: null,
				p_lease_token: leaseToken,
			},
		]);
	});

	it("retries qorpera_surface_complete_merge after a committed folder write without re-committing or corrupting filesBefore", async () => {
		const h = createHarness({
			"brand/voice.md": "Original voice.",
		});
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const changeId = randomUUID();
		h.setFailCompleteMergeAttempts(1);
		h.setPendingClaim({
			merges: [
				{
					jobId,
					kind: "land_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken,
					folderRoot: "brand",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Update voice",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Updated voice." }],
						},
					],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		expect(h.getCommitCount()).toBe(1);
		expect(h.readText("brand/voice.md")).toBe("Updated voice.");
		expect(h.completedMerges).toHaveLength(1);
		expect(h.completedMerges[0]).toMatchObject({
			p_job_id: jobId,
			p_status: "landed",
			p_lease_token: leaseToken,
		});
		const snap = h.completedMerges[0]?.p_pre_merge_snapshot as { filesBefore?: Record<string, string | null> };
		expect(snap?.filesBefore?.["brand/voice.md"]).toBe("Original voice.");
	});

	it("applies jobTimeoutMs even when caller passes a shutdown AbortSignal and aborts hung store reads cleanly", async () => {
		const h = createHarness(
			{ "brand/voice.md": "Original voice." },
			{ jobTimeoutMs: 40, leaseRenewIntervalMs: 50, hangStoreGet: true },
		);
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const changeId = randomUUID();
		const shutdown = new AbortController();
		h.setPendingClaim({
			merges: [
				{
					jobId,
					kind: "land_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken,
					folderRoot: "brand",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Update voice",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Updated voice." }],
						},
					],
				},
			],
		});

		expect(await h.worker.processDue(8, shutdown.signal)).toBe(1);
		expect(shutdown.signal.aborted).toBe(false);
		expect(h.getCommitCount()).toBe(0);
		expect(h.completedMerges).toHaveLength(1);
		expect(h.completedMerges[0]).toMatchObject({
			p_job_id: jobId,
			p_status: "failed",
			p_lease_token: leaseToken,
		});
		const renewsAfter = h.getLeaseRenewCount();
		await new Promise((resolve) => setTimeout(resolve, 90));
		expect(h.getLeaseRenewCount()).toBe(renewsAfter);
	});

	it("treats 55000 Surface job is not running on completion retry after a committed write as already landed for land and undo", async () => {
		const h = createHarness({
			"brand/voice.md": "Original voice.",
		});
		const jobId = randomUUID();
		const changeId = randomUUID();
		const notRunningError = Object.assign(new Error("Surface job is not running"), { code: "55000" });

		h.setCompleteMergeAttemptErrors([new Error("attempt 1 response timed out"), notRunningError]);
		h.setPendingClaim({
			merges: [
				{
					jobId,
					kind: "land_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Update voice",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Updated voice." }],
						},
					],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		expect(h.getCommitCount()).toBe(1);
		expect(h.readText("brand/voice.md")).toBe("Updated voice.");
		expect(h.completedMerges).toHaveLength(0);
		expect(h.events.some((ev) => ev.kind === "surface_folder_merge_landed")).toBe(true);
		expect(h.events.some((ev) => ev.kind === "surface_folder_merge_completion_failed")).toBe(false);

		const undoJobId = randomUUID();
		const currentVersion = h.entries.get("brand/voice.md")?.version ?? null;
		h.setCompleteMergeAttemptErrors([new Error("undo attempt 1 response timed out"), new ObjectDependencyError(423)]);
		h.setPendingClaim({
			merges: [
				{
					jobId: undoJobId,
					kind: "undo_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeId },
					preMergeSnapshot: {
						snapshotId: "",
						folderRoot: "brand",
						changeIds: [changeId],
						filesBefore: { "brand/voice.md": "Original voice." },
						versionsAfter: { "brand/voice.md": currentVersion },
					},
					approvedChanges: [],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		expect(h.getCommitCount()).toBe(2);
		expect(h.readText("brand/voice.md")).toBe("Original voice.");
		expect(h.events.some((ev) => ev.kind === "surface_folder_undo_completion_unconfirmed" && ev.status === 423)).toBe(
			true,
		);
		expect(h.events.some((ev) => ev.kind === "surface_folder_undo_landed")).toBe(false);
		expect(h.events.some((ev) => ev.kind === "surface_folder_merge_completion_failed")).toBe(false);
	});

	it("decouples in-flight folder commits from jobTimeoutMs, replays by operationKey, and never marks a post-commit abort failed", async () => {
		const h = createHarness({ "brand/voice.md": "Original voice." }, { jobTimeoutMs: 40, commitDelayMs: 70 });
		const jobId = randomUUID();
		const changeId = randomUUID();
		const leaseToken = randomUUID();
		const shutdown = new AbortController();

		h.setPostCommitErrors([new DOMException("The operation was aborted due to timeout", "TimeoutError")]);
		h.setPendingClaim({
			merges: [
				{
					jobId,
					kind: "land_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken,
					folderRoot: "brand",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Update voice",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Committed voice." }],
						},
					],
				},
			],
		});

		expect(await h.worker.processDue(8, shutdown.signal)).toBe(1);
		expect(h.getCommitCount()).toBe(2);
		expect(h.readText("brand/voice.md")).toBe("Committed voice.");
		expect(h.completedMerges).toHaveLength(1);
		expect(h.completedMerges[0]).toMatchObject({
			p_job_id: jobId,
			p_status: "landed",
			p_lease_token: leaseToken,
		});

		const h2 = createHarness({ "brand/voice.md": "Original voice." }, { jobTimeoutMs: 40, commitDelayMs: 50 });
		const jobId2 = randomUUID();
		const changeId2 = randomUUID();
		h2.setPostCommitErrors([
			new DOMException("aborted 1", "AbortError"),
			new DOMException("aborted 2", "AbortError"),
			new DOMException("aborted 3", "AbortError"),
		]);
		h2.setPendingClaim({
			merges: [
				{
					jobId: jobId2,
					kind: "land_change",
					surfaceId: h2.surfaceId,
					profileId: h2.profileId,
					environmentId: h2.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeIds: [changeId2] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: changeId2,
							kind: "folder_patch",
							title: "Update voice again",
							summary: "Updates voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Committed unconfirmed." }],
						},
					],
				},
			],
		});

		expect(await h2.worker.processDue(8, shutdown.signal)).toBe(1);
		expect(h2.readText("brand/voice.md")).toBe("Committed unconfirmed.");
		expect(h2.completedMerges).toHaveLength(0);
		expect(h2.events.some((ev) => ev.kind === "surface_folder_merge_completion_failed")).toBe(true);
		expect(h2.events.some((ev) => ev.kind === "surface_folder_merge_failed")).toBe(false);
	});

	it("fails immediately without retrying when qorpera_folder_commit rejects with a definite SQLSTATE 42501 or HTTP 403", async () => {
		const h = createHarness({ "brand/voice.md": "Original voice." });
		const jobId = randomUUID();
		const changeId = randomUUID();
		const leaseToken = randomUUID();

		h.setPreCommitErrors([Object.assign(new Error("Company membership is required"), { code: "42501" })]);
		h.setPendingClaim({
			merges: [
				{
					jobId,
					kind: "land_change",
					surfaceId: h.surfaceId,
					profileId: h.profileId,
					environmentId: h.environmentId,
					leaseToken,
					folderRoot: "brand",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Update voice",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Should not land." }],
						},
					],
				},
			],
		});

		expect(await h.worker.processDue(8)).toBe(1);
		expect(h.getCommitCount()).toBe(1);
		expect(h.readText("brand/voice.md")).toBe("Original voice.");
		expect(h.completedMerges).toHaveLength(1);
		expect(h.completedMerges[0]).toMatchObject({
			p_job_id: jobId,
			p_status: "failed",
			p_lease_token: leaseToken,
		});
		expect(String(h.completedMerges[0]?.p_error_detail ?? "")).toContain("Company membership is required");

		const h403 = createHarness({ "brand/voice.md": "Original voice." });
		const jobId403 = randomUUID();
		const lease403 = randomUUID();
		h403.setPreCommitErrors([new ObjectDependencyError(403)]);
		h403.setPendingClaim({
			merges: [
				{
					jobId: jobId403,
					kind: "land_change",
					surfaceId: h403.surfaceId,
					profileId: h403.profileId,
					environmentId: h403.environmentId,
					leaseToken: lease403,
					folderRoot: "brand",
					payload: { changeIds: [changeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId,
							kind: "folder_patch",
							title: "Update voice",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Should not land." }],
						},
					],
				},
			],
		});

		expect(await h403.worker.processDue(8)).toBe(1);
		expect(h403.getCommitCount()).toBe(1);
		expect(h403.completedMerges).toHaveLength(1);
		expect(h403.completedMerges[0]).toMatchObject({
			p_job_id: jobId403,
			p_status: "failed",
			p_lease_token: lease403,
		});
	});

	it("retries lock-conflict rollbacks and reports failed when all attempts hit lock conflicts, but stays uncertain if a TimeoutError precedes 42501", async () => {
		const hLock = createHarness({ "brand/voice.md": "Original voice." });
		const lockJobId = randomUUID();
		const lockChangeId = randomUUID();
		const lockLease = randomUUID();
		hLock.setPreCommitErrors([
			new ObjectDependencyError(409, true),
			Object.assign(new Error("could not serialize access"), { code: "40001" }),
			new ObjectDependencyError(409, true),
		]);
		hLock.setPendingClaim({
			merges: [
				{
					jobId: lockJobId,
					kind: "land_change",
					surfaceId: hLock.surfaceId,
					profileId: hLock.profileId,
					environmentId: hLock.environmentId,
					leaseToken: lockLease,
					folderRoot: "brand",
					payload: { changeIds: [lockChangeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: lockChangeId,
							kind: "folder_patch",
							title: "Update voice under contention",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Contended update." }],
						},
					],
				},
			],
		});

		expect(await hLock.worker.processDue(8)).toBe(1);
		expect(hLock.getCommitCount()).toBe(3);
		expect(hLock.readText("brand/voice.md")).toBe("Original voice.");
		expect(hLock.completedMerges).toHaveLength(1);
		expect(hLock.completedMerges[0]).toMatchObject({
			p_job_id: lockJobId,
			p_status: "failed",
			p_lease_token: lockLease,
		});
		expect(hLock.events.some((ev) => ev.kind === "surface_folder_merge_failed")).toBe(true);
		expect(hLock.events.some((ev) => ev.kind === "surface_folder_merge_completion_failed")).toBe(false);

		const hUncertainThen42501 = createHarness({ "brand/voice.md": "Original voice." });
		const uncertainJobId = randomUUID();
		const uncertainChangeId = randomUUID();
		hUncertainThen42501.setPreCommitErrors([
			new DOMException("The operation was aborted due to timeout", "TimeoutError"),
			Object.assign(new Error("Company membership is required"), { code: "42501" }),
			Object.assign(new Error("Company membership is required"), { code: "42501" }),
		]);
		hUncertainThen42501.setPendingClaim({
			merges: [
				{
					jobId: uncertainJobId,
					kind: "land_change",
					surfaceId: hUncertainThen42501.surfaceId,
					profileId: hUncertainThen42501.profileId,
					environmentId: hUncertainThen42501.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeIds: [uncertainChangeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: uncertainChangeId,
							kind: "folder_patch",
							title: "Update voice before membership removal",
							summary: "Refines brand voice",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Maybe landed." }],
						},
					],
				},
			],
		});

		expect(await hUncertainThen42501.worker.processDue(8)).toBe(1);
		expect(hUncertainThen42501.getCommitCount()).toBe(3);
		expect(hUncertainThen42501.completedMerges).toHaveLength(0);
		expect(hUncertainThen42501.events.some((ev) => ev.kind === "surface_folder_merge_completion_failed")).toBe(true);
		expect(hUncertainThen42501.events.some((ev) => ev.kind === "surface_folder_merge_failed")).toBe(false);
	});

	it("matches composeStudioPreview path resolution and rejects ./ dot-segment ops identically", async () => {
		const baseFiles = { "identity/voice.md": "Base voice.\n" };
		const dotChangeId = randomUUID();
		const dotOps = [{ op: "write_text" as const, path: "./voice.md", content: "Dot segment.\n" }];
		const dotPreview = composeStudioPreview(baseFiles, [{ changeId: dotChangeId, ops: dotOps }], "identity");
		expect(dotPreview.status).toBe("conflicted");

		const hDot = createHarness(baseFiles);
		hDot.setPendingClaim({
			merges: [
				{
					jobId: randomUUID(),
					kind: "land_change",
					surfaceId: hDot.surfaceId,
					profileId: hDot.profileId,
					environmentId: hDot.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "identity",
					payload: { changeIds: [dotChangeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: dotChangeId,
							kind: "folder_patch",
							title: "Dot segment write",
							summary: "Attempts ./voice.md",
							affectedPaths: ["./voice.md"],
							patchManifest: dotOps,
						},
					],
				},
			],
		});
		expect(await hDot.worker.processDue(8)).toBe(1);
		expect(hDot.completedMerges[0]?.p_status).toBe("failed");
		expect(String(hDot.completedMerges[0]?.p_error_detail)).toContain("Unsafe studio patch path");

		const okChangeId = randomUUID();
		const okOps = [{ op: "write_text" as const, path: "voice.md", content: "Clean voice.\n" }];
		const okPreview = composeStudioPreview(baseFiles, [{ changeId: okChangeId, ops: okOps }], "identity");
		expect(okPreview.status).toBe("ready");
		expect(okPreview.files["identity/voice.md"]).toBe("Clean voice.\n");

		const hOk = createHarness(baseFiles);
		hOk.setPendingClaim({
			merges: [
				{
					jobId: randomUUID(),
					kind: "land_change",
					surfaceId: hOk.surfaceId,
					profileId: hOk.profileId,
					environmentId: hOk.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "identity",
					payload: { changeIds: [okChangeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: okChangeId,
							kind: "folder_patch",
							title: "Update voice",
							summary: "Updates voice.md",
							affectedPaths: ["voice.md"],
							patchManifest: okOps,
						},
					],
				},
			],
		});
		expect(await hOk.worker.processDue(8)).toBe(1);
		expect(hOk.completedMerges[0]?.p_status).toBe("landed");
		expect(hOk.readText("identity/voice.md")).toBe("Clean voice.\n");
	});

	it("reads and stages multiple files concurrently, skips redundant parent directory probes and unchanged writes", async () => {
		const readPaths: string[] = [];
		let activeReads = 0;
		let maxConcurrentReads = 0;
		let activeStages = 0;
		let maxConcurrentStages = 0;
		let openUploads = 0;

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const objects = new Map<string, Uint8Array>();
		const entries = new Map<string, StoredEntry>();
		const put = (path: string, text: string): string => {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i += 1) {
				const dir = parts.slice(0, i).join("/");
				if (!entries.has(dir)) {
					entries.set(dir, {
						kind: "folder",
						version: randomUUID(),
						content: null,
						manifestSha256: null,
						fileSha256: null,
						mediaType: "inode/directory",
					});
				}
			}
			const bytes = new TextEncoder().encode(text);
			const fileSha = digestSha256(bytes);
			const manifestText = JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v2",
				fileSha256: fileSha,
				bytes: bytes.byteLength,
				mediaType: "application/json",
				executable: false,
				chunks: bytes.byteLength > 0 ? [{ sha256: fileSha, bytes: bytes.byteLength }] : [],
			});
			const manifestBytes = new TextEncoder().encode(manifestText);
			const manifestSha = digestSha256(manifestBytes);
			objects.set(fileSha, bytes);
			objects.set(manifestSha, manifestBytes);
			const version = randomUUID();
			entries.set(path, {
				kind: "file",
				version,
				content: bytes,
				manifestSha256: manifestSha,
				fileSha256: fileSha,
				mediaType: "application/json",
			});
			return version;
		};
		put("identity/tokens.json", `${JSON.stringify({ colors: { accent: "#111111" } }, null, 2)}\n`);
		const unchangedVersion = put("identity/voice.md", "Same voice.");
		const intents = new Map<
			string,
			{ manifestSha256: string; fileSha256: string; bytes: number; mediaType: string; executable: boolean }
		>();
		const committedUnits: Record<string, unknown>[][] = [];
		const completedMerges: Record<string, unknown>[] = [];
		const jobId = randomUUID();
		const changeId = randomUUID();
		let claimed = false;

		const worker = new SurfaceFolderWorker({
			authority: {
				async publisher(method, args) {
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimed) return { merges: [], publishes: [] };
						claimed = true;
						return {
							merges: [
								{
									jobId,
									kind: "land_change",
									surfaceId,
									profileId,
									environmentId,
									leaseToken: randomUUID(),
									folderRoot: "identity",
									payload: { changeIds: [changeId] },
									preMergeSnapshot: null,
									approvedChanges: [
										{
											changeId,
											kind: "folder_patch",
											title: "Update accent only",
											summary: "Updates accent and leaves voice unchanged",
											affectedPaths: ["tokens.json", "voice.md"],
											patchManifest: [
												{ op: "merge_json", path: "tokens.json", patch: { colors: { accent: "#2255aa" } } },
												{ op: "write_text", path: "voice.md", content: "Same voice." },
											],
										},
									],
								},
							],
							publishes: [],
						};
					}
					if (method === "qorpera_folder_read") {
						const path = String(args.p_path);
						readPaths.push(path);
						activeReads += 1;
						maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
						await new Promise((resolve) => setTimeout(resolve, 15));
						activeReads -= 1;
						const entry = entries.get(path);
						if (!entry) return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: false, entry: null };
						return {
							schema: "qorpera.folder-read/v1",
							asOfSeq: 1,
							found: true,
							entry: {
								path,
								kind: entry.kind,
								version: entry.version,
								manifestSha256: entry.manifestSha256,
								fileSha256: entry.fileSha256,
								bytes: entry.content?.byteLength ?? 0,
								mediaType: entry.mediaType,
								executable: false,
							},
						};
					}
					if (method === "qorpera_folder_authorize_object_download") {
						const buf = objects.get(String(args.p_sha256));
						return { schema: "qorpera.folder-object-download/v1", profileId, bytes: buf?.byteLength ?? 0 };
					}
					if (method === "qorpera_folder_open_upload") {
						openUploads += 1;
						activeStages += 1;
						maxConcurrentStages = Math.max(maxConcurrentStages, activeStages);
						await new Promise((resolve) => setTimeout(resolve, 15));
						activeStages -= 1;
						const manifestText = String(args.p_manifest);
						const manifestBytes = new TextEncoder().encode(manifestText);
						const manifestSha = digestSha256(manifestBytes);
						const parsed = JSON.parse(manifestText) as {
							fileSha256: string;
							bytes: number;
							mediaType: string;
							executable: boolean;
						};
						const intentId = randomUUID();
						intents.set(intentId, {
							manifestSha256: manifestSha,
							fileSha256: parsed.fileSha256,
							bytes: parsed.bytes,
							mediaType: parsed.mediaType,
							executable: parsed.executable,
						});
						return { schema: "qorpera.folder-upload/v1", intentId, manifestSha256: manifestSha, present: [] };
					}
					if (method === "qorpera_folder_authorize_object_upload") {
						return { schema: "qorpera.folder-object-upload/v1", profileId };
					}
					if (method === "qorpera_folder_confirm_object") {
						return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes };
					}
					if (method === "qorpera_folder_seal_upload") {
						const intent = intents.get(String(args.p_intent))!;
						return { schema: "qorpera.folder-seal/v1", state: "sealed", intentId: args.p_intent, file: intent };
					}
					if (method === "qorpera_folder_commit") {
						const units = args.p_units as Record<string, unknown>[];
						committedUnits.push(units);
						return {
							schema: "qorpera.folder-commit/v1",
							units: units.map(() => ({ outcome: "saved", version: randomUUID() })),
						};
					}
					if (method === "qorpera_surface_complete_merge") {
						completedMerges.push(args);
						return { jobId: args.p_job_id, status: args.p_status };
					}
					return { renewed: true };
				},
			},
			store: {
				async get(_profileId, hash) {
					return objects.get(hash)!;
				},
			},
			replication: {
				async uploadWithAuthority(_profileId, hash, bytes, hooks) {
					await hooks.authorize();
					objects.set(hash, new Uint8Array(bytes));
					await hooks.confirm();
					return "stored";
				},
			},
			completionRetryDelaysMs: [5],
		});

		expect(await worker.processDue(8)).toBe(1);
		expect(maxConcurrentReads).toBeGreaterThanOrEqual(2);
		expect(maxConcurrentStages).toBe(2);
		expect(readPaths).not.toContain("identity");
		expect(openUploads).toBe(2);
		expect(committedUnits[0]?.map((unit) => unit.path)).toEqual([
			"identity/voice.md",
			"identity/tokens.json",
			"identity/tokens.css",
		]);
		expect(committedUnits[0]?.[0]?.expectedVersion).toBe(unchangedVersion);
		const snapshot = completedMerges[0]?.p_pre_merge_snapshot as {
			versionsAfter?: Record<string, string | null>;
		};
		expect(typeof snapshot?.versionsAfter?.["identity/voice.md"]).toBe("string");
	});

	it("preserves CAS guards on unchanged files, saves undo snapshots for all-unchanged patches, and serializes overlapping same-environment surfaces", async () => {
		const hNoop = createHarness({ "brand/voice.md": "Original voice." });
		const noopJobId = randomUUID();
		const noopChangeId = randomUUID();
		hNoop.setPendingClaim({
			merges: [
				{
					jobId: noopJobId,
					kind: "land_change",
					surfaceId: hNoop.surfaceId,
					profileId: hNoop.profileId,
					environmentId: hNoop.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeIds: [noopChangeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: noopChangeId,
							kind: "folder_patch",
							title: "No-op voice write",
							summary: "Writes identical content",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Original voice." }],
						},
					],
				},
			],
		});
		expect(await hNoop.worker.processDue(8)).toBe(1);
		expect(hNoop.getCommitCount()).toBe(1);
		const noopSnapshot = hNoop.completedMerges[0]?.p_pre_merge_snapshot as Record<string, unknown> | null;
		expect(noopSnapshot).toBeTruthy();

		const noopUndoJobId = randomUUID();
		hNoop.setPendingClaim({
			merges: [
				{
					jobId: noopUndoJobId,
					kind: "undo_change",
					surfaceId: hNoop.surfaceId,
					profileId: hNoop.profileId,
					environmentId: hNoop.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeId: noopChangeId },
					preMergeSnapshot: noopSnapshot,
					approvedChanges: [],
				},
			],
		});
		expect(await hNoop.worker.processDue(8)).toBe(1);
		expect(hNoop.completedMerges[1]).toMatchObject({ p_job_id: noopUndoJobId, p_status: "landed" });

		let mutatedMidFlight = false;
		const hConflict = createHarness(
			{ "brand/voice.md": "Original voice." },
			{
				onBeforeCommit: () => {
					if (!mutatedMidFlight) {
						mutatedMidFlight = true;
						hConflict.putFile("brand/voice.md", "Concurrent edit before commit.");
					}
				},
			},
		);
		const conflictJobId = randomUUID();
		const conflictChangeId = randomUUID();
		hConflict.setPendingClaim({
			merges: [
				{
					jobId: conflictJobId,
					kind: "land_change",
					surfaceId: hConflict.surfaceId,
					profileId: hConflict.profileId,
					environmentId: hConflict.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "brand",
					payload: { changeIds: [conflictChangeId] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: conflictChangeId,
							kind: "folder_patch",
							title: "No-op voice write racing concurrent edit",
							summary: "Writes identical content",
							affectedPaths: ["voice.md"],
							patchManifest: [{ op: "write_text", path: "voice.md", content: "Original voice." }],
						},
					],
				},
			],
		});
		expect(await hConflict.worker.processDue(8)).toBe(1);
		expect(hConflict.completedMerges[0]).toMatchObject({
			p_job_id: conflictJobId,
			p_status: "conflicted",
			p_conflict_paths: ["brand/voice.md"],
		});
		expect(hConflict.readText("brand/voice.md")).toBe("Concurrent edit before commit.");

		const hOverlap = createHarness({ "site/blog/post.md": "v0" }, { commitDelayMs: 20 });
		const secondSurfaceId = randomUUID();
		const jobA = randomUUID();
		const jobB = randomUUID();
		const changeA = randomUUID();
		const changeB = randomUUID();
		hOverlap.setPendingClaim({
			merges: [
				{
					jobId: jobA,
					kind: "land_change",
					surfaceId: hOverlap.surfaceId,
					profileId: hOverlap.profileId,
					environmentId: hOverlap.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "site",
					payload: { changeIds: [changeA] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: changeA,
							kind: "folder_patch",
							title: "Root edit",
							summary: "Edits nested post via parent root",
							affectedPaths: ["blog/post.md"],
							patchManifest: [{ op: "write_text", path: "blog/post.md", content: "v1" }],
						},
					],
				},
				{
					jobId: jobB,
					kind: "land_change",
					surfaceId: secondSurfaceId,
					profileId: hOverlap.profileId,
					environmentId: hOverlap.environmentId,
					leaseToken: randomUUID(),
					folderRoot: "site/blog",
					payload: { changeIds: [changeB] },
					preMergeSnapshot: null,
					approvedChanges: [
						{
							changeId: changeB,
							kind: "folder_patch",
							title: "Nested edit",
							summary: "Edits same post via nested root",
							affectedPaths: ["post.md"],
							patchManifest: [{ op: "write_text", path: "post.md", content: "v2" }],
						},
					],
				},
			],
		});
		expect(await hOverlap.worker.processDue(8)).toBe(2);
		expect(hOverlap.completedMerges).toHaveLength(2);
		expect(hOverlap.completedMerges[0]).toMatchObject({ p_job_id: jobA, p_status: "landed" });
		expect(hOverlap.completedMerges[1]).toMatchObject({ p_job_id: jobB, p_status: "landed" });
		expect(hOverlap.readText("site/blog/post.md")).toBe("v2");
	});
});
