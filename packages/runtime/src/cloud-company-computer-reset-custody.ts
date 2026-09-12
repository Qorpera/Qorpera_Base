import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES,
	COMPANY_COMPUTER_RESET_OUTBOX_MAX_BYTES,
	COMPANY_COMPUTER_RESET_OUTBOX_MAX_FILE_BYTES,
	COMPANY_COMPUTER_RESET_OUTBOX_MAX_RECORDS,
	type CompanyComputerResetCustodyBinding,
	type CompanyComputerResetOutboxManifest,
	parseCompanyComputerResetCustodyBinding,
	parseCompanyComputerResetOutboxManifest,
	parseCompanyComputerResetOutboxRestoreReceipt,
} from "@qorpera/contracts";
import { parseCompanyComputerScreenObservation } from "./cloud-company-computer-screen-lifecycle.ts";

export interface CompanyComputerResetCustodyGuard {
	/** The protected caller owns the kernel lock and proves whole-service/flush
	 * absence and sole-writer exclusion. This primitive cannot establish them. */
	assertStoppedAndExclusive(signal: AbortSignal): Promise<void>;
}
export interface CompanyComputerResetOutboxOptions {
	binding: CompanyComputerResetCustodyBinding;
	/** Provider-visible root being replaced/restored; archive must be outside it.
	 * This must name the whole affected root, not just its outbox directory. */
	guestRoot: string;
	/** Every model/workbench/profile mount must be supplied by trusted policy. */
	excludedRoots: readonly string[];
	guard: CompanyComputerResetCustodyGuard;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b, "en"))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mode === b.mode &&
		a.uid === b.uid &&
		a.gid === b.gid &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}
class Directory {
	readonly path: string;
	readonly handle: FileHandle;
	readonly identity: BigIntStats;
	readonly anchor: string;
	private constructor(path: string, handle: FileHandle, identity: BigIntStats) {
		this.path = path;
		this.handle = handle;
		this.identity = identity;
		this.anchor = `/proc/self/fd/${handle.fd}`;
	}
	static async acquire(path: string, uid: number, gid: number): Promise<Directory> {
		if (process.platform !== "linux" || resolve(path) !== path || path === sep || path.includes("\0"))
			throw new Error("RESET_CUSTODY_PATH_UNSAFE");
		const handle = await open(
			path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const stat = await handle.stat({ bigint: true });
			if (
				!stat.isDirectory() ||
				stat.uid !== BigInt(uid) ||
				stat.gid !== BigInt(gid) ||
				(stat.mode & 0o7777n) !== 0o700n
			)
				throw new Error("RESET_CUSTODY_DIRECTORY_UNSAFE");
			const dir = new Directory(path, handle, stat);
			await dir.check();
			return dir;
		} catch (error) {
			await handle.close();
			throw error;
		}
	}
	async check(): Promise<void> {
		const path = await lstat(this.path, { bigint: true }),
			fd = await this.handle.stat({ bigint: true });
		for (const current of [path, fd])
			if (
				!current.isDirectory() ||
				current.dev !== this.identity.dev ||
				current.ino !== this.identity.ino ||
				current.uid !== this.identity.uid ||
				current.gid !== this.identity.gid ||
				current.mode !== this.identity.mode
			)
				throw new Error("RESET_CUSTODY_DIRECTORY_CHANGED");
		if ((await realpath(this.path)) !== this.path || (await realpath(this.anchor)) !== this.path)
			throw new Error("RESET_CUSTODY_DIRECTORY_CHANGED");
	}
	async names(): Promise<string[]> {
		await this.check();
		const names = (await readdir(this.anchor)).sort();
		await this.check();
		return names;
	}
	async read(name: string, limit: number): Promise<{ bytes: Buffer; stat: BigIntStats }> {
		await this.check();
		const file = await open(
			join(this.anchor, name),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const before = await file.stat({ bigint: true });
			if (
				!before.isFile() ||
				before.dev !== this.identity.dev ||
				before.uid !== this.identity.uid ||
				before.gid !== this.identity.gid ||
				before.nlink !== 1n ||
				(before.mode & 0o7777n) !== 0o600n ||
				before.size < 1n ||
				before.size > BigInt(limit)
			)
				throw new Error("RESET_CUSTODY_FILE_UNSAFE");
			const bytes = Buffer.alloc(Number(before.size) + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await file.read(bytes, length, bytes.length - length, length);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			if (
				length !== Number(before.size) ||
				!unchanged(before, await file.stat({ bigint: true })) ||
				!unchanged(before, await lstat(join(this.anchor, name), { bigint: true }))
			)
				throw new Error("RESET_CUSTODY_FILE_CHANGED");
			await this.check();
			return { bytes: bytes.subarray(0, length), stat: before };
		} finally {
			await file.close();
		}
	}
	async write(name: string, bytes: Buffer): Promise<void> {
		await this.check();
		const file = await open(
			join(this.anchor, name),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.chown(Number(this.identity.uid), Number(this.identity.gid));
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		const reread = await this.read(name, Math.max(bytes.length, 1));
		if (!reread.bytes.equals(bytes)) throw new Error("RESET_CUSTODY_WRITE_CHANGED");
		await this.handle.sync();
		await this.check();
	}
}
async function held(options: CompanyComputerResetOutboxOptions, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	await options.guard.assertStoppedAndExclusive(signal);
	signal.throwIfAborted();
}
async function paths(
	options: CompanyComputerResetOutboxOptions,
	roots: readonly string[],
	guestDirectory: string,
	archiveDirectory?: string,
): Promise<void> {
	if (!Array.isArray(options.excludedRoots) || options.excludedRoots.length < 1 || options.excludedRoots.length > 32)
		throw new Error("RESET_CUSTODY_EXCLUSIONS_REQUIRED");
	for (const path of [...roots, options.guestRoot, ...options.excludedRoots])
		if (typeof path !== "string" || path === sep || resolve(path) !== path || (await realpath(path)) !== path)
			throw new Error("RESET_CUSTODY_PATH_UNSAFE");
	if (
		!guestDirectory.startsWith(`${options.guestRoot}${sep}`) ||
		(archiveDirectory && overlap(archiveDirectory, options.guestRoot))
	)
		throw new Error("RESET_CUSTODY_GUEST_ROOT_DIFFERS");
	for (let i = 0; i < roots.length; i++) {
		if (
			options.excludedRoots.some((path) => overlap(path, roots[i])) ||
			roots.slice(i + 1).some((path) => overlap(path, roots[i]))
		)
			throw new Error("RESET_CUSTODY_PATH_OVERLAP");
	}
}
type Snapshot = {
	manifest: Readonly<CompanyComputerResetOutboxManifest>;
	records: { name: string; bytes: Buffer; stat: BigIntStats }[];
};
async function snapshot(
	dir: Directory,
	binding: CompanyComputerResetCustodyBinding,
	archive = false,
): Promise<Snapshot> {
	const names = await dir.names(),
		dataNames = archive ? names.filter((name) => name !== "manifest.json") : names;
	if (dataNames.length < 1 || dataNames.length > COMPANY_COMPUTER_RESET_OUTBOX_MAX_RECORDS + 1)
		throw new Error("RESET_CUSTODY_INVENTORY_UNSAFE");
	const records: Snapshot["records"] = [];
	let totalBytes = 0,
		recordBytes = 0;
	for (const name of dataNames) {
		// Closed filenames exclude credentials, private keys and all arbitrary root
		// history. Unresolved .write-* requires the existing outbox recovery first.
		if (name !== "scope.json" && !/^[0-9a-f-]{36}-[0-9]{16}\.json$/.test(name))
			throw new Error("RESET_CUSTODY_INVENTORY_UNSAFE");
		const file = await dir.read(name, COMPANY_COMPUTER_RESET_OUTBOX_MAX_FILE_BYTES),
			value = decode(file.bytes);
		if (name === "scope.json") {
			if (!isDeepStrictEqual(value, { schema: "qorpera.screen-outbox-scope/v1", scope: binding.predecessor.scope }))
				throw new Error("RESET_CUSTODY_SCOPE_DIFFERS");
		} else {
			const observation = parseCompanyComputerScreenObservation(value);
			if (
				!isDeepStrictEqual(observation.startup.scope, binding.predecessor.scope) ||
				observation.startup.allocationId !== binding.predecessor.allocationId ||
				observation.startup.computerGeneration !== binding.predecessor.computerGeneration ||
				observation.startup.instanceSha256 !== binding.predecessor.instanceSha256
			)
				throw new Error("RESET_CUSTODY_OBSERVATION_SCOPE_DIFFERS");
			if (name !== `${observation.event.lifetimeId}-${String(observation.event.sequence).padStart(16, "0")}.json`)
				throw new Error("RESET_CUSTODY_RECORD_IDENTITY_DIFFERS");
			recordBytes += file.bytes.length;
		}
		if (!encode(value).equals(file.bytes)) throw new Error("RESET_CUSTODY_NONCANONICAL_RECORD");
		totalBytes += file.bytes.length;
		if (recordBytes > COMPANY_COMPUTER_RESET_OUTBOX_MAX_BYTES) throw new Error("RESET_CUSTODY_CAPACITY");
		records.push({ name, ...file });
	}
	if (!isDeepStrictEqual(names, await dir.names())) throw new Error("RESET_CUSTODY_INVENTORY_CHANGED");
	const manifest = parseCompanyComputerResetOutboxManifest(
		{
			schema: "qorpera.office-reset-outbox/v1",
			binding,
			files: records.map((r) => ({
				name: r.name,
				bytes: r.bytes.length,
				sha256: hash(r.bytes),
				uid: binding.outboxUid,
				gid: binding.outboxGid,
				mode: 0o600,
			})),
			recordCount: records.length - 1,
			totalBytes,
		},
		binding,
	);
	return { manifest, records };
}
async function unchangedSnapshot(
	dir: Directory,
	original: Snapshot,
	binding: CompanyComputerResetCustodyBinding,
): Promise<void> {
	const current = await snapshot(dir, binding);
	if (
		!isDeepStrictEqual(original.manifest, current.manifest) ||
		original.records.some((r, i) => !unchanged(r.stat, current.records[i].stat))
	)
		throw new Error("RESET_CUSTODY_SOURCE_CHANGED");
}
async function verifiedArchive(
	dir: Directory,
	binding: CompanyComputerResetCustodyBinding,
): Promise<{
	manifest: Readonly<CompanyComputerResetOutboxManifest>;
	manifestSha256: string;
	records: Snapshot["records"];
}> {
	const seal = await dir.read("manifest.json", COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES);
	const manifest = parseCompanyComputerResetOutboxManifest(decode(seal.bytes), binding);
	if (!encode(manifest).equals(seal.bytes)) throw new Error("RESET_CUSTODY_MANIFEST_CHANGED");
	const current = await snapshot(dir, binding, true);
	if (
		!isDeepStrictEqual(manifest, current.manifest) ||
		!(await dir.read("manifest.json", COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES)).bytes.equals(seal.bytes)
	)
		throw new Error("RESET_CUSTODY_ARCHIVE_CHANGED");
	return { manifest, manifestSha256: hash(seal.bytes), records: current.records };
}
/** Read only; refuses unsealed/ambiguous source remnants. Historical startup
 * and event bytes are preserved, not replaced with the current invocation. */
export async function inventoryCompanyComputerResetOutbox(
	root: string,
	options: CompanyComputerResetOutboxOptions,
	signal: AbortSignal,
): Promise<Readonly<CompanyComputerResetOutboxManifest>> {
	const binding = parseCompanyComputerResetCustodyBinding(options.binding);
	await paths(options, [root], root);
	await held(options, signal);
	const dir = await Directory.acquire(root, binding.outboxUid, binding.outboxGid);
	try {
		const original = await snapshot(dir, binding);
		await held(options, signal);
		await unchangedSnapshot(dir, original, binding);
		return original.manifest;
	} finally {
		await dir.handle.close();
	}
}
/** archiveRoot is preprovisioned, empty, provider-owned mode0700 and outside
 * the disposable root and all excluded roots. Its seal is published last.
 * Partial copies remain unsealed and are never overwritten/repaired here. */
export async function archiveCompanyComputerResetOutbox(
	sourceRoot: string,
	archiveRoot: string,
	options: CompanyComputerResetOutboxOptions,
	signal: AbortSignal,
) {
	const binding = parseCompanyComputerResetCustodyBinding(options.binding);
	await paths(options, [sourceRoot, archiveRoot], sourceRoot, archiveRoot);
	await held(options, signal);
	const source = await Directory.acquire(sourceRoot, binding.outboxUid, binding.outboxGid);
	let archive: Directory | undefined;
	try {
		archive = await Directory.acquire(archiveRoot, process.getuid!(), process.getgid!());
		const original = await snapshot(source, binding);
		if ((await archive.names()).length) {
			const existing = await verifiedArchive(archive, binding);
			if (!isDeepStrictEqual(existing.manifest, original.manifest)) throw new Error("RESET_CUSTODY_ARCHIVE_DIFFERS");
			await held(options, signal);
			await unchangedSnapshot(source, original, binding);
			return { manifest: existing.manifest, manifestSha256: existing.manifestSha256 };
		}
		for (const file of original.records) {
			await held(options, signal);
			await archive.write(file.name, file.bytes);
		}
		await held(options, signal);
		await unchangedSnapshot(source, original, binding);
		const bytes = encode(original.manifest);
		if (bytes.length > COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES) throw new Error("RESET_CUSTODY_MANIFEST_CAPACITY");
		const temporary = `.seal-${randomUUID()}`;
		await archive.write(temporary, bytes);
		await held(options, signal);
		await unchangedSnapshot(source, original, binding);
		await archive.check();
		await link(join(archive.anchor, temporary), join(archive.anchor, "manifest.json"));
		await unlink(join(archive.anchor, temporary));
		await archive.handle.sync();
		const result = await verifiedArchive(archive, binding);
		await held(options, signal);
		await unchangedSnapshot(source, original, binding);
		return { manifest: result.manifest, manifestSha256: result.manifestSha256 };
	} finally {
		await archive?.handle.close();
		await source.handle.close();
	}
}
/** Restores only the immutable outbox allowlist into a preprovisioned empty
 * original-owner directory. Does not replay SQL, restore credentials, delete
 * archive/source records, enable services or establish new execution authority. */
export async function restoreCompanyComputerResetOutbox(
	archiveRoot: string,
	destinationRoot: string,
	options: CompanyComputerResetOutboxOptions,
	expectedManifestSha256: string,
	signal: AbortSignal,
) {
	if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256)) throw new Error("RESET_CUSTODY_MANIFEST_DIGEST_INVALID");
	const binding = parseCompanyComputerResetCustodyBinding(options.binding);
	await paths(options, [archiveRoot, destinationRoot], destinationRoot, archiveRoot);
	await held(options, signal);
	const archive = await Directory.acquire(archiveRoot, process.getuid!(), process.getgid!());
	let destination: Directory | undefined;
	try {
		const original = await verifiedArchive(archive, binding);
		if (original.manifestSha256 !== expectedManifestSha256) throw new Error("RESET_CUSTODY_MANIFEST_DIGEST_DIFFERS");
		destination = await Directory.acquire(destinationRoot, binding.outboxUid, binding.outboxGid);
		if ((await destination.names()).length === 0)
			for (const file of original.records) {
				await held(options, signal);
				await destination.write(file.name, file.bytes);
			}
		const restored = await snapshot(destination, binding);
		if (!isDeepStrictEqual(restored.manifest, original.manifest)) throw new Error("RESET_CUSTODY_RESTORE_DIFFERS");
		await held(options, signal);
		if ((await verifiedArchive(archive, binding)).manifestSha256 !== expectedManifestSha256)
			throw new Error("RESET_CUSTODY_ARCHIVE_CHANGED");
		await unchangedSnapshot(destination, restored, binding);
		return parseCompanyComputerResetOutboxRestoreReceipt(
			{
				schema: "qorpera.office-reset-outbox-restore/v1",
				binding,
				manifestSha256: expectedManifestSha256,
				fileCount: original.manifest.files.length,
				totalBytes: original.manifest.totalBytes,
				state: "restored",
			},
			original.manifest,
			expectedManifestSha256,
		);
	} finally {
		await destination?.handle.close();
		await archive.handle.close();
	}
}
