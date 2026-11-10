import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, realpath, rm, statfs, unlink } from "node:fs/promises";
import { posix } from "node:path";
import { isUuid, parseCloudCodingRepository, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { code, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

/** Where nightly care copies out the repositories kept in Qorpera (own code storage, step 2; `code-host-care.ts`): one
 * git bundle of every ref per repository and night its refs changed, on the coding executor's own storage, outside the
 * company folder.
 *
 *   code-bundles/<companyId>/<owner>/<name>/
 *     20261111T021455Z-<main, 12 hex>.bundle   0600, never overwritten
 *     20261111T021455Z-<main, 12 hex>.json     0600, its manifest (`qorpera.code-bundle/v1`)
 *
 * A bundle is written to a temporary file beside its place, and gets its name only once its bytes are the ones the
 * code host hashed: fsync, a no-overwrite link, then the manifest's link, which is what makes it a stored bundle, and
 * an fsync of the folder (as `publish`, lxd-office-journal-files.ts). What a write that died left (a temporary file, or
 * a bundle without its manifest) goes at the repository's next `begin`. Restore, anywhere with git: check the file's
 * SHA-256 against the manifest, `git bundle verify`, `git clone --mirror <file> <name>.git`. */

export const CODE_BUNDLE_SCHEMA = "qorpera.code-bundle/v1";
/** The store's folder in the executor's `control/` folder on its storage. */
export const CODE_BUNDLE_FOLDER = "code-bundles";
/** How many of a repository's stored bundles stay. */
export const CODE_BUNDLES_KEPT = 7;
/** The largest bundle a writer takes, unless its caller says otherwise: the code host job's own default. */
export const CODE_BUNDLE_MAXIMUM_BYTES = 2 * 1024 ** 3;
/** A manifest lists at most this many refs; `refsCount` is how many there were. */
export const CODE_BUNDLE_MANIFEST_REFS = 2000;

/** A bundle's name, without `.bundle` or `.json` (`codeBundleName`). */
export const CODE_BUNDLE_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/;
const TEMPORARY = /^\.write-[0-9a-f-]{36}$/;
const SHA = /^[0-9a-f]{40}$/;
const FIXED = /^[A-Z][A-Z0-9_]{2,80}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 ** 2;
const READ_BYTES = 1024 ** 2;

/** One repository kept in Qorpera, of one company. */
export interface CodeBundleTarget {
	companyId: string;
	owner: string;
	name: string;
}

export interface CodeBundleRef {
	name: string;
	sha: string;
}

/** What the caller knows of the bundle it hands in: where and when it was made, and what the code host said of it. */
export interface CodeBundleFacts {
	environmentId: string;
	/** When the bundle was made, as ISO text in UTC; its name starts with it. */
	createdAt: string;
	gitVersion: string;
	mainSha: string;
	/** The refs' fingerprint (`codeRefsSha256`), and the refs. */
	refsSha256: string;
	refs: readonly CodeBundleRef[];
	/** The bundle file's SHA-256 and size as the code host measured them. */
	sha256: string;
	bytes: number;
	executorOwner: string;
}

export interface CodeBundleManifest {
	schema: typeof CODE_BUNDLE_SCHEMA;
	companyId: string;
	environmentId: string;
	repository: { host: "qorpera"; owner: string; name: string; baseBranch: string };
	createdAt: string;
	gitVersion: string;
	mainSha: string;
	refsSha256: string;
	/** The first `CODE_BUNDLE_MANIFEST_REFS` refs by name, of `refsCount`. */
	refs: CodeBundleRef[];
	refsCount: number;
	sha256: string;
	bytes: number;
	/** The bundle restored in the code host before it left (the job's proof), and the bytes stored are the bytes it
	 * hashed there. */
	verified: true;
	executorOwner: string;
}

export interface CodeBundleWriter {
	/** The bundle's next piece. A piece that fails, or whose caller stops waiting, ends the writer: only `abort` is left. */
	write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>;
	/** Stores what was written as `<name>.bundle` with its manifest, only when its SHA-256 and size are the facts' own
	 * (`CODE_BUNDLE_DIFFERS` otherwise) and no bundle has the name (`CODE_BUNDLE_EXISTS`). The temporary file goes either
	 * way. */
	commit(name: string, facts: CodeBundleFacts, signal?: AbortSignal): Promise<CodeBundleManifest>;
	/** Removes the temporary file. Nothing after a commit. */
	abort(): Promise<void>;
}

export interface CodeBundleStore {
	/** A writer for the repository's next bundle. First the storage is checked mounted, what a dead write left in the
	 * repository's folder is removed, and twice `expectedBytes` must be free (`CODE_BUNDLE_NO_SPACE`). */
	begin(
		target: CodeBundleTarget,
		options?: { expectedBytes?: number; maximumBytes?: number },
		signal?: AbortSignal,
	): Promise<CodeBundleWriter>;
	/** The stored bundle's manifest, when the bundle and its manifest are both there and the file has the manifest's
	 * size; null otherwise. Reads no bundle. */
	find(target: CodeBundleTarget, name: string, signal?: AbortSignal): Promise<CodeBundleManifest | null>;
	/** As `find`, and the file is read whole: null unless its SHA-256 is the manifest's. */
	verify(target: CodeBundleTarget, name: string, signal?: AbortSignal): Promise<CodeBundleManifest | null>;
	/** Removes the repository's stored bundles beyond the newest `keep`, and answers their names. Only right after a
	 * commit to the repository through this store (`CODE_BUNDLE_PRUNE_NOT_NOW` otherwise), whose bundle always stays. */
	prune(target: CodeBundleTarget, keep: number, signal?: AbortSignal): Promise<string[]>;
	/** The companies that have a folder in the store. */
	companies(signal?: AbortSignal): Promise<string[]>;
	/** Removes one company's folder, `<root>/<companyId>`, with all its bundles; false when it has none. */
	removeCompany(companyId: string, signal?: AbortSignal): Promise<boolean>;
}

export interface CodeBundleStoreOptions {
	/** `<the executor's control folder>/code-bundles`: made, mode 0700, when it is missing (its parent must exist). */
	root: string;
	/** Checks that the executor's storage is mounted (`assertControl` of a `createCodingNasStorage` of the store's own:
	 * a storage object runs one check at a time). Run before every use, and again before a bundle gets its name. */
	assert?: (signal: AbortSignal) => Promise<void>;
	/** How long one piece's write, a `begin`, a `find`, an `abort` or a listing may take, the wait for the store's
	 * earlier use included. Default 2 minutes. */
	stepMs?: number;
	/** The same for a commit (it syncs the whole bundle), a `verify`, a `prune` and a company's removal. Default 15
	 * minutes. */
	slowMs?: number;
}

/** A bundle's name: when it was made, in UTC to the second, and the start of main's commit. Names sort by time. */
export function codeBundleName(createdAt: string, mainSha: string): string {
	const time = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
	if (!Number.isFinite(time) || new Date(time).toISOString() !== createdAt || !SHA.test(mainSha))
		throw new Error("INVALID_CODE_BUNDLE");
	return `${createdAt.slice(0, 19).replace(/[-:]/g, "")}Z-${mainSha.slice(0, 12)}`;
}

function targetOf(value: CodeBundleTarget): CodeBundleTarget {
	const { companyId, owner, name } = value ?? {};
	if (!isUuid(companyId)) throw new Error("INVALID_CODE_BUNDLE");
	try {
		// Lower case, and safe as a folder's name: the repository's own rule.
		parseCloudCodingRepository({ host: "qorpera", owner, name, baseBranch: "main" });
	} catch {
		throw new Error("INVALID_CODE_BUNDLE");
	}
	return { companyId, owner, name };
}

function nameOf(value: string): string {
	if (typeof value !== "string" || !CODE_BUNDLE_NAME.test(value)) throw new Error("INVALID_CODE_BUNDLE");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored manifest, when it is whole and the named bundle's of this repository. */
function manifestOf(value: unknown, target: CodeBundleTarget, name: string): CodeBundleManifest | null {
	if (!isRecord(value) || !isRecord(value.repository)) return null;
	const { repository, refs } = value;
	const valid =
		value.schema === CODE_BUNDLE_SCHEMA &&
		value.verified === true &&
		value.companyId === target.companyId &&
		repository.host === "qorpera" &&
		repository.owner === target.owner &&
		repository.name === target.name &&
		isUuid(value.environmentId) &&
		typeof value.mainSha === "string" &&
		typeof value.createdAt === "string" &&
		CODE_BUNDLE_NAME.test(name) &&
		name.endsWith(`-${value.mainSha.slice(0, 12)}`) &&
		typeof value.sha256 === "string" &&
		SHA256_HEX_PATTERN.test(value.sha256) &&
		typeof value.refsSha256 === "string" &&
		SHA256_HEX_PATTERN.test(value.refsSha256) &&
		Number.isSafeInteger(value.bytes) &&
		(value.bytes as number) >= 1 &&
		Array.isArray(refs);
	return valid ? (value as unknown as CodeBundleManifest) : null;
}

/** The work, or the signal's reason once it stops first; the work goes on. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function missing<T>(work: Promise<T>): Promise<T | undefined> {
	try {
		return await work;
	} catch (error) {
		if (code(error, "ENOENT")) return undefined;
		throw error;
	}
}

export function createCodeBundleStore(options: CodeBundleStoreOptions): CodeBundleStore {
	const root = options?.root;
	const stepMs = options.stepMs ?? 120_000,
		slowMs = options.slowMs ?? 900_000;
	if (
		typeof root !== "string" ||
		!posix.isAbsolute(root) ||
		posix.normalize(root) !== root ||
		root.endsWith("/") ||
		posix.basename(root) !== CODE_BUNDLE_FOLDER ||
		posix.dirname(root) === "/" ||
		![stepMs, slowMs].every((ms) => Number.isSafeInteger(ms) && ms >= 1 && ms <= 86_400_000)
	)
		throw new Error("INVALID_CODE_BUNDLE_STORE");
	const assert = options.assert ?? (async () => undefined);
	/** The last use of the store, settled: the next waits for it, even once its caller gave up, so IO that a hard NFS
	 * mount hangs never overlaps. */
	let last: Promise<unknown> = Promise.resolve();
	/** The temporary files of the writers that are open, which no sweep takes. */
	const writing = new Set<string>();
	/** The repositories with a commit since their last prune, by the name it stored. */
	const committed = new Map<string, string>();
	const keyOf = (target: CodeBundleTarget) => `${target.companyId}/${target.owner}/${target.name}`;

	/** One use of the store, after the last one ended and within `ms`. It rejects with its caller's reason, with
	 * `CODE_BUNDLE_STORE_TIMEOUT` past `ms`, with the fixed code the store or the storage's check gave, or with
	 * `CODE_BUNDLE_STORE_FAILED` for anything else (the cause kept). */
	async function use<T>(
		ms: number,
		signal: AbortSignal | undefined,
		work: (checked: AbortSignal) => Promise<T>,
	): Promise<T> {
		const deadline = AbortSignal.timeout(ms);
		const checked = signal ? AbortSignal.any([signal, deadline]) : deadline;
		const running = last.then(async () => {
			checked.throwIfAborted();
			return await work(checked);
		});
		last = running.catch(() => undefined);
		try {
			return await abortable(running, checked);
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			if (deadline.aborted) throw new Error("CODE_BUNDLE_STORE_TIMEOUT");
			if (error instanceof Error && FIXED.test(error.message)) throw error;
			throw new Error("CODE_BUNDLE_STORE_FAILED", { cause: error });
		}
	}

	/** A folder of the store: this process's own, mode 0700, and reached by no link. */
	async function checkFolder(path: string): Promise<void> {
		const stat = await lstat(path);
		if (
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o7777) !== 0o700 ||
			(await realpath(path)) !== path
		)
			throw new Error("CODE_BUNDLE_STORE_UNSAFE");
	}

	/** The repository's folder, each folder on the way checked; made when `make`, else undefined when it is missing. */
	async function folderOf(target: CodeBundleTarget, make: boolean): Promise<string | undefined> {
		let path = root;
		for (const name of [undefined, target.companyId, target.owner, target.name]) {
			if (name !== undefined) path = posix.join(path, name);
			if (make) {
				const made = await mkdir(path, { mode: 0o700 }).then(
					() => true,
					(error: unknown) => {
						if (!code(error, "EEXIST")) throw error;
						return false;
					},
				);
				if (made) await syncDirectory(posix.dirname(path));
			} else if (!(await missing(lstat(path)))) return undefined;
			await checkFolder(path);
		}
		return path;
	}

	/** The named bundle's manifest, when both files are there, this process's own, and the bundle has the manifest's
	 * size. Anything else is no stored bundle. */
	async function stored(folder: string, target: CodeBundleTarget, name: string): Promise<CodeBundleManifest | null> {
		try {
			const record = await readRecord(posix.join(folder, `${name}.json`), MAX_MANIFEST_BYTES);
			const manifest = manifestOf(record.value, target, name);
			const file = await lstat(posix.join(folder, `${name}.bundle`));
			return manifest && file.isFile() && file.uid === process.getuid?.() && file.size === manifest.bytes
				? manifest
				: null;
		} catch {
			return null;
		}
	}

	function writer(
		target: CodeBundleTarget,
		folder: string,
		temporary: string,
		file: FileHandle,
		maximum: number,
	): CodeBundleWriter {
		const hash = createHash("sha256");
		let bytes = 0;
		let state: "open" | "failed" | "closed" = "open";
		/** The temporary files go, whatever became of them; the writer is over. */
		const close = async (others: readonly string[] = []) => {
			state = "closed";
			writing.delete(temporary);
			await file.close().catch(() => undefined);
			for (const path of [temporary, ...others]) await missing(unlink(path));
			await syncDirectory(folder);
		};
		return Object.freeze({
			async write(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
				if (!(chunk instanceof Uint8Array)) throw new Error("INVALID_CODE_BUNDLE");
				try {
					await use(stepMs, signal, async () => {
						if (state !== "open") throw new Error("CODE_BUNDLE_WRITER_CLOSED");
						if (bytes + chunk.length > maximum) throw new Error("CODE_BUNDLE_TOO_LARGE");
						for (let offset = 0; offset < chunk.length; ) {
							const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
							offset += bytesWritten;
						}
						hash.update(chunk);
						bytes += chunk.length;
					});
				} catch (error) {
					// A piece that may not have landed whole: nothing more is written, and nothing is stored.
					if (state === "open") state = "failed";
					throw error;
				}
			},

			commit(name: string, facts: CodeBundleFacts, signal?: AbortSignal): Promise<CodeBundleManifest> {
				return use(slowMs, signal, async (checked) => {
					if (state !== "open") throw new Error("CODE_BUNDLE_WRITER_CLOSED");
					const beside = posix.join(folder, `.write-${randomUUID()}`);
					try {
						const refs = Array.isArray(facts?.refs) ? facts.refs : undefined;
						if (
							!refs ||
							!refs.every(
								(ref) => isRecord(ref) && typeof ref.name === "string" && typeof ref.sha === "string",
							) ||
							nameOf(name) !== codeBundleName(facts.createdAt, facts.mainSha) ||
							!isUuid(facts.environmentId) ||
							typeof facts.gitVersion !== "string" ||
							facts.gitVersion.length > 200 ||
							typeof facts.executorOwner !== "string" ||
							facts.executorOwner.length > 200 ||
							typeof facts.refsSha256 !== "string" ||
							!SHA256_HEX_PATTERN.test(facts.refsSha256) ||
							typeof facts.sha256 !== "string" ||
							!SHA256_HEX_PATTERN.test(facts.sha256) ||
							!Number.isSafeInteger(facts.bytes) ||
							facts.bytes < 1
						)
							throw new Error("INVALID_CODE_BUNDLE");
						// The bytes that came are the bytes the code host hashed, all of them.
						if (hash.digest("hex") !== facts.sha256 || bytes !== facts.bytes)
							throw new Error("CODE_BUNDLE_DIFFERS");
						await file.sync();
						if ((await file.stat()).size !== bytes) throw new Error("CODE_BUNDLE_DIFFERS");
						const manifest: CodeBundleManifest = {
							schema: CODE_BUNDLE_SCHEMA,
							companyId: target.companyId,
							environmentId: facts.environmentId,
							repository: { host: "qorpera", owner: target.owner, name: target.name, baseBranch: "main" },
							createdAt: facts.createdAt,
							gitVersion: facts.gitVersion,
							mainSha: facts.mainSha,
							refsSha256: facts.refsSha256,
							refs: refs.slice(0, CODE_BUNDLE_MANIFEST_REFS).map((ref) => ({ name: ref.name, sha: ref.sha })),
							refsCount: refs.length,
							sha256: facts.sha256,
							bytes,
							verified: true,
							executorOwner: facts.executorOwner,
						};
						const text = Buffer.from(`${JSON.stringify(manifest)}\n`);
						if (text.length > MAX_MANIFEST_BYTES) throw new Error("INVALID_CODE_BUNDLE");
						const record = await open(
							beside,
							constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
							0o600,
						);
						try {
							await record.writeFile(text);
							await record.sync();
						} finally {
							await record.close();
						}
						checked.throwIfAborted();
						// Never onto the node's own disk under an unmounted share.
						await assert(checked);
						const bundle = posix.join(folder, `${name}.bundle`);
						const exists = (error: unknown) =>
							code(error, "EEXIST") ? new Error("CODE_BUNDLE_EXISTS", { cause: error }) : error;
						await link(temporary, bundle).catch((error: unknown) => {
							throw exists(error);
						});
						try {
							// The manifest's link makes it a stored bundle.
							await link(beside, posix.join(folder, `${name}.json`));
						} catch (error) {
							// The bundle's name was given by this commit a moment ago, and goes with it.
							await missing(unlink(bundle));
							throw exists(error);
						}
						committed.set(keyOf(target), name);
						return manifest;
					} finally {
						await close([beside]);
					}
				});
			},

			abort(): Promise<void> {
				return use(stepMs, undefined, async () => {
					if (state !== "closed") await close();
				});
			},
		});
	}

	return Object.freeze({
		async begin(
			target: CodeBundleTarget,
			writerOptions: { expectedBytes?: number; maximumBytes?: number } = {},
			signal?: AbortSignal,
		): Promise<CodeBundleWriter> {
			const repository = targetOf(target);
			const expected = writerOptions.expectedBytes ?? 0,
				maximum = writerOptions.maximumBytes ?? CODE_BUNDLE_MAXIMUM_BYTES;
			if (!Number.isSafeInteger(expected) || expected < 0 || !Number.isSafeInteger(maximum) || maximum < 1)
				throw new Error("INVALID_CODE_BUNDLE");
			return use(stepMs, signal, async (checked) => {
				await assert(checked);
				const folder = (await folderOf(repository, true)) as string;
				// A dead write's leftovers: its temporary files, and a bundle whose manifest never came (a commit gives both
				// names within one use of the store, so none is on its way now). The folder is this executor's alone.
				let swept = false;
				const names = new Set(await readdir(folder));
				for (const name of names) {
					const path = posix.join(folder, name);
					const dead =
						(TEMPORARY.test(name) && !writing.has(path)) ||
						(name.endsWith(".bundle") &&
							CODE_BUNDLE_NAME.test(name.slice(0, -".bundle".length)) &&
							!names.has(`${name.slice(0, -".bundle".length)}.json`));
					if (!dead) continue;
					checked.throwIfAborted();
					await unlink(path);
					swept = true;
				}
				if (swept) await syncDirectory(folder);
				const space = await statfs(folder, { bigint: true });
				if (space.bavail * space.bsize < 2n * BigInt(expected)) throw new Error("CODE_BUNDLE_NO_SPACE");
				const temporary = posix.join(folder, `.write-${randomUUID()}`);
				const file = await open(
					temporary,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
				writing.add(temporary);
				return writer(repository, folder, temporary, file, maximum);
			});
		},

		async find(target: CodeBundleTarget, name: string, signal?: AbortSignal): Promise<CodeBundleManifest | null> {
			const repository = targetOf(target),
				bundle = nameOf(name);
			return use(stepMs, signal, async (checked) => {
				await assert(checked);
				const folder = await folderOf(repository, false);
				return folder ? await stored(folder, repository, bundle) : null;
			});
		},

		async verify(target: CodeBundleTarget, name: string, signal?: AbortSignal): Promise<CodeBundleManifest | null> {
			const repository = targetOf(target),
				bundle = nameOf(name);
			return use(slowMs, signal, async (checked) => {
				await assert(checked);
				const folder = await folderOf(repository, false);
				const manifest = folder ? await stored(folder, repository, bundle) : null;
				if (!folder || !manifest) return null;
				const file = await open(
					posix.join(folder, `${bundle}.bundle`),
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const hash = createHash("sha256"),
						buffer = Buffer.alloc(READ_BYTES);
					let bytes = 0;
					for (;;) {
						checked.throwIfAborted();
						const { bytesRead } = await file.read(buffer, 0, buffer.length, bytes);
						if (bytesRead === 0) break;
						hash.update(buffer.subarray(0, bytesRead));
						bytes += bytesRead;
						if (bytes > manifest.bytes) return null;
					}
					return bytes === manifest.bytes && hash.digest("hex") === manifest.sha256 ? manifest : null;
				} finally {
					await file.close();
				}
			});
		},

		async prune(target: CodeBundleTarget, keep: number, signal?: AbortSignal): Promise<string[]> {
			const repository = targetOf(target);
			if (!Number.isSafeInteger(keep) || keep < 1 || keep > 1000) throw new Error("INVALID_CODE_BUNDLE");
			return use(slowMs, signal, async (checked) => {
				// Only a new stored bundle lets older ones go: the last good copy never does.
				const latest = committed.get(keyOf(repository));
				if (latest === undefined) throw new Error("CODE_BUNDLE_PRUNE_NOT_NOW");
				await assert(checked);
				const folder = await folderOf(repository, false);
				if (!folder) throw new Error("CODE_BUNDLE_PRUNE_NOT_NOW");
				const names = (await readdir(folder))
					.filter((name) => name.endsWith(".json") && CODE_BUNDLE_NAME.test(name.slice(0, -".json".length)))
					.map((name) => name.slice(0, -".json".length))
					.sort()
					.reverse();
				const whole: string[] = [];
				for (const name of names) {
					checked.throwIfAborted();
					if (await stored(folder, repository, name)) whole.push(name);
				}
				const kept = new Set([...whole.slice(0, keep), latest]);
				const removed: string[] = [];
				for (const name of whole) {
					if (kept.has(name)) continue;
					checked.throwIfAborted();
					// The manifest first: a bundle without one is no stored bundle, and goes at the next `begin`.
					await unlink(posix.join(folder, `${name}.json`));
					await unlink(posix.join(folder, `${name}.bundle`));
					removed.push(name);
				}
				if (removed.length) await syncDirectory(folder);
				committed.delete(keyOf(repository));
				return removed;
			});
		},

		companies(signal?: AbortSignal): Promise<string[]> {
			return use(stepMs, signal, async (checked) => {
				await assert(checked);
				if (!(await missing(lstat(root)))) return [];
				await checkFolder(root);
				return (await readdir(root)).filter((name) => isUuid(name)).sort();
			});
		},

		async removeCompany(companyId: string, signal?: AbortSignal): Promise<boolean> {
			if (!isUuid(companyId)) throw new Error("INVALID_CODE_BUNDLE");
			return use(slowMs, signal, async (checked) => {
				await assert(checked);
				if (!(await missing(lstat(root)))) return false;
				await checkFolder(root);
				// Exactly this company's folder in the store's root: named by its id, a real folder of this process's own, and
				// not a link to anywhere else.
				const path = posix.join(root, companyId);
				const stat = await missing(lstat(path));
				if (!stat) return false;
				if (
					posix.dirname(path) !== root ||
					posix.basename(path) !== companyId ||
					!stat.isDirectory() ||
					stat.uid !== process.getuid?.() ||
					(await realpath(path)) !== path
				)
					throw new Error("CODE_BUNDLE_STORE_UNSAFE");
				checked.throwIfAborted();
				await rm(path, { recursive: true });
				await syncDirectory(root);
				for (const key of committed.keys()) if (key.startsWith(`${companyId}/`)) committed.delete(key);
				return true;
			});
		},
	});
}
