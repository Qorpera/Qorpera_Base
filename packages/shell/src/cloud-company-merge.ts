import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	type CompanyRuntimeLock,
	canonicalCompanyRoot,
	claimCompanyRuntimeLock,
	releaseCompanyRuntimeLock,
} from "@qorpera/pi-coding-agent/company";
import {
	type CloudCompanyTreeEntry,
	type CloudCompanyTreeManifest,
	cloudCompanyPathBelongsToLogicalTree,
	currentCloudCompanyTreeReference,
	materializeCloudCompanyTree,
	readCloudCompanyTreeManifest,
} from "./cloud-company-snapshot.ts";
import type { CompanyWorkspacePrimary } from "./cloud-company-workspace.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { HostedCompanySnapshot } from "./hosted-primary.ts";

const MAX_SNAPSHOT_LINEAGE = 10_000;

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

function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameEntry(left: CloudCompanyTreeEntry | undefined, right: CloudCompanyTreeEntry | undefined): boolean {
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

function entryMap(entries: CloudCompanyTreeEntry[]): Map<string, CloudCompanyTreeEntry> {
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
	const resultEntries = [...result.values()].sort((left, right) => comparePath(left.path, right.path));
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
		resultEntries,
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
): Promise<{ transactionRoot: string; stagedRoot: string; backupRoot: string }> {
	const transactionRoot = join(root, ".qorpera", "w", `cloud-merge-${randomUUID()}`);
	if (cloudCompanyPathBelongsToLogicalTree(relative(root, transactionRoot))) {
		throw new Error("Cloud company merge transaction path is not isolated");
	}
	const stagedRoot = join(transactionRoot, "staged");
	const backupRoot = join(transactionRoot, "backup");
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
	return { transactionRoot, stagedRoot, backupRoot };
}

async function rollbackMerge(
	root: string,
	backupRoot: string,
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

async function applyPlannedMerge(
	input: MergeCloudCompanySnapshotsInput,
	planned: PlannedCloudCompanyMerge,
): Promise<void> {
	const root = canonicalCompanyRoot(input.companyRoot);
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
	try {
		if (!physicalTreeMatchesManifest(await inspectPhysicalTree(root), planned.localManifest)) {
			throw new Error("Company files changed after their last cloud checkpoint; publish them before merging");
		}
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
		for (const path of directoriesToRemove) await rmdir(logicalPath(root, path));
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
		if (!suppliedLock) {
			releaseCompanyRuntimeLock(lock);
			released = true;
		}
	} catch (error) {
		let rollbackError: unknown;
		try {
			await rollbackMerge(
				root,
				transaction.backupRoot,
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
		throw error;
	} finally {
		if (!released && !suppliedLock) releaseCompanyRuntimeLock(lock);
		await rm(transaction.transactionRoot, { recursive: true, force: true });
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
	if (planned.plan.conflicts.length > 0 || planned.plan.changedPaths.length === 0) {
		return { applied: false, plan: planned.plan };
	}
	await applyPlannedMerge(input, planned);
	return { applied: true, plan: planned.plan };
}
