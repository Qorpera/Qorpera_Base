import { type CloudCodingRepository, isUuid, parseCloudCodingRepository } from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import { type CodeChangeRecordsOptions, codeChangeErrorCode } from "./code-change-records.ts";
import { type CodeHostJob, CodeHostJobFailure } from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CodingControlBusy } from "./coding-executor.ts";
import {
	deployCodeSiteToNativeEdge,
	type NativeCodeSiteSpec,
	type NativeEdgeHostingConfig,
	parseNativeCodeSiteSpec,
} from "./native-webapp-deploy.ts";

/** The upload of a repository's site (own code storage, step 4, part U; STEP4-RELEASES-PLAN.md 8.5 as STEP4-BUILD.md
 * section 1 replaced it). A landing whose checks passed keeps the site its checks built as a git tree in the
 * repository's storage, and its row names the tree. This pass takes each site the kernel says is due, reads its tree
 * in a code host job that yields to a turn's, and uploads it into the site tables as a version a member can put live
 * on What's new:
 *
 *   begin     the site (made at the first upload) and the version for the tree, with the manifest, the count, the bytes
 *   list      the files, in pages; left out when the version is listed already (an upload that stopped half way)
 *   missing   the files with no bytes yet, in pages: the kernel copies a file another version of the site has
 *   put       their bytes, in parts: small files share a call, a larger one is cut
 *   finish    the version is ready
 *
 * No request is over 120 KiB and no answer near 256 KiB, the executor's control's bounds. A refusal is an answer of its
 * own (a raised error reaches the pass only as CODING_CONTROL_UNCONFIRMED). Whatever stops a site, a refusal, a call
 * that did not answer or a job that failed, is told to the kernel with `qorpera_code_site_failed` and its code: the
 * kernel counts it, waits longer before it names the site again, and stops trying a change after five. The pass then
 * goes on to the next site. A job that gave way to a turn's failed nothing: the next pass reads the tree again.
 *
 * A site Qorpera took down (own code storage step 5.1; the review of #1774, round 3) is a plain stop: any step's refusal
 * `SITE_TAKEN_DOWN` (begin, list, put or finish) ends the site's upload where it is, logged (`code-site`, step
 * `taken-down`), and nothing is told: the kernel's due list leaves such a site out until Qorpera restores it, so the
 * pass asks nothing more of it meanwhile, and no try is counted against the change (it is not given up). Restored, the
 * site is due again and the next pass goes on with the same version where this one stopped. */

export const CODE_SITE_RPCS = [
	"qorpera_code_sites_due",
	"qorpera_code_site_begin",
	"qorpera_code_site_list",
	"qorpera_code_site_missing",
	"qorpera_code_site_put",
	"qorpera_code_site_finish",
	"qorpera_code_site_failed",
] as const;

/** The most a request of the pass is as JSON: the control refuses one over 128 KiB. */
export const CODE_SITE_REQUEST_BYTES = 120 * 1024;
/** The most file bytes one put carries, before base64: its base64 and the parts' paths stay within a request. A file
 * larger than this is cut into parts of this size, numbered from 0 (a site's largest file, 10 MiB, into 117). */
export const CODE_SITE_PART_BYTES = 88 * 1024;
/** The most parts one put carries (the kernel's bound; a site's 500 files never need more). */
export const CODE_SITE_PUT_PARTS = 500;
export const CODE_SITE_PUT_CONCURRENCY = 8;
const CODE_SITE_MAX_PUT_CONCURRENCY = 16;
/** The most files one call lists, and the most its request is as JSON. */
export const CODE_SITE_LIST_FILES = 150;
export const CODE_SITE_LIST_BYTES = 100 * 1024;
/** The most paths one `missing` names: a hundred of a site path's 512 bytes are an answer of about 60 KiB. */
export const CODE_SITE_MISSING_PATHS = 100;

const CALL_MS = 30_000;
const SHA256 = /^[0-9a-f]{64}$/;
/** A code the kernel keeps as the repository's site problem. */
const PROBLEM = /^[A-Z0-9_:]{1,120}$/;
const YIELDED = "CODE_HOST_JOB_YIELDED";
/** A call that did not answer, or answered what the pass cannot read. */
const UPLOAD_FAILED = "SITE_UPLOAD_FAILED";
/** A kernel that was busy (a lock it waited for, a statement out of time) wrote nothing and is no failure of the site:
 * the next pass tries again. Only a site whose call is busy this many passes in a row is told as a call that did not
 * answer, so a put that can never finish in time is backed off and given up like any other failure. */
const BUSY_PASSES = 3;
/** A step's refusal for a site Qorpera took down: a plain stop, not a failure (the header says why). */
const TAKEN_DOWN = "SITE_TAKEN_DOWN";
/** A read that failed without a code of its own. */
const READ_FAILED = "CODE_HOST_SITE_READ_FAILED";
const STATES = ["ready", "live", "kept"] as const;
type Done = (typeof STATES)[number];

// STAND-IN for part B (`code-host-sites.ts`, STEP4-RELEASES-PLAN.md 8.2) until it is merged. `readCodeSiteTree`
// answers files of this shape (its `CodeSiteTreeFile`) and the manifest over them; once B is in, `read` is
// `typeof readCodeSiteTree` and these two go.
/** One file of a site's tree as the code host read it: its path in the site, its bytes and their SHA-256. */
export interface CodeSiteUploadFile {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly content: Uint8Array;
}
/** Reads one site tree of a repository kept in Qorpera, in a code host job: every file, and the manifest (lines `path
 * TAB sha256 TAB bytes` in C order joined by LF, then SHA-256, as `publish_site` makes it). */
export type CodeSiteTreeRead = (
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string },
) => Promise<{ files: readonly CodeSiteUploadFile[]; manifestSha256: string }>;

/** A repository kept in Qorpera whose site is due. */
export interface CodeSiteTarget {
	companyId: string;
	environmentId: string;
	owner: string;
	name: string;
}

export type CodeSiteSourceExport = (
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string },
) => Promise<{ sourceDir: string; cleanup?: () => Promise<void> }>;

export interface CodeSiteUploadsOptions {
	control: CodeChangeRecordsOptions["control"];
	hosts: Pick<CodeHostJobs, "run">;
	read: CodeSiteTreeRead;
	owner: string;
	machineIdSha256: string;
	report?: (event: Record<string, unknown>) => void;
	limit?: number;
	putConcurrency?: number;
	nativeEdge?: NativeEdgeHostingConfig;
	exportSource?: CodeSiteSourceExport;
}

interface Due {
	target: CodeSiteTarget;
	change: number;
	site: NativeCodeSiteSpec | null;
}

/** What stopped a site: the step, the code the kernel is told, and what the log shows of why. */
class SiteStopped extends Error {
	readonly step: string;
	readonly code: string;
	readonly path: string | null;
	constructor(step: string, code: string, cause?: unknown, path: string | null = null) {
		super(code, cause === undefined ? undefined : { cause });
		this.step = step;
		this.code = code;
		this.path = path;
	}
}
/** The kernel says this executor does not hold the company any more: nothing is told, and nothing asked again. */
class SiteLost extends Error {
	readonly step: string;
	constructor(step: string) {
		super("CODE_SITE_LOST");
		this.step = step;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const whole = (value: unknown, least = 0): value is number => Number.isSafeInteger(value) && (value as number) >= least;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
/** C order: the database's (collate "C"), byte by byte in UTF-8. */
const cOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export class CodeSiteUploads {
	readonly #control: CodeSiteUploadsOptions["control"];
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #read: CodeSiteTreeRead;
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #limit: number;
	readonly #putConcurrency: number;
	readonly #nativeEdge: NativeEdgeHostingConfig | undefined;
	readonly #exportSource: CodeSiteSourceExport | undefined;
	readonly #busy = new Map<string, number>();
	/** A wake that came while nothing waited: the next wait ends at once. */
	#woken = false;
	readonly #waiting = new Set<() => void>();

	constructor(options: CodeSiteUploadsOptions) {
		const limit = options.limit ?? 10;
		const putConcurrency = options.putConcurrency ?? CODE_SITE_PUT_CONCURRENCY;
		if (
			typeof options.owner !== "string" ||
			!options.owner ||
			typeof options.machineIdSha256 !== "string" ||
			!SHA256.test(options.machineIdSha256) ||
			typeof options.read !== "function" ||
			!whole(limit, 1) ||
			limit > 20 ||
			!whole(putConcurrency, 1) ||
			putConcurrency > CODE_SITE_MAX_PUT_CONCURRENCY
		)
			throw new Error("INVALID_CODE_SITE_UPLOADS");
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#read = options.read;
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		const report = options.report;
		// The log must never change what happens: a reporter that throws is not heard.
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				/* not heard */
			}
		};
		this.#limit = limit;
		this.#putConcurrency = putConcurrency;
		this.#nativeEdge = options.nativeEdge;
		this.#exportSource = options.exportSource;
	}

	/** A landing kept a site: the wait between passes ends now, or the next one does not begin. */
	wake(): void {
		this.#woken = true;
		for (const end of [...this.#waiting]) end();
	}

	/** The wait between passes: `ms`, or until a wake, or until `signal` aborts. It never rejects. A wake that came
	 * since the last wait ended ends this one at once. */
	wait(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (this.#woken || signal.aborted) {
				this.#woken = false;
				resolve();
				return;
			}
			const end = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", end);
				this.#waiting.delete(end);
				this.#woken = false;
				resolve();
			};
			const timer = setTimeout(end, Math.max(0, ms));
			signal.addEventListener("abort", end, { once: true });
			this.#waiting.add(end);
		});
	}

	/** One pass: each due site in turn. It never throws, for one site nor for a kernel that does not answer: those are
	 * reported (`code-site-error`). `uploaded` counts the sites whose version is ready (or was), `failed` those the kernel
	 * was told of, or that it says are not this executor's. One whose job gave way to a turn's is in neither. */
	async pass(signal: AbortSignal): Promise<{ uploaded: number; failed: number }> {
		const counts = { uploaded: 0, failed: 0 };
		// The pass's signal may live as long as the process: it is handed to no `AbortSignal.any` (abort-scope.ts).
		await withAbortScope(signal, async (scoped) => {
			let due: Due[];
			try {
				due = await this.#due(scoped);
			} catch (error) {
				if (!scoped.aborted) this.#report({ event: "code-site-error", step: "due", error });
				return;
			}
			if (due.length) this.#report({ event: "code-site", step: "due", sites: due.length });
			for (const site of due) {
				if (scoped.aborted) return;
				const ended = await this.#site(site, scoped);
				if (ended) counts[ended] += 1;
			}
		});
		return counts;
	}

	async #due(signal: AbortSignal): Promise<Due[]> {
		const answer = await this.#call(
			"qorpera_code_sites_due",
			{ p_owner: this.#owner, p_machine_id_sha256: this.#machineIdSha256, p_limit: this.#limit },
			signal,
		);
		if (!isRecord(answer) || answer.schema !== "qorpera.code-sites-due/v1" || !Array.isArray(answer.sites))
			throw new Error("CODE_SITE_DUE_UNCONFIRMED");
		const due: Due[] = [];
		for (const entry of answer.sites.slice(0, this.#limit)) {
			const { companyId, environmentId, owner, name, change, site } = isRecord(entry) ? entry : {};
			let target: CodeSiteTarget;
			try {
				if (!isUuid(companyId) || !isUuid(environmentId) || !whole(change, 1)) throw new Error("not a site");
				const repository = parseCloudCodingRepository({ host: "qorpera", owner, name, baseBranch: "main" });
				target = { companyId, environmentId, owner: repository.owner, name: repository.name };
			} catch {
				// One entry that names no repository kept here does not hold up the others.
				this.#report({ event: "code-site-error", step: "due", error: new Error("CODE_SITE_DUE_UNCONFIRMED") });
				continue;
			}
			const read = parseNativeCodeSiteSpec(site);
			due.push({ target, change, site: read });
		}
		return due;
	}

	/** One site: its tree read in a job that yields, then uploaded. */
	async #site(due: Due, signal: AbortSignal): Promise<"uploaded" | "failed" | undefined> {
		const site = due.site;
		// A row whose site the pass cannot read is told as a call that did not answer: the kernel waits before it names
		// the site again, and gives the change up after five.
		if (!site) return await this.#failed(due, "due", UPLOAD_FAILED, new Error("CODE_SITE_DUE_UNCONFIRMED"), signal);
		const started = performance.now();
		const repository: CloudCodingRepository = parseCloudCodingRepository({
			host: "qorpera",
			owner: due.target.owner,
			name: due.target.name,
			baseBranch: "main",
		});
		if (this.#nativeEdge || site.schema === "qorpera.code-site/v2") {
			return await this.#siteNative(due, site, repository, started, signal);
		}
		let tree: { files: CodeSiteUploadFile[]; bytes: number; manifestSha256: string };
		try {
			tree = treeOf(
				await this.#hosts.run(
					due.target.companyId,
					due.target.environmentId,
					signal,
					(job) => this.#read(job, { repository, tree: site.tree }),
					{ yields: true },
				),
			);
		} catch (error) {
			// A turn's job joined the line, or the pass was stopped: nothing failed, and the site stays due.
			if (signal.aborted || (error instanceof CodeHostJobFailure && error.code === YIELDED)) return undefined;
			const code = codeChangeErrorCode(error);
			return await this.#failed(due, "read", code === "UNCLASSIFIED" ? READ_FAILED : code, error, signal);
		}
		const { files, bytes } = tree;
		this.#report({
			event: "code-site",
			step: "read",
			...named(due),
			files: files.length,
			bytes,
			ms: Math.round(performance.now() - started),
		});
		const key = `${due.target.environmentId}/${due.target.owner}/${due.target.name}/${due.change}`;
		try {
			const uploaded = await this.#upload(due, tree, signal);
			this.#busy.delete(key);
			this.#report({
				event: "code-site",
				step: "uploaded",
				...named(due),
				...uploaded,
				files: files.length,
				bytes,
				ms: Math.round(performance.now() - started),
			});
			return "uploaded";
		} catch (error) {
			if (signal.aborted) return undefined;
			if (error instanceof SiteLost) {
				this.#report({ event: "code-site-error", step: error.step, ...named(due), error });
				return "failed";
			}
			const stopped = error instanceof SiteStopped ? error : new SiteStopped("upload", UPLOAD_FAILED, error);
			// Qorpera took the site down: a plain stop, told to no one (the header says why).
			if (stopped.code === TAKEN_DOWN) {
				this.#busy.delete(key);
				this.#report({ event: "code-site", step: "taken-down", ...named(due), at: stopped.step });
				return undefined;
			}
			if (stopped.cause instanceof CodingControlBusy) {
				const passes = (this.#busy.get(key) ?? 0) + 1;
				if (passes < BUSY_PASSES) {
					// Nothing was written and nothing failed: the site stays due, and the next pass goes on where this one stopped.
					if (this.#busy.size >= 200) this.#busy.clear();
					this.#busy.set(key, passes);
					this.#report({ event: "code-site", step: "busy", ...named(due), at: stopped.step, passes });
					return undefined;
				}
			}
			this.#busy.delete(key);
			return await this.#failed(due, stopped.step, stopped.code, stopped.cause, signal, stopped.path);
		}
	}

	async #siteNative(
		due: Due,
		site: NativeCodeSiteSpec,
		repository: CloudCodingRepository,
		started: number,
		signal: AbortSignal,
	): Promise<"uploaded" | "failed" | undefined> {
		const edge = this.#nativeEdge;
		if (!edge) {
			return await this.#failed(
				due,
				"upload",
				"NATIVE_WEB_HOSTING_UNCONFIGURED",
				new Error("NATIVE_WEB_HOSTING_UNCONFIGURED"),
				signal,
			);
		}
		let files: CodeSiteUploadFile[] = [];
		let totalBytes = 0;
		if (site.kind === "static" || (site.kind === "hybrid" && site.files > 0)) {
			try {
				const read = treeOf(
					await this.#hosts.run(
						due.target.companyId,
						due.target.environmentId,
						signal,
						(job) => this.#read(job, { repository, tree: site.tree }),
						{ yields: true },
					),
				);
				files = read.files;
				totalBytes = read.bytes;
			} catch (error) {
				if (signal.aborted || (error instanceof CodeHostJobFailure && error.code === YIELDED)) return undefined;
				const code = codeChangeErrorCode(error);
				return await this.#failed(due, "read", code === "UNCLASSIFIED" ? READ_FAILED : code, error, signal);
			}
		}
		let exportedSource: { sourceDir: string; cleanup?: () => Promise<void> } | undefined;
		if ((site.kind === "server" || site.kind === "hybrid") && this.#exportSource) {
			const exportFn = this.#exportSource;
			try {
				exportedSource = await this.#hosts.run(
					due.target.companyId,
					due.target.environmentId,
					signal,
					(job) => exportFn(job, { repository, tree: site.tree }),
					{ yields: true },
				);
			} catch (error) {
				if (signal.aborted || (error instanceof CodeHostJobFailure && error.code === YIELDED)) return undefined;
				const code = codeChangeErrorCode(error);
				return await this.#failed(due, "export", code === "UNCLASSIFIED" ? READ_FAILED : code, error, signal);
			}
		}
		const key = `${due.target.environmentId}/${due.target.owner}/${due.target.name}/${due.change}`;
		try {
			const registered = await deployCodeSiteToNativeEdge({
				control: this.#control,
				owner: this.#owner,
				machineIdSha256: this.#machineIdSha256,
				target: due.target,
				change: due.change,
				spec: site,
				files,
				...(exportedSource ? { sourceDir: exportedSource.sourceDir } : {}),
				edge,
				signal,
			});
			this.#busy.delete(key);
			this.#report({
				event: "code-site",
				step: "uploaded",
				...named(due),
				state: registered.state,
				versionId: registered.versionId,
				deploymentId: registered.deploymentId,
				slug: registered.slug,
				kind: registered.kind,
				files: files.length,
				bytes: totalBytes,
				uploadedBlobs: registered.uploadedBlobs,
				deduplicatedBlobs: registered.deduplicatedBlobs,
				ms: Math.round(performance.now() - started),
			});
			return "uploaded";
		} catch (error) {
			if (signal.aborted) return undefined;
			const msg = error instanceof Error ? error.message : "";
			if (msg === "CODE_SITE_LOST") {
				this.#report({ event: "code-site-error", step: "upload", ...named(due), error });
				return "failed";
			}
			if (msg === TAKEN_DOWN) {
				this.#busy.delete(key);
				this.#report({ event: "code-site", step: "taken-down", ...named(due), at: "native-register" });
				return undefined;
			}
			if (error instanceof CodingControlBusy) {
				const passes = (this.#busy.get(key) ?? 0) + 1;
				if (passes < BUSY_PASSES) {
					if (this.#busy.size >= 200) this.#busy.clear();
					this.#busy.set(key, passes);
					this.#report({ event: "code-site", step: "busy", ...named(due), at: "native-register", passes });
					return undefined;
				}
			}
			this.#busy.delete(key);
			const problemCode = PROBLEM.test(msg) ? msg : UPLOAD_FAILED;
			return await this.#failed(due, "upload", problemCode, error, signal);
		} finally {
			if (exportedSource?.cleanup) {
				await exportedSource.cleanup().catch(() => undefined);
			}
		}
	}

	/** Begin, list, missing, put and finish, for one read tree. Throws `SiteStopped` or `SiteLost`. */
	async #upload(
		due: Due,
		tree: { files: readonly CodeSiteUploadFile[]; bytes: number; manifestSha256: string },
		signal: AbortSignal,
	): Promise<{ state: Done; versionId: string; slug: string; sent: number; calls: number }> {
		let calls = 0;
		const ask = async (step: string, args: Record<string, unknown>, callSignal: AbortSignal = signal) => {
			calls += 1;
			return await this.#ask(step, args, callSignal);
		};
		const begun = await ask("begin", {
			...this.#which(due),
			p_change: due.change,
			p_manifest: { manifestSha256: tree.manifestSha256, files: tree.files.length, bytes: tree.bytes },
		});
		const { state, versionId, slug, listed } = begun;
		if (
			!isUuid(versionId) ||
			typeof slug !== "string" ||
			!(state === "uploading" ? typeof listed === "boolean" : STATES.includes(state as Done))
		)
			throw unread("begin");
		// The tree's version is complete already (an earlier pass finished it, or a member put it live): nothing to send.
		if (state !== "uploading") return { state: state as Done, versionId, slug, sent: 0, calls };
		const version = { p_owner: this.#owner, p_machine_id_sha256: this.#machineIdSha256, p_version_id: versionId };
		// An upload that stopped after its listing goes on from the bytes.
		const left = listed ? undefined : await this.#list(version, tree.files, ask);
		const missing = left === 0 ? [] : await this.#missing(version, tree.files, ask);
		const sent = await this.#put(version, missing, ask, signal);
		const finished = await ask("finish", version);
		if (!STATES.includes(finished.state as Done)) throw unread("finish");
		return { state: finished.state as Done, versionId, slug, sent, calls };
	}

	/** The files, in pages of at most 150 and 100 KiB of JSON, the last one marked. Answers how many have no bytes. A
	 * version the kernel has listed already answers `listed` to any page: the listing ends there. */
	async #list(
		version: Record<string, unknown>,
		files: readonly CodeSiteUploadFile[],
		ask: (step: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
	): Promise<number> {
		const envelope = jsonBytes({ ...version, p_files: { files: [], last: false } });
		const pages: { path: string; bytes: number; sha256: string }[][] = [[]];
		let used = envelope;
		for (const file of files) {
			const entry = { path: file.path, bytes: file.bytes, sha256: file.sha256 };
			const size = jsonBytes(entry) + 1;
			const page = pages.at(-1) as (typeof pages)[number];
			if (page.length && (page.length >= CODE_SITE_LIST_FILES || used + size > CODE_SITE_LIST_BYTES)) {
				pages.push([]);
				used = envelope;
			}
			(pages.at(-1) as (typeof pages)[number]).push(entry);
			used += size;
		}
		for (const [at, page] of pages.entries()) {
			const last = at === pages.length - 1;
			const answer = await ask("list", { ...version, p_files: { files: page, last } });
			if (answer.state === "listed" && whole(answer.missing)) return answer.missing;
			if (!last && answer.state === "listing") continue;
			throw unread("list");
		}
		throw unread("list");
	}

	/** The files the kernel has no bytes of, asked a page at a time in C order: each one of the read tree's, at its size,
	 * every page after the one before, and no more pages than the tree's files fill (and one that finds nothing more). */
	async #missing(
		version: Record<string, unknown>,
		files: readonly CodeSiteUploadFile[],
		ask: (step: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
	): Promise<CodeSiteUploadFile[]> {
		const byPath = new Map(files.map((file) => [file.path, file]));
		const found: CodeSiteUploadFile[] = [];
		let after: string | null = null;
		for (let page = 0; page <= Math.ceil(files.length / CODE_SITE_MISSING_PATHS); page++) {
			const answer = await ask("missing", { ...version, p_after: after, p_limit: CODE_SITE_MISSING_PATHS });
			const { missing, more } = answer;
			if (!Array.isArray(missing) || missing.length > CODE_SITE_MISSING_PATHS || typeof more !== "boolean")
				throw unread("missing");
			for (const entry of missing) {
				const file = isRecord(entry) && typeof entry.path === "string" ? byPath.get(entry.path) : undefined;
				if (
					!file ||
					!isRecord(entry) ||
					entry.bytes !== file.bytes ||
					(after !== null && cOrder(file.path, after) <= 0)
				)
					throw unread("missing");
				found.push(file);
				after = file.path;
			}
			if (!more) return found;
			// A page that says there is more and names nothing would be asked again for ever.
			if (!missing.length) throw unread("missing");
		}
		throw unread("missing");
	}

	/** The files' bytes as parts of at most 88 KiB, in C order: parts share a call while together they are at most 88 KiB,
	 * 500 parts and a request of 120 KiB. A file's parts are cut at fixed places, so an upload that stopped half way
	 * sends the same parts again. Answers the bytes sent, before base64. */
	// WHY: qorpera_code_site_put locks site FOR SHARE then version FOR UPDATE and reassembles parts ORDER BY part, so concurrent batches overlap WAN RTT without deadlocks or part races.
	async #put(
		version: Record<string, unknown>,
		files: readonly CodeSiteUploadFile[],
		ask: (step: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<number> {
		const batches = planPutBatches(version, files);
		if (!batches.length) {
			signal.throwIfAborted();
			return 0;
		}
		const batchAbort = new AbortController();
		const forward = (): void => batchAbort.abort(signal.reason);
		if (signal.aborted) forward();
		else signal.addEventListener("abort", forward, { once: true });
		let next = 0;
		let sent = 0;
		let failed = false;
		let firstError: unknown;
		const worker = async (): Promise<void> => {
			while (!failed && !batchAbort.signal.aborted) {
				const index = next++;
				const batch = batches[index];
				if (!batch) return;
				const parts = batch.parts.map(({ file, part, of, start, end }) => {
					const piece = file.content.subarray(start, end);
					return {
						path: file.path,
						part,
						of,
						contentBase64: Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString("base64"),
					};
				});
				try {
					const answer = await ask("put", { ...version, p_parts: { parts } }, batchAbort.signal);
					if (answer.state !== "kept" || !whole(answer.filed)) throw unread("put");
					sent += batch.bytes;
				} catch (error) {
					if (!failed) {
						failed = true;
						firstError = error;
						batchAbort.abort(error);
					}
					return;
				}
			}
		};
		try {
			const workers = Math.min(this.#putConcurrency, batches.length);
			await Promise.all(Array.from({ length: workers }, () => worker()));
		} finally {
			signal.removeEventListener("abort", forward);
		}
		if (failed) throw firstError;
		signal.throwIfAborted();
		return sent;
	}

	/** One call of an upload: its answer, of its schema. A refusal stops the site with the kernel's code; an answer that
	 * did not come, or one of another shape, with SITE_UPLOAD_FAILED. */
	async #ask(step: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
		let answer: unknown;
		try {
			answer = await this.#call(`qorpera_code_site_${step}` as (typeof CODE_SITE_RPCS)[number], args, signal);
		} catch (error) {
			throw new SiteStopped(step, UPLOAD_FAILED, error);
		}
		if (!isRecord(answer) || answer.schema !== `qorpera.code-site-${step}/v1`) throw unread(step);
		if (answer.state === "lost") throw new SiteLost(step);
		if (answer.state === "refused") {
			const path = typeof answer.path === "string" ? answer.path : null;
			if (typeof answer.code === "string" && PROBLEM.test(answer.code))
				throw new SiteStopped(step, answer.code, undefined, path);
			throw unread(step);
		}
		return answer;
	}

	/** Reports what stopped a site and tells the kernel, which counts it and waits longer before it names the site
	 * again. An answer that does not come is reported; the site is failed either way. */
	async #failed(
		due: Due,
		step: string,
		code: string,
		error: unknown,
		signal: AbortSignal,
		path: string | null = null,
	): Promise<"failed"> {
		this.#report({
			event: "code-site-error",
			step,
			...named(due),
			problem: code,
			...(path === null ? {} : { path }),
			...(error === undefined ? {} : { error }),
		});
		try {
			const answer = await this.#call(
				"qorpera_code_site_failed",
				{ ...this.#which(due), p_change: due.change, p_code: code },
				signal,
			);
			if (!isRecord(answer) || answer.schema !== "qorpera.code-site-failed/v1" || answer.state !== "recorded")
				throw new Error(
					isRecord(answer) && answer.state === "lost" ? "CODE_SITE_FAILED_LOST" : "CODE_SITE_FAILED_UNCONFIRMED",
				);
		} catch (failure) {
			if (!signal.aborted)
				this.#report({ event: "code-site-error", step: "failed", ...named(due), problem: code, error: failure });
		}
		return "failed";
	}

	#which(due: Due): Record<string, unknown> {
		return {
			p_owner: this.#owner,
			p_machine_id_sha256: this.#machineIdSha256,
			p_environment_id: due.target.environmentId,
			p_repository_owner: due.target.owner,
			p_name: due.target.name,
		};
	}

	#call(method: (typeof CODE_SITE_RPCS)[number], args: Record<string, unknown>, signal: AbortSignal) {
		return this.#control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]));
	}
}

/** The read tree's files in C order with their bytes together, or CODE_HOST_SITE_READ_FAILED when the read answered
 * something else: each file's content is the size it says, since the parts are cut from it. */
function treeOf(value: { files: readonly CodeSiteUploadFile[]; manifestSha256: string }): {
	files: CodeSiteUploadFile[];
	bytes: number;
	manifestSha256: string;
} {
	if (
		!isRecord(value) ||
		!Array.isArray(value.files) ||
		typeof value.manifestSha256 !== "string" ||
		!SHA256.test(value.manifestSha256) ||
		!value.files.every(
			(file: unknown) =>
				isRecord(file) &&
				typeof file.path === "string" &&
				whole(file.bytes) &&
				typeof file.sha256 === "string" &&
				SHA256.test(file.sha256) &&
				file.content instanceof Uint8Array &&
				file.content.byteLength === file.bytes,
		)
	)
		throw new Error(READ_FAILED);
	const files = [...value.files].sort((a, b) => cOrder(a.path, b.path));
	return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), manifestSha256: value.manifestSha256 };
}

/** An answer the pass cannot read: as a call that did not answer. */
function unread(step: string): SiteStopped {
	return new SiteStopped(step, UPLOAD_FAILED, new Error("CODE_SITE_ANSWER_UNCONFIRMED"));
}

function named(due: Due): Record<string, unknown> {
	return {
		companyId: due.target.companyId,
		environmentId: due.target.environmentId,
		repository: `${due.target.owner}/${due.target.name}`,
		change: due.change,
	};
}

interface PutPartSpec {
	readonly file: CodeSiteUploadFile;
	readonly part: number;
	readonly of: number;
	readonly start: number;
	readonly end: number;
}

interface PutBatch {
	readonly parts: readonly PutPartSpec[];
	readonly bytes: number;
}

function planPutBatches(version: Record<string, unknown>, files: readonly CodeSiteUploadFile[]): PutBatch[] {
	const envelope = jsonBytes({ ...version, p_parts: { parts: [] } });
	const batches: PutBatch[] = [];
	let parts: PutPartSpec[] = [];
	let carried = 0;
	let used = envelope;
	for (const file of files) {
		const of = Math.max(1, Math.ceil(file.bytes / CODE_SITE_PART_BYTES));
		for (let part = 0; part < of; part++) {
			const start = part * CODE_SITE_PART_BYTES;
			const end = Math.min(file.bytes, start + CODE_SITE_PART_BYTES);
			const length = end - start;
			const size = jsonBytes({ path: file.path, part, of, contentBase64: "" }) + Math.ceil(length / 3) * 4 + 1;
			if (
				parts.length &&
				(parts.length >= CODE_SITE_PUT_PARTS ||
					carried + length > CODE_SITE_PART_BYTES ||
					used + size > CODE_SITE_REQUEST_BYTES)
			) {
				batches.push({ parts, bytes: carried });
				parts = [];
				carried = 0;
				used = envelope;
			}
			if (used + size > CODE_SITE_REQUEST_BYTES)
				throw new SiteStopped("put", UPLOAD_FAILED, new Error("CODE_SITE_PART_TOO_LARGE"), file.path);
			parts.push({ file, part, of, start, end });
			carried += length;
			used += size;
		}
	}
	if (parts.length) batches.push({ parts, bytes: carried });
	return batches;
}
