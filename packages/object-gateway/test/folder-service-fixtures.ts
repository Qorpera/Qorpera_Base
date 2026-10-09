/** Shared by the folder service's tests: a company in memory (the folder core) and its bytes on a stand-in for the
 * storage server's share. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CommitActor,
	type CommitAnswer,
	type CommitOutcome,
	type ConflictCopy,
	type CoreEntry,
	type CoreReceipt,
	CoreRefusal,
	type FeedChange,
	type FeedEvent,
	type FolderActor,
	type FolderCore,
	type UploadSeal,
	type ViewRenewal,
} from "../src/folder-service/core.ts";
import type { MachineRef } from "../src/folder-service/machines.ts";
import { MountGrants, parseOperatorMounts } from "../src/folder-service/mounts.ts";
import type { CommitUnit } from "../src/folder-service/plan.ts";
import type { BridgeInfo } from "../src/folder-service/protocol.ts";
import type { FolderUploads, Upload } from "../src/folder-service/staging.ts";

export const ENV = "11111111-2222-4333-8444-555555555555";
export const PROFILE = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
export const MEMBER = "66666666-7777-4888-8999-000000000000";
export const MACHINE: MachineRef = {
	project: "qn25b2",
	name: "qorpera-exec-node02",
	physicalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};
export const CID = 42;
/** What the bridge says for the configured machine. */
export const BRIDGE: BridgeInfo = { cid: CID, lookup: "found", machine: MACHINE };
/** The core's version ids are uuids; tests number them. */
export const v = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const PASS = "operator-pass-0123456789-abcdefghijklmnopq";
export const hashOf = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
/** Stores a file's bytes the way the gateway does (a v2 manifest and its chunks) and returns its core entry. */
export async function storeFile(
	root: string,
	path: string,
	content: string,
	version: number,
	chunkBytes = 4,
	options: { executable?: boolean; mediaType?: string } = {},
): Promise<CoreEntry> {
	const bytes = Buffer.from(content);
	const chunks: { sha256: string; bytes: number }[] = [];
	await mkdir(join(root, PROFILE), { recursive: true });
	for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
		const chunk = bytes.subarray(offset, offset + chunkBytes);
		chunks.push({ sha256: hashOf(chunk), bytes: chunk.byteLength });
		await writeFile(join(root, PROFILE, hashOf(chunk)), chunk);
	}
	const mediaType = options.mediaType ?? "text/plain";
	const executable = options.executable ?? false;
	const manifest = JSON.stringify({
		schema: "qorpera.cloud-file-manifest/v2",
		fileSha256: hashOf(bytes),
		bytes: bytes.byteLength,
		mediaType,
		executable,
		chunks,
	});
	await writeFile(join(root, PROFILE, hashOf(manifest)), manifest);
	return {
		path,
		kind: "file",
		version: v(version),
		manifestSha256: hashOf(manifest),
		fileSha256: hashOf(bytes),
		bytes: bytes.byteLength,
		mediaType,
		executable,
		updatedAt: "2026-10-01T12:00:00.000Z",
	};
}

export function folder(path: string, version = 1): CoreEntry {
	return { path, kind: "folder", version: v(version), updatedAt: "2026-10-01T12:00:00.000Z" };
}

/** The folder core, in memory: one company, a journal of change sets and access changes, and a visibility rule for
 * the member. Pages are two entries long so paging is exercised. */
export class FakeCore implements FolderCore {
	seq = 0;
	readonly entries = new Map<string, CoreEntry>();
	readonly journal: FeedEvent[] = [];
	hidden: (path: string) => boolean = () => false;
	deny = false;
	listCalls = 0;
	profileCalls = 0;
	/** Core views, as C1b-3a keeps them: id to pass and state, the view's kind and the machine allocation it was opened
	 * on (null for a run box: 20260930104000), what each renewal said was unsaved since, and for a shell command's view
	 * (20260930183000) whether its command has ended. */
	readonly views = new Map<
		string,
		{
			pass: string;
			state: "open" | "closed";
			renewals: number;
			environmentId: string;
			kind: string;
			machineId: string | null;
			unsaved: (string | null)[];
			ended: boolean;
		}
	>();
	renewalFails = false;
	/** The database's clock, for leases. */
	now: () => number = Date.now;
	/** When set, listings wait for it (a slow first listing). */
	listGate: Promise<void> | undefined;
	/** The read receipt an agent's listing gives each path (a run box view acts as an agent); the feed gives none. */
	receipts: ((path: string) => CoreReceipt | undefined) | undefined;

	/** A run box, unless `kind` says otherwise. */
	openView(
		viewId: string,
		pass: string,
		options: { environmentId?: string; kind?: string; machineId?: string | null } = {},
	): void {
		this.views.set(viewId, {
			pass,
			state: "open",
			renewals: 0,
			environmentId: options.environmentId ?? ENV,
			kind: options.kind ?? "run_box",
			machineId: options.machineId ?? null,
			unsaved: [],
			ended: false,
		});
	}

	/** The office's report ends a shell command's view's command: the view still renews, and saves only its final. */
	endCommand(viewId: string): void {
		const view = this.views.get(viewId);
		if (view?.kind !== "computer_shell_command") throw new Error("Not a command's view");
		view.ended = true;
	}

	/** A view actor reads only in its own company folder, with its own pass, and only while its view is open
	 * (view_resolve: 42501). */
	#check(actor: FolderActor, environmentId: string) {
		if (actor.kind !== "view") return undefined;
		const view = this.views.get(actor.viewId);
		if (!view || view.pass !== actor.pass || view.state !== "open" || view.environmentId !== environmentId)
			throw new CoreRefusal("denied");
		return view;
	}
	/** Events per feed page (0: all in one page), and the feed call (counted from `feedCalls`) that fails. */
	feedPage = 0;
	feedCalls = 0;
	failFeedAt: number | undefined;
	/** The next feed calls that fail. */
	feedFailures = 0;
	/** Called with each feed call's position before it is answered: it may throw (the call fails) or hold it. */
	feedHook: ((afterSeq: number) => Promise<void> | undefined) | undefined;
	/** When set, the storage profile of an upload waits for it, and so does a commit. */
	uploadProfileGate: Promise<void> | undefined;
	commitGate: Promise<void> | undefined;

	seed(entries: CoreEntry[]): void {
		for (const e of entries) this.entries.set(e.path, e);
	}

	write(entry: CoreEntry): void {
		this.seq++;
		this.entries.set(entry.path, entry);
		this.journal.push({ seq: this.seq, kind: "change_set", changes: [{ ...entry, op: "write" }] });
	}

	remove(path: string): void {
		this.seq++;
		const old = this.entries.get(path)!;
		this.entries.delete(path);
		this.journal.push({ seq: this.seq, kind: "change_set", changes: [{ ...old, op: "delete" }] });
	}

	/** One change set of several changes, in the order given (the core's feed orders them by version). */
	commitChanges(changes: FeedChange[]): void {
		this.seq++;
		for (const change of changes) {
			if (change.op === "delete" || change.op === "move_out") this.entries.delete(change.path);
			else {
				const { op: _op, ...entry } = change;
				this.entries.set(change.path, entry);
			}
		}
		this.journal.push({ seq: this.seq, kind: "change_set", changes });
	}

	authority(hidden: (path: string) => boolean): void {
		this.seq++;
		this.hidden = hidden;
		this.journal.push({ seq: this.seq, kind: "authority" });
	}

	#visible(actor: FolderActor): CoreEntry[] {
		return [...this.entries.values()]
			.filter((e) => actor.kind === "platform" || !this.hidden(e.path))
			.sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	async list(environmentId: string, actor: FolderActor, after: string | null) {
		this.listCalls++;
		await this.listGate;
		// A view in another company folder is refused as the real core does (view_resolve: 42501).
		this.#check(actor, environmentId);
		if (environmentId !== ENV) throw new CoreRefusal("invalid");
		if (this.deny) throw new CoreRefusal("denied");
		const receipts = actor.kind === "view" ? this.receipts : undefined;
		const all = this.#visible(actor).map((e) => {
			const authority = receipts?.(e.path);
			return authority ? { ...e, authority } : e;
		});
		const start = after === null ? 0 : all.findIndex((e) => e.path === after) + 1;
		const page = all.slice(start, start + 2);
		return { asOfSeq: this.seq, entries: page, next: start + 2 < all.length ? page[page.length - 1]!.path : null };
	}

	async feed(environmentId: string, actor: FolderActor, afterSeq: number) {
		this.#check(actor, environmentId);
		if (environmentId !== ENV) throw new CoreRefusal("invalid");
		if (this.deny) throw new CoreRefusal("denied");
		this.feedCalls++;
		if (this.failFeedAt === this.feedCalls) throw new Error("The core did not answer this page");
		if (this.feedFailures > 0) {
			this.feedFailures--;
			throw new Error("The core did not answer this page");
		}
		await this.feedHook?.(afterSeq);
		const events = this.journal
			.filter((e) => e.seq > afterSeq)
			.map((e) =>
				e.kind === "change_set"
					? { ...e, changes: e.changes.filter((c) => actor.kind === "platform" || !this.hidden(c.path)) }
					: e,
			)
			.filter((e) => e.kind === "authority" || e.changes.length > 0);
		const page = this.feedPage > 0 ? events.slice(0, this.feedPage) : events;
		const more = page.length < events.length;
		return {
			asOfSeq: this.seq,
			resync: afterSeq > this.seq,
			events: page,
			next: { afterSeq: more ? page[page.length - 1]!.seq : this.seq, cursor: null },
			more,
		};
	}

	async clocks(environmentIds: readonly string[]) {
		return new Map(environmentIds.filter((id) => id === ENV).map((id) => [id, this.seq]));
	}

	async objectProfile(environmentId: string, actor: FolderActor) {
		this.profileCalls++;
		if (environmentId !== ENV) throw new CoreRefusal("invalid");
		this.#check(actor, environmentId);
		return PROFILE;
	}

	// ---- Staging and the commit (F3 step 3), as C1D §3 and core §3 decide them, in memory --------------------------

	/** Objects on the share the catalog knows, by hash: their sizes. */
	readonly catalog = new Map<string, number>();
	readonly intents = new Map<string, { manifest: string; objects: Map<string, number>; put: Set<string> }>();
	/** Every commit asked, in order (a replay included), and whether it was a command view's final. */
	readonly commits: { key: string; units: readonly CommitUnit[]; final: boolean }[] = [];
	readonly #answers = new Map<string, { request: string; answer: CommitAnswer }>();
	#nextVersion = 1000;
	/** A path's units the core refuses (no write authority there). */
	refuse: (path: string) => boolean = () => false;
	/** A path's units the core parks for review, applying nothing (P40: an agent's change that needs a member's). */
	park: (path: string) => boolean = () => false;
	/** Whether a conflicting write or new folder keeps its files on the receipt (P17 keeps them only when their bytes
	 * would have passed); the copies kept, by commit. */
	copyConflicts = true;
	readonly copies = new Map<string, ConflictCopy[]>();
	/** Intents the core let lapse (their renewal is refused), the next renewals that do not get through, and every
	 * renewal asked. */
	readonly lapsed = new Set<string>();
	renewFailures = 0;
	readonly renewals: string[] = [];
	/** The next commits get no answer: `lost` applies them first (the reply was lost, and so may a replay's be), `down`
	 * does not. */
	commitFailures: { mode: "lost" | "down"; count: number } = { mode: "down", count: 0 };
	/** When set, the core refuses every commit not asked before whole, and why (the pause: `stopped`; a change set over
	 * its 1000 units: `invalid`; and the like). */
	commitRefusal: CoreRefusal["reason"] | undefined;

	async openUpload(environmentId: string, actor: FolderActor, manifest: string) {
		this.#check(actor, environmentId);
		const m = JSON.parse(manifest) as { chunks: { sha256: string; bytes: number }[] };
		const objects = new Map<string, number>([[hashOf(manifest), Buffer.byteLength(manifest)]]);
		for (const c of m.chunks) objects.set(c.sha256, c.bytes);
		const intentId = v(this.#nextVersion++);
		this.intents.set(intentId, { manifest, objects, put: new Set() });
		return { intentId, present: [...objects.keys()].filter((h) => this.catalog.get(h) === objects.get(h)) };
	}

	async uploadProfile(environmentId: string, actor: FolderActor, intentId: string) {
		await this.uploadProfileGate;
		this.#check(actor, environmentId);
		if (!this.intents.has(intentId)) throw new CoreRefusal("denied");
		return PROFILE;
	}

	async sealUpload(environmentId: string, actor: FolderActor, intentId: string): Promise<UploadSeal> {
		this.#check(actor, environmentId);
		const intent = this.intents.get(intentId);
		if (!intent) throw new CoreRefusal("denied");
		const missing = [...intent.objects].filter(([h, b]) => this.catalog.get(h) !== b).map(([h]) => h);
		if (missing.length > 0) return { state: "incomplete", missing };
		const m = JSON.parse(intent.manifest) as {
			fileSha256: string;
			bytes: number;
			mediaType: string;
			executable: boolean;
		};
		return {
			state: "sealed",
			file: {
				manifestSha256: hashOf(intent.manifest),
				fileSha256: m.fileSha256,
				bytes: m.bytes,
				mediaType: m.mediaType,
				executable: m.executable,
			},
		};
	}

	async renewUpload(environmentId: string, actor: FolderActor, intentId: string) {
		this.#check(actor, environmentId);
		this.renewals.push(intentId);
		if (this.renewFailures > 0) {
			this.renewFailures--;
			throw new Error("The database did not answer");
		}
		if (this.lapsed.has(intentId) || !this.intents.has(intentId)) throw new CoreRefusal("denied");
		return new Date(this.now() + 15 * 60_000).toISOString();
	}

	/** The core's unit rules (core §3), each unit whole or not at all, applied in order; the saved ones are one change
	 * set on the journal. A key asked again with the same units (and the same `final`) answers the same, its view
	 * closed or not, given its pass; with others, 22023. A command view's final (20260930183000) closes it, saved or
	 * not, and may be empty; once its command has ended, the view saves nothing else (42501). */
	async commit(environmentId: string, actor: CommitActor, key: string, units: readonly unknown[]) {
		await this.commitGate;
		const final = "final" in actor;
		const request = JSON.stringify({ final, units });
		this.commits.push({ key, units: units as CommitUnit[], final });
		if (actor.kind === "view") {
			const view = this.views.get(actor.viewId);
			if (!view || view.pass !== actor.pass || view.environmentId !== environmentId) throw new CoreRefusal("denied");
		}
		const earlier = this.#answers.get(key);
		if (earlier) {
			if (earlier.request !== request) throw new CoreRefusal("invalid");
			return this.#answered(earlier.answer);
		}
		const view = this.#check(actor, environmentId);
		if (final && view?.kind !== "computer_shell_command") throw new CoreRefusal("invalid");
		if (units.length === 0 && !final) throw new CoreRefusal("invalid");
		if (view?.kind === "computer_shell_command" && view.ended && !final) throw new CoreRefusal("denied");
		if (this.commitRefusal) throw new CoreRefusal(this.commitRefusal);
		if (this.commitFailures.count > 0 && this.commitFailures.mode === "down") {
			this.commitFailures.count--;
			throw new Error("The database did not answer");
		}
		const commitId = v(this.#nextVersion++);
		const kept: ConflictCopy[] = [];
		const changes: FeedChange[] = [];
		const now = "2026-10-05T12:00:00.000Z";
		const parentOk = (path: string) => {
			const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			return parent === "" || this.entries.get(parent)?.kind === "folder";
		};
		const subtree = (path: string) => [...this.entries.keys()].filter((p) => p === path || p.startsWith(`${path}/`));
		const outcomes: CommitOutcome[] = (units as CommitUnit[]).map((u, i) => {
			const unit = i + 1;
			const no = (outcome: CommitOutcome["outcome"], reason: string): CommitOutcome => ({
				unit,
				outcome,
				reason,
				version: null,
			});
			const path = u.op === "move" ? u.to : u.path;
			if (this.refuse(path) || (u.op === "move" && this.refuse(u.from))) return no("denied", "denied");
			if (this.park(path)) return no("waiting_for_review", "parked");
			const conflict = (reason: string): CommitOutcome => {
				const files =
					u.op === "write"
						? [{ path: u.path, file: u.file }]
						: u.op === "new_folder"
							? u.contents.flatMap((c) => (c.file ? [{ path: `${u.path}/${c.path}`, file: c.file }] : []))
							: [];
				if (this.copyConflicts)
					for (const [i, { path, file }] of files.entries())
						kept.push({ unit, file: i + 1, path, manifestSha256: file.manifestSha256 });
				return no("conflict", reason);
			};
			switch (u.op) {
				case "write": {
					const e = this.entries.get(u.path);
					if (u.expectedVersion !== undefined ? e?.kind !== "file" || e.version !== u.expectedVersion : e)
						return conflict(u.expectedVersion !== undefined ? "version_changed" : "exists");
					if (!parentOk(u.path)) return no("refused", "parent_missing");
					const entry: CoreEntry = {
						path: u.path,
						kind: "file",
						version: v(this.#nextVersion++),
						...u.file,
						updatedAt: now,
					};
					this.entries.set(u.path, entry);
					changes.push({ ...entry, op: "write" });
					return { unit, outcome: "saved", reason: null, version: entry.version };
				}
				case "mkdir":
				case "new_folder": {
					if (this.entries.has(u.path))
						return u.op === "new_folder" ? conflict("exists") : no("conflict", "exists");
					if (!parentOk(u.path)) return no("refused", "parent_missing");
					const entry: CoreEntry = {
						path: u.path,
						kind: "folder",
						version: v(this.#nextVersion++),
						updatedAt: now,
					};
					this.entries.set(u.path, entry);
					changes.push({ ...entry, op: "mkdir" });
					if (u.op === "new_folder")
						for (const c of u.contents) {
							const inner: CoreEntry =
								c.kind === "folder"
									? {
											path: `${u.path}/${c.path}`,
											kind: "folder",
											version: v(this.#nextVersion++),
											updatedAt: now,
										}
									: {
											path: `${u.path}/${c.path}`,
											kind: "file",
											version: v(this.#nextVersion++),
											...c.file!,
											updatedAt: now,
										};
							this.entries.set(inner.path, inner);
							changes.push({ ...inner, op: c.kind === "folder" ? "mkdir" : "write" });
						}
					return { unit, outcome: "saved", reason: null, version: entry.version };
				}
				case "delete": {
					const e = this.entries.get(u.path);
					if (!e || e.version !== u.expectedVersion) return no("conflict", e ? "version_changed" : "missing");
					for (const p of subtree(u.path)) {
						const gone = this.entries.get(p)!;
						this.entries.delete(p);
						changes.push({ path: p, kind: gone.kind, version: gone.version, op: "delete" });
					}
					return { unit, outcome: "saved", reason: null, version: null };
				}
				case "move": {
					const e = this.entries.get(u.from);
					if (!e || e.version !== u.expectedVersion) return no("conflict", e ? "version_changed" : "missing");
					if (this.entries.has(u.to)) return no("conflict", "exists");
					if (!parentOk(u.to)) return no("refused", "parent_missing");
					let version: string | null = null;
					for (const p of subtree(u.from)) {
						const old = this.entries.get(p)!;
						this.entries.delete(p);
						changes.push({ path: p, kind: old.kind, version: old.version, op: "move_out" });
						const moved: CoreEntry = {
							...old,
							path: u.to + p.slice(u.from.length),
							version: v(this.#nextVersion++),
						};
						this.entries.set(moved.path, moved);
						changes.push({ ...moved, op: "move_in", priorVersion: old.version });
						if (p === u.from) version = moved.version;
					}
					return { unit, outcome: "saved", reason: null, version };
				}
			}
			throw new Error("Unknown unit");
		});
		let seq: number | null = null;
		if (changes.length > 0) {
			seq = ++this.seq;
			this.journal.push({ seq, kind: "change_set", changes });
		}
		if (final && view) view.state = "closed";
		const answer: CommitAnswer = { commitId, seq, units: outcomes };
		this.copies.set(commitId, kept);
		this.#answers.set(key, { request, answer });
		return this.#answered(answer);
	}

	/** A commit's answer, unless the next one is lost. */
	#answered(answer: CommitAnswer): CommitAnswer {
		if (this.commitFailures.count > 0 && this.commitFailures.mode === "lost") {
			this.commitFailures.count--;
			throw new Error("The answer was lost");
		}
		return answer;
	}

	async conflictCopies(environmentId: string, commitId: string): Promise<readonly ConflictCopy[]> {
		if (environmentId !== ENV) throw new CoreRefusal("invalid");
		return this.copies.get(commitId) ?? [];
	}

	async renewView(viewId: string, pass: string, unsavedSince: string | null): Promise<ViewRenewal> {
		const view = this.views.get(viewId);
		if (!view || view.pass !== pass) throw new CoreRefusal("denied");
		if (this.renewalFails) throw new Error("The database did not answer");
		view.renewals++;
		view.unsaved.push(unsavedSince);
		return view.state === "open"
			? {
					state: "open",
					leaseUntil: new Date(this.now() + 120_000).toISOString(),
					kind: view.kind,
					machineId: view.machineId,
				}
			: { state: "closed", reason: "ended" };
	}
}

/** The execution host's machine, which may present run box views. */
export const EXEC_HOST: MachineRef = {
	project: "qn25b2",
	name: "qorpera-exec-node02",
	physicalId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
};

export function grants(): MountGrants {
	return new MountGrants(
		parseOperatorMounts([
			{
				id: "proof",
				environmentId: ENV,
				actor: { kind: "member", userId: MEMBER },
				machine: MACHINE,
				passSha256: hashOf(PASS),
			},
		]),
		[EXEC_HOST],
	);
}

/** The node's office project, where its company machines run (F3 4a). */
export const OFFICE_PROJECT = "qn25b2-office";
/** A company machine's allocation, and the machine the node made for it, named after it (`lxd-office-guest.ts`). */
export const ALLOCATION = "c0ffee00-1111-4222-8333-444455556666";
export const OFFICE: MachineRef = {
	project: OFFICE_PROJECT,
	name: `qorpera-office-${ALLOCATION.replaceAll("-", "")}`,
	physicalId: "cccccccc-dddd-4eee-8fff-000000000000",
};

/** No operator mount: the execution host presents run boxes, and the office project's machines their desktops. */
export function companyGrants(): MountGrants {
	return new MountGrants([], [EXEC_HOST], [OFFICE_PROJECT]);
}

/** The object gateway's route for the folder service, onto the stand-in share: each put checked against its hash,
 * stored, and catalogued. */
export class FakeUploads implements FolderUploads {
	readonly #root: string;
	readonly #core: FakeCore;
	readonly puts: string[] = [];
	/** The next puts fail (the gateway refused or was unreachable). */
	failures = 0;
	/** When set, a put's end waits for it. */
	endGate: Promise<void> | undefined;

	constructor(root: string, core: FakeCore) {
		this.#root = root;
		this.#core = core;
	}

	start(_environmentId: string, _actor: FolderActor, intentId: string, sha256: string, bytes: number): Upload {
		const parts: Buffer[] = [];
		return {
			write: async (part) => {
				parts.push(part);
			},
			end: async () => {
				await this.endGate;
				if (this.failures > 0) {
					this.failures--;
					throw new Error("The gateway did not store it");
				}
				const body = Buffer.concat(parts);
				if (body.byteLength !== bytes || hashOf(body) !== sha256) throw new Error("Not the object it names");
				if (this.#core.intents.get(intentId)?.objects.get(sha256) !== bytes) throw new Error("Not in the intent");
				await mkdir(join(this.#root, PROFILE), { recursive: true });
				await writeFile(join(this.#root, PROFILE, sha256), body);
				this.#core.catalog.set(sha256, bytes);
				this.#core.intents.get(intentId)!.put.add(sha256);
				this.puts.push(sha256);
			},
			abort: () => undefined,
		};
	}
}

/** A writable operator mount of the member (or the platform), optionally publishing after a quiet period. */
export function writableGrants(quietMs?: number, platform = false): MountGrants {
	return new MountGrants(
		parseOperatorMounts([
			{
				id: "proof",
				environmentId: ENV,
				actor: platform ? { kind: "platform" } : { kind: "member", userId: MEMBER },
				machine: MACHINE,
				passSha256: hashOf(PASS),
				write: true,
				...(quietMs === undefined ? {} : { quietMs }),
			},
		]),
		[EXEC_HOST],
	);
}
