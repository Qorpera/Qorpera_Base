import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES,
	type CompanyComputerPreparationRequest,
	type CompanyComputerResetCustodyBinding,
	type CompanyComputerResetCustodyManifest,
	type CompanyComputerResetOutboxManifest,
	type CompanyComputerResetPlan,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResetCustodyManifest,
	parseCompanyComputerResetOutboxManifest,
	parseCompanyComputerResetPlan,
} from "@qorpera/contracts";
import { officeCanonical, officeDigest } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import type { LxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
export interface LxdOfficeResetArchiveFile {
	readonly name: string;
	readonly bytes: Buffer;
}
export interface LxdOfficeResetArchive {
	readonly root: string;
	readonly outbox: string;
	readonly history: string;
}

/** Guest layout roots under the NAS mount, expressed as host paths. */
export function lxdOfficeResetLayoutRoots(
	policy: LxdOfficePhysicalPolicy,
	original: CompanyComputerPreparationRequest,
) {
	const request = parseCompanyComputerPreparationRequest(original),
		receipt = companyComputerPreparationAdoptionReceipt(request),
		mountPoint = request.workbenchMount.mountPoint;
	return Object.entries(receipt.layout).map(([key, guest]) => {
		if (!guest.startsWith(`${mountPoint}/`)) throw new Error("OFFICE_RESET_LAYOUT_UNCONFIRMED");
		return { key, guest, host: `${policy.guest.workbenchSource}${guest.slice(mountPoint.length)}` };
	});
}

/** Provider-owned root-only custody store outside the disposable root, the
 * provider journal and every model-visible layout root. The reset's own
 * directory and its outbox/history subdirectories are created here; their
 * ancestors are operator-provisioned and must already be private. */
export async function openLxdOfficeResetArchive(
	policy: LxdOfficePhysicalPolicy,
	value: CompanyComputerResetPlan,
	original: CompanyComputerPreparationRequest,
): Promise<LxdOfficeResetArchive> {
	const plan = parseCompanyComputerResetPlan(value),
		archiveRoot = plan.custody.archiveRoot;
	const excluded = [
		policy.journal.path,
		policy.guest.workbenchSource,
		...lxdOfficeResetLayoutRoots(policy, original).map((root) => root.host),
	];
	if (excluded.some((path) => overlap(path, archiveRoot))) throw new Error("OFFICE_RESET_CUSTODY_ROOT_OVERLAPS");
	await checkDirectory(archiveRoot);
	if ((await realpath(archiveRoot)) !== archiveRoot) throw new Error("OFFICE_RESET_CUSTODY_ROOT_UNSAFE");
	const root = join(archiveRoot, plan.resetId);
	for (const [parent, path] of [
		[archiveRoot, root],
		[root, join(root, "outbox")],
		[root, join(root, "history")],
	]) {
		try {
			await mkdir(path, { mode: 0o700 });
			await syncDirectory(parent);
		} catch (error) {
			if (!code(error, "EEXIST")) throw error;
		}
		await checkDirectory(path);
	}
	return { root, outbox: join(root, "outbox"), history: join(root, "history") };
}

async function retainFile(directory: string, name: string, bytes: Buffer): Promise<void> {
	if (!(await publish(directory, name, bytes))) {
		const existing = await readRecord(join(directory, name), Math.max(bytes.length, 1));
		if (!existing.bytes.equals(bytes)) throw new Error("OFFICE_RESET_ARCHIVE_DIFFERS");
	}
}

/** Write every blob with exclusive creation, fsync files and directories,
 * then seal the custody manifest last and independently reread everything.
 * An existing sealed archive is accepted only when it is byte-identical. */
export async function sealLxdOfficeResetArchive(
	archive: LxdOfficeResetArchive,
	plan: CompanyComputerResetPlan,
	binding: CompanyComputerResetCustodyBinding,
	outboxManifest: CompanyComputerResetOutboxManifest,
	outboxFiles: readonly LxdOfficeResetArchiveFile[],
	historyFiles: readonly LxdOfficeResetArchiveFile[],
	custody: CompanyComputerResetCustodyManifest,
): Promise<{ manifest: CompanyComputerResetCustodyManifest; manifestSha256: string }> {
	const manifest = parseCompanyComputerResetCustodyManifest(custody, plan);
	const outbox = parseCompanyComputerResetOutboxManifest(outboxManifest, binding);
	if (
		outbox.files.length !== outboxFiles.length ||
		outbox.files.some((entry, index) => {
			const file = outboxFiles[index];
			return entry.name !== file.name || entry.bytes !== file.bytes.length || entry.sha256 !== hash(file.bytes);
		})
	)
		throw new Error("OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS");
	const outboxBytes = Buffer.from(officeCanonical(outbox));
	if (
		hash(outboxBytes) !== manifest.outbox.manifestSha256 ||
		outboxBytes.length > COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES
	)
		throw new Error("OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS");
	const historyShas = new Set(manifest.history.files.map((file) => file.sha256));
	if (
		historyFiles.some((file) => file.name !== `${hash(file.bytes)}.json` || !historyShas.has(hash(file.bytes))) ||
		new Set(historyFiles.map((file) => file.name)).size !== historyShas.size
	)
		throw new Error("OFFICE_RESET_ARCHIVE_HISTORY_DIFFERS");
	for (const file of outboxFiles) await retainFile(archive.outbox, file.name, file.bytes);
	for (const file of historyFiles) await retainFile(archive.history, file.name, file.bytes);
	await retainFile(archive.root, "outbox-manifest.json", outboxBytes);
	await syncDirectory(archive.outbox);
	await syncDirectory(archive.history);
	const bytes = Buffer.from(officeCanonical(manifest));
	await retainFile(archive.root, "manifest.json", bytes);
	await syncDirectory(archive.root);
	const verified = await readLxdOfficeResetArchive(archive, plan, binding);
	if (verified.manifestSha256 !== hash(bytes) || !isDeepStrictEqual(verified.manifest, manifest))
		throw new Error("OFFICE_RESET_ARCHIVE_SEAL_DIFFERS");
	return { manifest, manifestSha256: verified.manifestSha256 };
}

/** Independent readback of the sealed archive: exact manifest bytes, exact
 * outbox and history blobs, no stray entries. Returns raw bytes for restore. */
export async function readLxdOfficeResetArchive(
	archive: LxdOfficeResetArchive,
	value: CompanyComputerResetPlan,
	binding: CompanyComputerResetCustodyBinding,
): Promise<{
	manifest: CompanyComputerResetCustodyManifest;
	manifestSha256: string;
	outboxManifest: CompanyComputerResetOutboxManifest;
	outbox: Map<string, { bytes: Buffer; uid: number; gid: number; mode: number }>;
	history: Map<string, Buffer>;
}> {
	const plan = parseCompanyComputerResetPlan(value);
	for (const path of [archive.root, archive.outbox, archive.history]) await checkDirectory(path);
	const seal = await readRecord(join(archive.root, "manifest.json"), COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES),
		manifest = parseCompanyComputerResetCustodyManifest(seal.value, plan);
	if (!Buffer.from(officeCanonical(manifest)).equals(seal.bytes)) throw new Error("OFFICE_RESET_ARCHIVE_SEAL_DIFFERS");
	const outboxRecord = await readRecord(
			join(archive.root, "outbox-manifest.json"),
			COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES,
		),
		outboxManifest = parseCompanyComputerResetOutboxManifest(outboxRecord.value, binding);
	if (
		hash(outboxRecord.bytes) !== manifest.outbox.manifestSha256 ||
		outboxManifest.recordCount !== manifest.outbox.recordCount ||
		outboxManifest.totalBytes !== manifest.outbox.totalBytes ||
		!isDeepStrictEqual((await readdir(archive.root)).sort(), [
			"history",
			"manifest.json",
			"outbox",
			"outbox-manifest.json",
		])
	)
		throw new Error("OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS");
	const outbox = new Map<string, { bytes: Buffer; uid: number; gid: number; mode: number }>();
	const outboxNames = (await readdir(archive.outbox)).sort();
	if (
		!isDeepStrictEqual(
			outboxNames,
			outboxManifest.files.map((file) => file.name),
		)
	)
		throw new Error("OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS");
	for (const entry of outboxManifest.files) {
		const file = await readRecord(join(archive.outbox, entry.name), entry.bytes);
		if (file.bytes.length !== entry.bytes || hash(file.bytes) !== entry.sha256)
			throw new Error("OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS");
		outbox.set(entry.name, { bytes: file.bytes, uid: entry.uid, gid: entry.gid, mode: entry.mode });
	}
	const history = new Map<string, Buffer>();
	const expected = [...new Set(manifest.history.files.map((file) => `${file.sha256}.json`))].sort();
	if (!isDeepStrictEqual((await readdir(archive.history)).sort(), expected))
		throw new Error("OFFICE_RESET_ARCHIVE_HISTORY_DIFFERS");
	for (const entry of manifest.history.files) {
		const file =
			history.get(entry.sha256) ??
			(await readRecord(join(archive.history, `${entry.sha256}.json`), entry.bytes)).bytes;
		if (file.length !== entry.bytes || hash(file) !== entry.sha256)
			throw new Error("OFFICE_RESET_ARCHIVE_HISTORY_DIFFERS");
		history.set(entry.sha256, file);
	}
	return { manifest, manifestSha256: hash(seal.bytes), outboxManifest, outbox, history };
}

interface Held {
	key: string;
	guest: string;
	host: string;
	handle: FileHandle;
	identity: BigIntStats;
}
/** Descriptor custody of the four adopted layout roots on the NAS mount for
 * the duration of a reset phase. Only directory identity, ownership and mode
 * are checked; mutable working contents are never enumerated, read, copied or
 * compared. The layout digest binds those identities into custody evidence. */
export async function openLxdOfficeResetNasCustody(
	policy: LxdOfficePhysicalPolicy,
	original: CompanyComputerPreparationRequest,
): Promise<{ layoutSha256: string; adoptionId: string; verify(): Promise<void>; close(): Promise<void> }> {
	const request = parseCompanyComputerPreparationRequest(original),
		roots = lxdOfficeResetLayoutRoots(policy, request),
		held: Held[] = [];
	const same = (a: BigIntStats, b: BigIntStats) =>
		a.isDirectory() &&
		b.isDirectory() &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.uid === b.uid &&
		a.gid === b.gid &&
		a.mode === b.mode;
	const check = async (item: Held) => {
		const current = await item.handle.stat({ bigint: true }),
			named = await lstat(item.host, { bigint: true });
		if (
			!same(current, item.identity) ||
			!same(named, item.identity) ||
			current.uid !== BigInt(request.uid) ||
			current.gid !== BigInt(request.gid) ||
			(current.mode & 0o777n) !== 0o700n ||
			(await realpath(item.host)) !== item.host
		)
			throw new Error("OFFICE_RESET_NAS_CUSTODY_CHANGED");
	};
	const close = async () => {
		const results = await Promise.allSettled(held.splice(0).map((item) => item.handle.close()));
		for (const result of results) if (result.status === "rejected") throw result.reason;
	};
	try {
		if (
			(await realpath(policy.guest.workbenchSource)) !== policy.guest.workbenchSource ||
			roots.some((root) => !root.host.startsWith(`${policy.guest.workbenchSource}${sep}`))
		)
			throw new Error("OFFICE_RESET_NAS_CUSTODY_UNSAFE");
		for (const root of roots) {
			const handle = await open(root.host, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				const identity = await handle.stat({ bigint: true });
				held.push({ ...root, handle, identity });
				await check(held.at(-1)!);
			} catch (error) {
				if (!held.some((item) => item.handle === handle)) await handle.close();
				throw error;
			}
		}
		const layoutSha256 = officeDigest({
			schema: "qorpera.lxd-office-reset-nas-layout/v1",
			adoptionId: request.copy.adoptionId,
			workbenchSource: policy.guest.workbenchSource,
			roots: held.map((item) => ({
				key: item.key,
				guest: item.guest,
				host: item.host,
				dev: item.identity.dev.toString(),
				ino: item.identity.ino.toString(),
				uid: Number(item.identity.uid),
				gid: Number(item.identity.gid),
				mode: Number(item.identity.mode & 0o7777n),
			})),
		});
		return {
			layoutSha256,
			adoptionId: request.copy.adoptionId,
			verify: async () => {
				for (const item of held) await check(item);
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
