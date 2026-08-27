import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	type CompanyRuntimeLock,
	canonicalCompanyRoot,
	claimCompanyRuntimeLock,
	releaseCompanyRuntimeLock,
} from "@qorpera/company/company-runtime-lock";
import {
	type CloudCompanyTreeEntry,
	type CloudCompanyTreeManifest,
	type CloudCompanyTreeReference,
	cloudCompanyPathBelongsToLogicalTree,
	currentCloudCompanyTreeReference,
	materializeCloudCompanyTree,
	readCloudCompanyTreeManifest,
	validateCloudCompanyTreeEntries,
} from "./cloud-company-snapshot.ts";
import type { CompanyWorkspacePrimary } from "./cloud-company-workspace.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { HostedCompanySnapshot } from "./hosted-primary.ts";

const MAX_SNAPSHOT_LINEAGE = 10_000;
const MERGE_JOURNAL_SCHEMA = "qorpera.cloud-company-merge-journal/v1";

interface CloudCompanyMergeJournal {
	schema: typeof MERGE_JOURNAL_SCHEMA;
	companyRoot: string;
	localEntries: CloudCompanyTreeEntry[];
	resultEntries: CloudCompanyTreeEntry[];
	createdAt: string;
}

export interface CloudCompanyMergeConflict {
	path: string;
	reason: "both-changed" | "structural";
}

export interface CloudCompanyMergePlan {
	ancestorSnapshotId: string;
	localSnapshotId: string;
	remoteSnapshotId: string;
	changedPaths: string[];
	conflicts: CloudCompanyMergeConflict[];
}

export interface PreviewCloudCompanySnapshotInput {
	userData: string;
	profileId: string;
	snapshot: HostedCompanySnapshot;
	objects: CloudContentAddressedStore;
}

export interface PreviewCloudCompanySnapshotResult {
	path: string;
	snapshotId: string;
	fileCount: number;
	totalBytes: number;
}

export interface MergeCloudCompanySnapshotsInput {
	companyRoot: string;
	profileId: string;
	environmentId: string;
	localSnapshotId: string;
	remoteSnapshotId: string;
	primary: Pick<CompanyWorkspacePrimary, "getCompanySnapshot">;
	objects: CloudContentAddressedStore;
	runtimeLock?: CompanyRuntimeLock;
}

export interface MergeCloudCompanySnapshotsResult {
	applied: boolean;
	plan: CloudCompanyMergePlan;
}

export interface ReconcileCloudCompanyCacheInput {
	companyRoot: string;
	profileId: string;
	environmentId: string;
	baseSnapshotId: string;
	localTree: CloudCompanyTreeReference;
	remoteSnapshotId: string;
	primary: Pick<CompanyWorkspacePrimary, "getCompanySnapshot">;
	objects: CloudContentAddressedStore;
	runtimeLock?: CompanyRuntimeLock;
}

export interface ReplaceCloudCompanyCacheInput {
	companyRoot: string;
	profileId: string;
	environmentId: string;
	localTree: CloudCompanyTreeReference;
	remoteSnapshot: HostedCompanySnapshot;
	conflictPaths: readonly string[];
	objects: CloudContentAddressedStore;
	runtimeLock?: CompanyRuntimeLock;
}

interface PlannedCloudCompanyMerge {
	plan: CloudCompanyMergePlan;
	localManifest: CloudCompanyTreeManifest;
	resultEntries: CloudCompanyTreeEntry[];
}

interface PhysicalTreeEntry {
	kind: "directory" | "file";
	path: string;
	executable?: boolean;
	fileSha256?: string;
	bytes?: number;
}

export function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function sameEntry(left: CloudCompanyTreeEntry | undefined, right: CloudCompanyTreeEntry | undefined): boolean {
	if (!left || !right) return left === right;
	if (left.kind !== right.kind || left.path !== right.path) return false;
	if (left.kind === "directory" || right.kind === "directory") return true;
	return (
		left.executable === right.executable &&
		left.file.fileSha256 === right.file.fileSha256 &&
		left.file.bytes === right.file.bytes &&
		left.file.mediaType === right.file.mediaType
	);
}

export function entryMap(entries: readonly CloudCompanyTreeEntry[]): Map<string, CloudCompanyTreeEntry> {
	return new Map(entries.map((entry) => [entry.path, entry]));
}

function addConflict(
	conflicts: Map<string, CloudCompanyMergeConflict>,
	path: string,
	reason: CloudCompanyMergeConflict["reason"],
): void {
	const existing = conflicts.get(path);
	if (!existing || (existing.reason === "both-changed" && reason === "structural")) {
		conflicts.set(path, { path, reason });
	}
}

function buildMergePlan(
	ancestorSnapshotId: string,
	localSnapshotId: string,
	remoteSnapshotId: string,
	baseManifest: CloudCompanyTreeManifest,
	localManifest: CloudCompanyTreeManifest,
	remoteManifest: CloudCompanyTreeManifest,
): PlannedCloudCompanyMerge {
	const base = entryMap(baseManifest.entries);
	const local = entryMap(localManifest.entries);
	const remote = entryMap(remoteManifest.entries);
	const paths = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort(comparePath);
	const conflicts = new Map<string, CloudCompanyMergeConflict>();
	const result = new Map<string, CloudCompanyTreeEntry>();
	for (const path of paths) {
		const baseEntry = base.get(path);
		const localEntry = local.get(path);
		const remoteEntry = remote.get(path);
		let selected: CloudCompanyTreeEntry | undefined;
		if (sameEntry(localEntry, remoteEntry)) selected = localEntry;
		else if (sameEntry(localEntry, baseEntry)) selected = remoteEntry;
		else if (sameEntry(remoteEntry, baseEntry)) selected = localEntry;
		else {
			addConflict(conflicts, path, "both-changed");
			selected = localEntry;
		}
		if (selected) result.set(path, selected);
	}

	const resultPaths = [...result.keys()].sort(comparePath);
	for (const entry of result.values()) {
		if (entry.kind !== "file") continue;
		const prefix = `${entry.path}/`;
		for (const path of resultPaths) {
			if (!path.startsWith(prefix)) continue;
			addConflict(conflicts, entry.path, "structural");
			addConflict(conflicts, path, "structural");
		}
	}
	const finalResultEntries = [...result.values()].sort((left, right) => comparePath(left.path, right.path));
	const changedPaths = [...new Set([...local.keys(), ...result.keys()])]
		.filter((path) => !sameEntry(local.get(path), result.get(path)))
		.sort(comparePath);
	return {
		plan: {
			ancestorSnapshotId,
			localSnapshotId,
			remoteSnapshotId,
			changedPaths,
			conflicts: [...conflicts.values()].sort((left, right) => comparePath(left.path, right.path)),
		},
		localManifest,
		resultEntries: finalResultEntries,
	};
}

function assertSnapshotScope(snapshot: HostedCompanySnapshot, profileId: string, environmentId: string): void {
	if (snapshot.profileId !== profileId || snapshot.environmentId !== environmentId) {
		throw new Error("Cloud company snapshot is outside this profile environment");
	}
}

async function snapshotLineage(
	startId: string,
	profileId: string,
	environmentId: string,
	primary: Pick<CompanyWorkspacePrimary, "getCompanySnapshot">,
): Promise<Map<string, HostedCompanySnapshot>> {
	const lineage = new Map<string, HostedCompanySnapshot>();
	let snapshotId: string | undefined = startId;
	while (snapshotId) {
		if (lineage.has(snapshotId)) throw new Error("Cloud company snapshot lineage contains a cycle");
		if (lineage.size >= MAX_SNAPSHOT_LINEAGE) throw new Error("Cloud company snapshot lineage is too deep");
		const snapshot = await primary.getCompanySnapshot(snapshotId);
		if (snapshot.snapshotId !== snapshotId)
			throw new Error("Cloud company snapshot lookup returned another snapshot");
		assertSnapshotScope(snapshot, profileId, environmentId);
		lineage.set(snapshotId, snapshot);
		snapshotId = snapshot.parentSnapshotId;
	}
	return lineage;
}

async function planCloudCompanyMerge(input: MergeCloudCompanySnapshotsInput): Promise<PlannedCloudCompanyMerge> {
	const localLineage = await snapshotLineage(
		input.localSnapshotId,
		input.profileId,
		input.environmentId,
		input.primary,
	);
	const remoteLineage = await snapshotLineage(
		input.remoteSnapshotId,
		input.profileId,
		input.environmentId,
		input.primary,
	);
	const ancestorSnapshotId = [...remoteLineage.keys()].find((snapshotId) => localLineage.has(snapshotId));
	if (!ancestorSnapshotId) throw new Error("Cloud company snapshots have no common ancestor");
	const ancestor = localLineage.get(ancestorSnapshotId) as HostedCompanySnapshot;
	const local = localLineage.get(input.localSnapshotId) as HostedCompanySnapshot;
	const remote = remoteLineage.get(input.remoteSnapshotId) as HostedCompanySnapshot;
	const [baseManifest, localManifest, remoteManifest] = await Promise.all([
		readCloudCompanyTreeManifest(input.profileId, currentCloudCompanyTreeReference(ancestor.tree), input.objects),
		readCloudCompanyTreeManifest(input.profileId, currentCloudCompanyTreeReference(local.tree), input.objects),
		readCloudCompanyTreeManifest(input.profileId, currentCloudCompanyTreeReference(remote.tree), input.objects),
	]);
	return buildMergePlan(
		ancestorSnapshotId,
		input.localSnapshotId,
		input.remoteSnapshotId,
		baseManifest,
		localManifest,
		remoteManifest,
	);
}

export async function inspectCloudCompanyMerge(input: MergeCloudCompanySnapshotsInput): Promise<CloudCompanyMergePlan> {
	return (await planCloudCompanyMerge(input)).plan;
}

function logicalPath(root: string, path: string): string {
	const absolute = resolve(root, ...path.split("/"));
	const rootRelative = relative(root, absolute);
	if (!rootRelative || rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
		throw new Error("Cloud company merge path escapes the company folder");
	}
	return absolute;
}

async function inspectPhysicalTree(root: string): Promise<PhysicalTreeEntry[]> {
	const entries: PhysicalTreeEntry[] = [];
	const visit = async (directory: string): Promise<void> => {
		const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name, "en"),
		);
		for (const child of children) {
			const absolutePath = join(directory, child.name);
			const path = relative(root, absolutePath).split(sep).join("/");
			if (!cloudCompanyPathBelongsToLogicalTree(path)) continue;
			const entryStat = await lstat(absolutePath);
			if (entryStat.isSymbolicLink()) throw new Error(`Cloud company tree cannot contain links: ${path}`);
			if (child.isDirectory() && entryStat.isDirectory()) {
				entries.push({ kind: "directory", path });
				await visit(absolutePath);
				continue;
			}
			if (!child.isFile() || !entryStat.isFile() || entryStat.nlink !== 1) {
				throw new Error(`Cloud company tree can contain only physical files and directories: ${path}`);
			}
			const bytes = await readFile(absolutePath);
			entries.push({
				kind: "file",
				path,
				executable: (entryStat.mode & 0o111) !== 0,
				fileSha256: createHash("sha256").update(bytes).digest("hex"),
				bytes: bytes.byteLength,
			});
		}
	};
	await visit(root);
	return entries.sort((left, right) => comparePath(left.path, right.path));
}

function physicalTreeMatchesManifest(physical: PhysicalTreeEntry[], manifest: CloudCompanyTreeManifest): boolean {
	if (physical.length !== manifest.entries.length) return false;
	return physical.every((entry, index) => {
		const expected = manifest.entries[index];
		if (!expected || entry.kind !== expected.kind || entry.path !== expected.path) return false;
		return (
			entry.kind === "directory" ||
			(expected.kind === "file" &&
				entry.executable === expected.executable &&
				entry.fileSha256 === expected.file.fileSha256 &&
				entry.bytes === expected.file.bytes)
		);
	});
}

async function stageChangedFiles(
	root: string,
	profileId: string,
	local: Map<string, CloudCompanyTreeEntry>,
	result: Map<string, CloudCompanyTreeEntry>,
	objects: CloudContentAddressedStore,
): Promise<{ transactionRoot: string; stagedRoot: string; backupRoot: string; omittedBackupRoot: string }> {
	const transactionRoot = join(root, ".qorpera", "w", `cloud-merge-${randomUUID()}`);
	if (cloudCompanyPathBelongsToLogicalTree(relative(root, transactionRoot))) {
		throw new Error("Cloud company merge transaction path is not isolated");
	}
	const stagedRoot = join(transactionRoot, "staged");
	const backupRoot = join(transactionRoot, "backup");
	const omittedBackupRoot = join(transactionRoot, "omitted");
	try {
		await mkdir(stagedRoot, { recursive: true });
		for (const [path, entry] of result) {
			if (entry.kind !== "file" || sameEntry(local.get(path), entry)) continue;
			const target = logicalPath(stagedRoot, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, await objects.getFile(profileId, entry.file), { flag: "wx" });
			if (entry.executable && process.platform !== "win32") await chmod(target, 0o755);
		}
	} catch (error) {
		await rm(transactionRoot, { recursive: true, force: true });
		throw error;
	}
	return { transactionRoot, stagedRoot, backupRoot, omittedBackupRoot };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function writeMergeJournal(
	transactionRoot: string,
	root: string,
	localEntries: CloudCompanyTreeEntry[],
	resultEntries: CloudCompanyTreeEntry[],
): Promise<void> {
	const path = join(transactionRoot, "journal.json");
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(
			`${JSON.stringify({
				schema: MERGE_JOURNAL_SCHEMA,
				companyRoot: root,
				localEntries,
				resultEntries,
				createdAt: new Date().toISOString(),
			} satisfies CloudCompanyMergeJournal)}\n`,
			"utf-8",
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeMergeCommitMarker(transactionRoot: string): Promise<void> {
	const handle = await open(join(transactionRoot, "committed"), "wx", 0o600);
	try {
		await handle.writeFile("committed\n", "utf-8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function moveOmittedDirectory(root: string, path: string, omittedBackupRoot: string): Promise<boolean> {
	const source = logicalPath(root, path);
	const children = await readdir(source, { withFileTypes: true });
	for (const child of children) {
		const relativePath = relative(root, join(source, child.name)).split(sep).join("/");
		if (cloudCompanyPathBelongsToLogicalTree(relativePath)) return false;
	}
	const backup = logicalPath(omittedBackupRoot, path);
	await mkdir(dirname(backup), { recursive: true });
	await rename(source, backup);
	return true;
}

async function restoreOmittedTree(sourceRoot: string, targetRoot: string): Promise<void> {
	if (!(await pathExists(sourceRoot))) return;
	const visit = async (sourceDirectory: string, relativeDirectory: string): Promise<void> => {
		for (const child of await readdir(sourceDirectory, { withFileTypes: true })) {
			const source = join(sourceDirectory, child.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
			const target = logicalPath(targetRoot, relativePath);
			if (child.isDirectory()) {
				await mkdir(target, { recursive: true });
				await visit(source, relativePath);
				continue;
			}
			if (await pathExists(target)) throw new Error("Omitted Company File layer changed during merge rollback");
			await mkdir(dirname(target), { recursive: true });
			await rename(source, target);
		}
		await rmdir(sourceDirectory);
	};
	await visit(sourceRoot, "");
}

async function readMergeJournal(path: string, root: string): Promise<CloudCompanyMergeJournal> {
	const value: unknown = JSON.parse(await readFile(path, "utf-8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cloud merge journal is invalid");
	const journal = value as Partial<CloudCompanyMergeJournal>;
	if (
		journal.schema !== MERGE_JOURNAL_SCHEMA ||
		journal.companyRoot !== root ||
		!Array.isArray(journal.localEntries) ||
		!Array.isArray(journal.resultEntries) ||
		typeof journal.createdAt !== "string" ||
		!Number.isFinite(Date.parse(journal.createdAt))
	) {
		throw new Error("Cloud merge journal is invalid");
	}
	for (const entry of [...journal.localEntries, ...journal.resultEntries]) {
		if (!entry || (entry.kind !== "file" && entry.kind !== "directory") || typeof entry.path !== "string") {
			throw new Error("Cloud merge journal entry is invalid");
		}
		logicalPath(root, entry.path);
	}
	return journal as CloudCompanyMergeJournal;
}

async function rollbackMerge(
	root: string,
	backupRoot: string,
	omittedBackupRoot: string,
	installedFiles: string[],
	localEntries: CloudCompanyTreeEntry[],
	resultEntries: CloudCompanyTreeEntry[],
): Promise<void> {
	for (const path of installedFiles.reverse()) await rm(logicalPath(root, path), { force: true });
	const localDirectoryPaths = new Set(
		localEntries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
	);
	const resultOnlyDirectories = resultEntries
		.filter((entry) => entry.kind === "directory" && !localDirectoryPaths.has(entry.path))
		.map((entry) => entry.path)
		.sort((left, right) => right.split("/").length - left.split("/").length);
	for (const path of resultOnlyDirectories) {
		try {
			await rmdir(logicalPath(root, path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await restoreOmittedTree(omittedBackupRoot, root);
	const localDirectories = localEntries
		.filter((entry) => entry.kind === "directory")
		.map((entry) => entry.path)
		.sort((left, right) => left.split("/").length - right.split("/").length);
	for (const path of localDirectories) await mkdir(logicalPath(root, path), { recursive: true });
	for (const entry of localEntries) {
		if (entry.kind !== "file") continue;
		const backup = logicalPath(backupRoot, entry.path);
		try {
			await lstat(backup);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const target = logicalPath(root, entry.path);
		await mkdir(dirname(target), { recursive: true });
		await rename(backup, target);
	}
}

async function recoverMergeTransaction(
	root: string,
	transactionRoot: string,
	journal: CloudCompanyMergeJournal,
): Promise<void> {
	const local = entryMap(journal.localEntries);
	const result = entryMap(journal.resultEntries);
	const backupRoot = join(transactionRoot, "backup");
	const paths = [...new Set([...local.keys(), ...result.keys()])].sort(comparePath);
	for (const path of paths) {
		const localEntry = local.get(path);
		const resultEntry = result.get(path);
		if (sameEntry(localEntry, resultEntry)) continue;
		const target = logicalPath(root, path);
		const backup = logicalPath(backupRoot, path);
		if (localEntry?.kind === "file") {
			if (!(await pathExists(backup))) continue;
			await rm(target, { recursive: true, force: true });
			await mkdir(dirname(target), { recursive: true });
			await rename(backup, target);
		} else if (resultEntry?.kind === "file") {
			await rm(target, { recursive: true, force: true });
		}
	}
	await restoreOmittedTree(join(transactionRoot, "omitted"), root);
	const localDirectories = new Set(
		journal.localEntries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
	);
	const resultOnlyDirectories = journal.resultEntries
		.filter((entry) => entry.kind === "directory" && !localDirectories.has(entry.path))
		.map((entry) => entry.path)
		.sort((left, right) => right.split("/").length - left.split("/").length);
	for (const path of resultOnlyDirectories) {
		try {
			await rmdir(logicalPath(root, path));
		} catch (error) {
			if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	for (const path of [...localDirectories].sort((left, right) => left.split("/").length - right.split("/").length)) {
		await mkdir(logicalPath(root, path), { recursive: true });
	}
}

export async function recoverInterruptedCloudCompanyMerges(
	companyRoot: string,
	runtimeLock?: CompanyRuntimeLock,
): Promise<void> {
	const root = canonicalCompanyRoot(companyRoot);
	if (
		runtimeLock &&
		(process.platform === "win32"
			? resolve(runtimeLock.root).toLowerCase() !== resolve(root).toLowerCase()
			: resolve(runtimeLock.root) !== resolve(root))
	) {
		throw new Error("Cloud company merge recovery lock belongs to another company");
	}
	const lock = runtimeLock ?? claimCompanyRuntimeLock(root);
	try {
		const transactionParent = join(root, ".qorpera", "w");
		let entries: Dirent[];
		try {
			entries = await readdir(transactionParent, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("cloud-merge-")) continue;
			const transactionRoot = join(transactionParent, entry.name);
			const journalPath = join(transactionRoot, "journal.json");
			if (!(await pathExists(journalPath))) {
				await rm(transactionRoot, { recursive: true, force: true });
				continue;
			}
			const journal = await readMergeJournal(journalPath, root);
			if (await pathExists(join(transactionRoot, "committed"))) {
				const physical = await inspectPhysicalTree(root);
				if (
					physicalTreeMatchesManifest(physical, {
						schema: "qorpera.company-tree/v1",
						contractVersion: 3,
						omittedLayers: [],
						entries: journal.resultEntries,
					})
				) {
					await rm(transactionRoot, { recursive: true, force: true });
					continue;
				}
			}
			await recoverMergeTransaction(root, transactionRoot, journal);
			const physical = await inspectPhysicalTree(root);
			if (
				!physicalTreeMatchesManifest(physical, {
					schema: "qorpera.company-tree/v1",
					contractVersion: 3,
					omittedLayers: [],
					entries: journal.localEntries,
				})
			) {
				throw new Error("Interrupted Company File merge could not be rolled back exactly");
			}
			await rm(transactionRoot, { recursive: true, force: true });
		}
	} finally {
		if (!runtimeLock) releaseCompanyRuntimeLock(lock);
	}
}

async function applyPlannedMerge(
	input: MergeCloudCompanySnapshotsInput,
	planned: PlannedCloudCompanyMerge,
): Promise<void> {
	const root = canonicalCompanyRoot(input.companyRoot);
	await recoverInterruptedCloudCompanyMerges(root, input.runtimeLock);
	validateCloudCompanyTreeEntries(planned.resultEntries);
	const local = entryMap(planned.localManifest.entries);
	const result = entryMap(planned.resultEntries);
	const transaction = await stageChangedFiles(root, input.profileId, local, result, input.objects);
	const installedFiles: string[] = [];
	const suppliedLock = input.runtimeLock;
	if (
		suppliedLock &&
		(process.platform === "win32"
			? resolve(suppliedLock.root).toLowerCase() !== resolve(root).toLowerCase()
			: resolve(suppliedLock.root) !== resolve(root))
	) {
		await rm(transaction.transactionRoot, { recursive: true, force: true });
		throw new Error("Cloud company merge lock belongs to another company");
	}
	const lock = suppliedLock ?? claimCompanyRuntimeLock(root);
	let released = suppliedLock !== undefined;
	let transactionCanBeRemoved = false;
	try {
		if (!physicalTreeMatchesManifest(await inspectPhysicalTree(root), planned.localManifest)) {
			throw new Error("Company files changed after their last cloud checkpoint; publish them before merging");
		}
		await writeMergeJournal(transaction.transactionRoot, root, planned.localManifest.entries, planned.resultEntries);
		for (const [path, entry] of local) {
			if (entry.kind !== "file" || sameEntry(entry, result.get(path))) continue;
			const backup = logicalPath(transaction.backupRoot, path);
			await mkdir(dirname(backup), { recursive: true });
			await rename(logicalPath(root, path), backup);
		}
		const directoriesToRemove = [...local.values()]
			.filter((entry) => entry.kind === "directory" && result.get(entry.path)?.kind !== "directory")
			.map((entry) => entry.path)
			.sort((left, right) => right.split("/").length - left.split("/").length);
		for (const path of directoriesToRemove) {
			try {
				await rmdir(logicalPath(root, path));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (
					result.has(path) ||
					(code !== "ENOTEMPTY" && code !== "EEXIST") ||
					!(await moveOmittedDirectory(root, path, transaction.omittedBackupRoot))
				) {
					throw error;
				}
			}
		}
		const directoriesToCreate = [...result.values()]
			.filter((entry) => entry.kind === "directory" && local.get(entry.path)?.kind !== "directory")
			.map((entry) => entry.path)
			.sort((left, right) => left.split("/").length - right.split("/").length);
		for (const path of directoriesToCreate) await mkdir(logicalPath(root, path), { recursive: true });
		for (const [path, entry] of result) {
			if (entry.kind !== "file" || sameEntry(local.get(path), entry)) continue;
			const target = logicalPath(root, path);
			await mkdir(dirname(target), { recursive: true });
			await rename(logicalPath(transaction.stagedRoot, path), target);
			installedFiles.push(path);
		}
		if (
			!physicalTreeMatchesManifest(await inspectPhysicalTree(root), {
				schema: "qorpera.company-tree/v1",
				contractVersion: 3,
				omittedLayers: [],
				entries: planned.resultEntries,
			})
		) {
			throw new Error("Company File merge did not install the planned tree exactly");
		}
		await writeMergeCommitMarker(transaction.transactionRoot);
		if (!suppliedLock) {
			releaseCompanyRuntimeLock(lock);
			released = true;
		}
		transactionCanBeRemoved = true;
	} catch (error) {
		let rollbackError: unknown;
		try {
			await rollbackMerge(
				root,
				transaction.backupRoot,
				transaction.omittedBackupRoot,
				installedFiles,
				planned.localManifest.entries,
				planned.resultEntries,
			);
		} catch (caught) {
			rollbackError = caught;
		}
		if (!released && !suppliedLock) {
			releaseCompanyRuntimeLock(lock);
			released = true;
		}
		if (rollbackError) {
			throw new AggregateError([error, rollbackError], "Cloud company merge failed and rollback needs attention");
		}
		transactionCanBeRemoved = true;
		throw error;
	} finally {
		if (!released && !suppliedLock) releaseCompanyRuntimeLock(lock);
		if (transactionCanBeRemoved) await rm(transaction.transactionRoot, { recursive: true, force: true });
	}
}

export async function previewCloudCompanySnapshot(
	input: PreviewCloudCompanySnapshotInput,
): Promise<PreviewCloudCompanySnapshotResult> {
	if (input.snapshot.profileId !== input.profileId) throw new Error("Cloud company snapshot is outside this profile");
	const previewsRoot = join(input.userData, "cloud-company-previews");
	const destination = join(previewsRoot, randomUUID());
	await mkdir(previewsRoot, { recursive: true });
	try {
		await materializeCloudCompanyTree(
			destination,
			input.profileId,
			currentCloudCompanyTreeReference(input.snapshot.tree),
			input.objects,
		);
		return {
			path: destination,
			snapshotId: input.snapshot.snapshotId,
			fileCount: input.snapshot.tree.fileCount,
			totalBytes: input.snapshot.tree.totalBytes,
		};
	} catch (error) {
		await rm(destination, { recursive: true, force: true });
		throw error;
	}
}

export async function mergeCloudCompanySnapshots(
	input: MergeCloudCompanySnapshotsInput,
): Promise<MergeCloudCompanySnapshotsResult> {
	const planned = await planCloudCompanyMerge(input);
	if (planned.plan.conflicts.length > 0) {
		return { applied: false, plan: planned.plan };
	}
	if (planned.plan.changedPaths.length === 0) {
		return { applied: false, plan: planned.plan };
	}
	await applyPlannedMerge(input, planned);
	return { applied: true, plan: planned.plan };
}

/** Materializes the complete three-way result for an explicit human review.
 * Conflicting proposal bytes stay in place. Immutable conflict evidence is
 * materialized by the proposal-review layer outside the logical Company File,
 * so review metadata can never collide with or publish as company content. */
export async function mergeCloudCompanySnapshotsForReview(
	input: MergeCloudCompanySnapshotsInput,
): Promise<MergeCloudCompanySnapshotsResult> {
	const planned = await planCloudCompanyMerge(input);
	if (planned.plan.changedPaths.length === 0) return { applied: false, plan: planned.plan };
	await applyPlannedMerge(input, planned);
	return { applied: true, plan: planned.plan };
}

/** Three-way reconciles unpublished cache changes against a newer canonical
 * Company File head. This is deliberately separate from workspace merging:
 * the local candidate is a content-addressed tree, not another cloud head. */
export async function reconcileCloudCompanyCache(
	input: ReconcileCloudCompanyCacheInput,
): Promise<MergeCloudCompanySnapshotsResult> {
	const [base, remote, localLineage, remoteLineage] = await Promise.all([
		input.primary.getCompanySnapshot(input.baseSnapshotId),
		input.primary.getCompanySnapshot(input.remoteSnapshotId),
		snapshotLineage(input.baseSnapshotId, input.profileId, input.environmentId, input.primary),
		snapshotLineage(input.remoteSnapshotId, input.profileId, input.environmentId, input.primary),
	]);
	assertSnapshotScope(base, input.profileId, input.environmentId);
	assertSnapshotScope(remote, input.profileId, input.environmentId);
	const ancestorSnapshotId = [...remoteLineage.keys()].find((snapshotId) => localLineage.has(snapshotId));
	if (!ancestorSnapshotId) throw new Error("Canonical Company File and legacy cache have no common ancestor");
	const ancestor = localLineage.get(ancestorSnapshotId) as HostedCompanySnapshot;
	const [baseManifest, localManifest, remoteManifest] = await Promise.all([
		readCloudCompanyTreeManifest(input.profileId, currentCloudCompanyTreeReference(ancestor.tree), input.objects),
		readCloudCompanyTreeManifest(input.profileId, input.localTree, input.objects),
		readCloudCompanyTreeManifest(input.profileId, currentCloudCompanyTreeReference(remote.tree), input.objects),
	]);
	const planned = buildMergePlan(
		ancestor.snapshotId,
		input.localTree.manifestSha256,
		remote.snapshotId,
		baseManifest,
		localManifest,
		remoteManifest,
	);
	if (planned.plan.changedPaths.length === 0) {
		return { applied: false, plan: planned.plan };
	}
	await applyPlannedMerge(
		{
			companyRoot: input.companyRoot,
			profileId: input.profileId,
			environmentId: input.environmentId,
			localSnapshotId: input.baseSnapshotId,
			remoteSnapshotId: input.remoteSnapshotId,
			primary: input.primary,
			objects: input.objects,
			...(input.runtimeLock ? { runtimeLock: input.runtimeLock } : {}),
		},
		planned,
	);
	return { applied: true, plan: planned.plan };
}

/** Applies the reviewed cloud side only at paths that actually conflicted.
 * The stored merged local tree is an exact precondition, so unrelated local
 * and cloud changes survive either conflict decision. */
export async function replaceCloudCompanyCacheWithSnapshot(input: ReplaceCloudCompanyCacheInput): Promise<void> {
	assertSnapshotScope(input.remoteSnapshot, input.profileId, input.environmentId);
	if (input.conflictPaths.length < 1 || input.conflictPaths.some((path) => !path || path.startsWith("/"))) {
		throw new Error("Company File conflict paths are invalid");
	}
	const [localManifest, remoteManifest] = await Promise.all([
		readCloudCompanyTreeManifest(input.profileId, input.localTree, input.objects),
		readCloudCompanyTreeManifest(
			input.profileId,
			currentCloudCompanyTreeReference(input.remoteSnapshot.tree),
			input.objects,
		),
	]);
	const localEntries = entryMap(localManifest.entries);
	const remoteEntries = entryMap(remoteManifest.entries);
	const resultEntries = new Map(localEntries);
	for (const conflictPath of [...new Set(input.conflictPaths)]) {
		for (const path of resultEntries.keys()) {
			if (path === conflictPath || path.startsWith(`${conflictPath}/`)) resultEntries.delete(path);
		}
		for (const [path, entry] of remoteEntries) {
			if (path === conflictPath || path.startsWith(`${conflictPath}/`)) resultEntries.set(path, entry);
		}
	}
	const result = [...resultEntries.values()].sort((left, right) => comparePath(left.path, right.path));
	const changedPaths = [...new Set([...localEntries.keys(), ...resultEntries.keys()])]
		.filter((path) => !sameEntry(localEntries.get(path), resultEntries.get(path)))
		.sort(comparePath);
	if (changedPaths.length === 0) return;
	await applyPlannedMerge(
		{
			companyRoot: input.companyRoot,
			profileId: input.profileId,
			environmentId: input.environmentId,
			localSnapshotId: input.localTree.manifestSha256,
			remoteSnapshotId: input.remoteSnapshot.snapshotId,
			primary: {
				getCompanySnapshot: async () => input.remoteSnapshot,
			},
			objects: input.objects,
			...(input.runtimeLock ? { runtimeLock: input.runtimeLock } : {}),
		},
		{
			plan: {
				ancestorSnapshotId: input.remoteSnapshot.parentSnapshotId ?? input.remoteSnapshot.snapshotId,
				localSnapshotId: input.localTree.manifestSha256,
				remoteSnapshotId: input.remoteSnapshot.snapshotId,
				changedPaths,
				conflicts: [],
			},
			localManifest,
			resultEntries: result,
		},
	);
}
