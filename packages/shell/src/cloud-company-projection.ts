import { createHash, randomUUID } from "node:crypto";
import {
	type Dirent,
	existsSync,
	type FSWatcher,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	cloudCompanyPathBelongsToLogicalTree,
	cloudCompanyPathIsAuthorityCritical,
} from "@qorpera/cloud-client/node/cloud-company-snapshot";
import { type CompanyRuntimeLock, canonicalCompanyRoot } from "@qorpera/company/company-runtime-lock";
import { type CloudSyncHealth, DurableCloudSyncLoop } from "./cloud-sync-loop.ts";

const PROJECTION_STATE_SCHEMA = "qorpera.company-file-projection/v1";
const PROJECTION_REFRESH_SCHEMA = "qorpera.company-file-projection-refresh/v1";
const PROJECTION_IMPORT_SCHEMA = "qorpera.company-file-projection-import/v1";
const PROJECTION_DIRECTORY_NAME = "Company File (synced copy)";
const LEGACY_PROJECTION_DIRECTORY_NAME = "Company File";

interface ProjectionEntry {
	kind: "directory" | "file";
	path: string;
	executable?: boolean;
	sha256?: string;
}

interface ProjectionState {
	schema: typeof PROJECTION_STATE_SCHEMA;
	profileId: string;
	companyRoot: string;
	projectionRoot: string;
	base: ProjectionEntry[];
}

interface ProjectionRefreshTransaction {
	schema: typeof PROJECTION_REFRESH_SCHEMA;
	profileId: string;
	companyRoot: string;
	projectionRoot: string;
	stagingRoot: string;
	backupRoot: string;
	phase: "prepared" | "installed" | "base_saved";
	previousBase: ProjectionEntry[];
	nextBase: ProjectionEntry[];
}

interface ProjectionImportTransaction {
	schema: typeof PROJECTION_IMPORT_SCHEMA;
	profileId: string;
	companyRoot: string;
	projectionRoot: string;
	stagingRoot: string;
	backupRoot: string;
	phase: "prepared" | "applied" | "base_saved";
	roots: string[];
	previousBase: ProjectionEntry[];
	nextBase: ProjectionEntry[];
}

function normalized(path: string): string {
	return path.split(sep).join("/");
}

function projectionVisible(path: string): boolean {
	return (
		!path.startsWith(".qorpera/") &&
		path !== ".qorpera" &&
		!cloudCompanyPathIsAuthorityCritical(path) &&
		cloudCompanyPathBelongsToLogicalTree(path)
	);
}

function targetPath(root: string, path: string): string {
	const target = resolve(root, ...path.split("/"));
	const remainder = relative(root, target);
	if (!remainder || remainder === ".." || remainder.startsWith(`..${sep}`)) {
		throw new Error("Company File projection path escapes its root");
	}
	return target;
}

function statePath(userData: string, profileId: string, companyRoot: string): string {
	const identity = createHash("sha256").update(canonicalCompanyRoot(companyRoot)).digest("hex").slice(0, 24);
	return join(userData, "company-file-projections", `${profileId}-${identity}.json`);
}

export function cloudCompanyProjectionRoot(userData: string, profileId: string): string {
	return join(userData, "company-file-projections", profileId, PROJECTION_DIRECTORY_NAME);
}

function writeJsonAtomicSync(path: string, value: object): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function projectionRootWithHonestName(
	userData: string,
	profileId: string,
	companyRoot: string,
	requestedRoot: string,
): string {
	const requested = resolve(requestedRoot);
	if (basename(requested) !== PROJECTION_DIRECTORY_NAME) return requested;
	const legacy = join(dirname(requested), LEGACY_PROJECTION_DIRECTORY_NAME);
	const path = statePath(userData, profileId, companyRoot);
	const interrupted = existsSync(`${path}.refresh.json`) || existsSync(`${path}.import.json`);
	let state: Partial<ProjectionState> | undefined;
	let unreadableState = false;
	if (existsSync(path)) {
		try {
			state = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProjectionState>;
		} catch {
			unreadableState = true;
		}
	}

	if (existsSync(requested)) {
		if (existsSync(legacy)) throw new Error("Both current and legacy Company File synced copies exist");
		// Recover a process stop after the directory rename but before the state
		// rewrite. The preserved old base proves this is the same projection.
		if (
			!interrupted &&
			state &&
			!parseState(state, profileId, companyRoot, requested) &&
			parseState(state, profileId, companyRoot, legacy)
		) {
			writeJsonAtomicSync(path, { ...state, projectionRoot: requested });
		}
		return requested;
	}
	if (!existsSync(legacy)) return requested;
	// Let the old path finish crash recovery first. A later open migrates it.
	if (interrupted || unreadableState) return legacy;
	if (state && !parseState(state, profileId, companyRoot, legacy)) return legacy;

	try {
		renameSync(legacy, requested);
	} catch (error) {
		if (new Set(["EACCES", "EPERM"]).has((error as NodeJS.ErrnoException).code ?? "")) return legacy;
		throw error;
	}
	if (state) writeJsonAtomicSync(path, { ...state, projectionRoot: requested });
	return requested;
}

function sameEntry(left: ProjectionEntry | undefined, right: ProjectionEntry | undefined): boolean {
	return (
		left?.kind === right?.kind &&
		left?.path === right?.path &&
		left?.executable === right?.executable &&
		left?.sha256 === right?.sha256
	);
}

function sameSnapshot(left: Map<string, ProjectionEntry>, right: Map<string, ProjectionEntry>): boolean {
	if (left.size !== right.size) return false;
	for (const [path, entry] of left) {
		if (!sameEntry(entry, right.get(path))) return false;
	}
	return true;
}

function parseState(
	value: unknown,
	profileId: string,
	companyRoot: string,
	projectionRoot: string,
): Map<string, ProjectionEntry> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<ProjectionState>;
	if (
		input.schema !== PROJECTION_STATE_SCHEMA ||
		input.profileId !== profileId ||
		input.companyRoot !== canonicalCompanyRoot(companyRoot) ||
		input.projectionRoot !== resolve(projectionRoot) ||
		!Array.isArray(input.base)
	) {
		return undefined;
	}
	const base = new Map<string, ProjectionEntry>();
	for (const candidate of input.base) {
		if (
			!candidate ||
			typeof candidate !== "object" ||
			(candidate.kind !== "directory" && candidate.kind !== "file") ||
			typeof candidate.path !== "string" ||
			!candidate.path ||
			!projectionVisible(candidate.path) ||
			base.has(candidate.path) ||
			(candidate.kind === "file" &&
				(typeof candidate.executable !== "boolean" || !/^[0-9a-f]{64}$/.test(candidate.sha256 ?? "")))
		) {
			return undefined;
		}
		base.set(candidate.path, { ...candidate });
	}
	return base;
}

async function inspect(root: string, cleanProjection: boolean): Promise<Map<string, ProjectionEntry>> {
	const result = new Map<string, ProjectionEntry>();
	const visit = async (directory: string): Promise<void> => {
		let children: Dirent[];
		try {
			children = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		children.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const child of children) {
			const absolute = join(directory, child.name);
			const path = normalized(relative(root, absolute));
			if (!projectionVisible(path)) {
				if (cleanProjection) await rm(absolute, { recursive: true, force: true });
				continue;
			}
			const entryStat = await lstat(absolute);
			if (entryStat.isSymbolicLink()) throw new Error(`Company File cannot contain links: ${path}`);
			if (child.isDirectory() && entryStat.isDirectory()) {
				result.set(path, { kind: "directory", path });
				await visit(absolute);
				continue;
			}
			if (!child.isFile() || !entryStat.isFile() || entryStat.nlink !== 1) {
				throw new Error(`Company File can contain only physical files and folders: ${path}`);
			}
			result.set(path, {
				kind: "file",
				path,
				executable: (entryStat.mode & 0o111) !== 0,
				sha256: createHash("sha256")
					.update(await readFile(absolute))
					.digest("hex"),
			});
		}
	};
	await visit(root);
	return result;
}

async function writeState(path: string, state: ProjectionState): Promise<void> {
	await writeJsonAtomic(path, state);
}

async function writeJsonAtomic(path: string, value: object): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

function entriesMap(entries: ProjectionEntry[]): Map<string, ProjectionEntry> {
	return new Map(entries.map((entry) => [entry.path, { ...entry }]));
}

function sortedEntries(entries: Map<string, ProjectionEntry>): ProjectionEntry[] {
	return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function ownedRefreshPath(projectionRoot: string, candidate: string): boolean {
	const resolvedProjection = resolve(projectionRoot);
	const resolvedCandidate = resolve(candidate);
	return (
		dirname(resolvedCandidate) === dirname(resolvedProjection) &&
		basename(resolvedCandidate).startsWith(`${basename(resolvedProjection)}.qorpera-refresh-`)
	);
}

function ownedImportPath(projectionRoot: string, candidate: string): boolean {
	const resolvedProjection = resolve(projectionRoot);
	const resolvedCandidate = resolve(candidate);
	return (
		dirname(resolvedCandidate) === dirname(resolvedProjection) &&
		basename(resolvedCandidate).startsWith(`${basename(resolvedProjection)}.qorpera-import-`)
	);
}

async function copyFile(sourceRoot: string, destinationRoot: string, entry: ProjectionEntry): Promise<void> {
	const destination = targetPath(destinationRoot, entry.path);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, await readFile(targetPath(sourceRoot, entry.path)));
	if (process.platform !== "win32") await chmod(destination, entry.executable ? 0o755 : 0o644);
}

async function mirrorExact(
	sourceRoot: string,
	destinationRoot: string,
	source: Map<string, ProjectionEntry>,
): Promise<void> {
	await mkdir(destinationRoot, { recursive: true });
	const destination = await inspect(destinationRoot, true);
	for (const entry of [...destination.values()].sort((left, right) => right.path.length - left.path.length)) {
		const wanted = source.get(entry.path);
		if (wanted && wanted.kind === entry.kind) continue;
		await rm(targetPath(destinationRoot, entry.path), { recursive: true, force: true });
	}
	for (const entry of [...source.values()].filter((candidate) => candidate.kind === "directory")) {
		await mkdir(targetPath(destinationRoot, entry.path), { recursive: true });
	}
	for (const entry of source.values()) {
		if (entry.kind !== "file") continue;
		if (sameEntry(entry, destination.get(entry.path))) continue;
		await copyFile(sourceRoot, destinationRoot, entry);
	}
	for (const entry of [...destination.values()].sort((left, right) => right.path.length - left.path.length)) {
		if (entry.kind !== "directory" || source.has(entry.path)) continue;
		try {
			await rmdir(targetPath(destinationRoot, entry.path));
		} catch (error) {
			if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
}

function changedPaths(base: Map<string, ProjectionEntry>, desired: Map<string, ProjectionEntry>): string[] {
	return [...new Set([...base.keys(), ...desired.keys()])]
		.filter((path) => !sameEntry(base.get(path), desired.get(path)))
		.sort((left, right) => left.localeCompare(right, "en"));
}

function entriesBelowRoots(
	entries: Map<string, ProjectionEntry>,
	roots: readonly string[],
): Map<string, ProjectionEntry> {
	return new Map([...entries].filter(([path]) => roots.some((root) => path === root || path.startsWith(`${root}/`))));
}

function deltaRoots(changed: readonly string[]): string[] {
	return changed.filter(
		(path) => !changed.some((candidate) => candidate !== path && path.startsWith(`${candidate}/`)),
	);
}

function validateDelta(
	base: Map<string, ProjectionEntry>,
	desired: Map<string, ProjectionEntry>,
	canonical: Map<string, ProjectionEntry>,
): string[] {
	const changed = changedPaths(base, desired);
	const conflicts = changed.filter((path) => {
		const current = canonical.get(path);
		return !sameEntry(current, base.get(path)) && !sameEntry(current, desired.get(path));
	});
	for (const path of changed) {
		const before = base.get(path);
		const after = desired.get(path);
		if (before?.kind !== "directory" || after?.kind === "directory") continue;
		const prefix = `${path}/`;
		if (
			[...canonical.keys()].some(
				(candidate) => candidate.startsWith(prefix) && !sameEntry(canonical.get(candidate), base.get(candidate)),
			)
		) {
			conflicts.push(path);
		}
	}
	const uniqueConflicts = [...new Set(conflicts)].sort((left, right) => left.localeCompare(right, "en"));
	if (uniqueConflicts.length > 0) {
		throw new Error(`Company File Explorer changes conflict with newer company work: ${uniqueConflicts.join(", ")}`);
	}
	return changed;
}

async function installRoots(
	sourceRoot: string,
	destinationRoot: string,
	roots: readonly string[],
	source: Map<string, ProjectionEntry>,
	afterRoot?: (root: string) => Promise<void>,
): Promise<void> {
	for (const root of [...roots].sort((left, right) => right.length - left.length)) {
		await rm(targetPath(destinationRoot, root), { recursive: true, force: true });
	}
	for (const root of roots) {
		const rootEntries = entriesBelowRoots(source, [root]);
		for (const entry of [...rootEntries.values()].filter((candidate) => candidate.kind === "directory")) {
			await mkdir(targetPath(destinationRoot, entry.path), { recursive: true });
		}
		for (const entry of rootEntries.values()) {
			if (entry.kind === "file") await copyFile(sourceRoot, destinationRoot, entry);
		}
		await afterRoot?.(root);
	}
}

export class CloudCompanyProjection {
	readonly #companyRoot: string;
	readonly #projectionRoot: string;
	readonly #profileId: string;
	readonly #statePath: string;
	readonly #refreshStatePath: string;
	readonly #importStatePath: string;
	readonly #canWrite: () => boolean;
	readonly #onChanged: () => Promise<void>;
	readonly #beforeImportApply?: () => Promise<void>;
	readonly #afterImportRootApply?: (root: string) => Promise<void>;
	readonly #beforeRefreshCommit?: () => Promise<void>;
	readonly #beforeRefreshInstall?: () => Promise<void>;
	readonly #runtimeLock: CompanyRuntimeLock;
	readonly #syncLoop: DurableCloudSyncLoop;
	#base?: Map<string, ProjectionEntry>;
	#watcher?: FSWatcher;
	#debounce?: ReturnType<typeof setTimeout>;
	#recovered = false;
	#dirty = true;
	#watchGeneration = 0;
	#operationTail: Promise<void> = Promise.resolve();
	#closed = false;
	#closing?: Promise<void>;

	constructor(options: {
		companyRoot: string;
		projectionRoot: string;
		userData: string;
		profileId: string;
		canWrite: () => boolean;
		onChanged: () => Promise<void>;
		beforeImportApply?: () => Promise<void>;
		afterImportRootApply?: (root: string) => Promise<void>;
		beforeRefreshCommit?: () => Promise<void>;
		beforeRefreshInstall?: () => Promise<void>;
		onHealth?: (health: CloudSyncHealth) => void;
		runtimeLock: CompanyRuntimeLock;
	}) {
		this.#companyRoot = canonicalCompanyRoot(options.companyRoot);
		this.#profileId = options.profileId;
		this.#projectionRoot = projectionRootWithHonestName(
			options.userData,
			this.#profileId,
			this.#companyRoot,
			options.projectionRoot,
		);
		this.#statePath = statePath(options.userData, options.profileId, this.#companyRoot);
		this.#refreshStatePath = `${this.#statePath}.refresh.json`;
		this.#importStatePath = `${this.#statePath}.import.json`;
		this.#canWrite = options.canWrite;
		this.#onChanged = options.onChanged;
		this.#beforeImportApply = options.beforeImportApply;
		this.#afterImportRootApply = options.afterImportRootApply;
		this.#beforeRefreshCommit = options.beforeRefreshCommit;
		this.#beforeRefreshInstall = options.beforeRefreshInstall;
		this.#runtimeLock = options.runtimeLock;
		if (existsSync(this.#statePath)) {
			try {
				this.#base = parseState(
					JSON.parse(readFileSync(this.#statePath, "utf-8")),
					this.#profileId,
					this.#companyRoot,
					this.#projectionRoot,
				);
			} catch {
				this.#base = undefined;
			}
		}
		this.#syncLoop = new DurableCloudSyncLoop({
			root: this.#companyRoot,
			userData: options.userData,
			profileId: options.profileId,
			channel: "company-projection",
			steadyDelayMs: 5 * 60_000,
			onHealth: options.onHealth,
			sync: async () => {
				if (this.#closed) return;
				await this.#exclusive(async () => {
					await this.#recover();
					await this.#recheckDirty();
				});
				if (this.#closed || !this.hasPendingChanges()) return;
				if (!this.#canWrite()) {
					await this.#discardChanges();
					return;
				}
				await this.#onChanged();
				if (this.hasPendingChanges()) {
					throw new Error("Company File Explorer changed again while its prior edit was being imported");
				}
			},
		});
	}

	get path(): string {
		return this.#projectionRoot;
	}

	health(): CloudSyncHealth {
		return this.#syncLoop.health();
	}

	hasPendingChanges(): boolean {
		return this.#dirty;
	}

	async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closed) throw new Error("Company File projection is closed");
		let release: (() => void) | undefined;
		const previous = this.#operationTail;
		this.#operationTail = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		await previous;
		try {
			if (this.#closed) throw new Error("Company File projection is closed");
			return await operation();
		} finally {
			release?.();
		}
	}

	#scheduleSync(): void {
		if (this.#closed) return;
		if (this.#debounce) clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => {
			this.#debounce = undefined;
			void this.#syncLoop.trigger();
		}, 500);
		this.#debounce.unref?.();
	}

	#ensureWatcher(): void {
		if (this.#closed) return;
		this.#watcher ??= watch(this.#projectionRoot, { recursive: true }, () => {
			if (this.#closed) return;
			this.#watchGeneration += 1;
			this.#dirty = true;
			this.#scheduleSync();
		});
	}

	#closeWatcher(): void {
		this.#watcher?.close();
		this.#watcher = undefined;
	}

	async #recoverRefreshTransaction(): Promise<void> {
		if (!existsSync(this.#refreshStatePath)) return;
		let transaction: ProjectionRefreshTransaction;
		try {
			const parsed = JSON.parse(
				readFileSync(this.#refreshStatePath, "utf-8"),
			) as Partial<ProjectionRefreshTransaction>;
			if (
				parsed.schema !== PROJECTION_REFRESH_SCHEMA ||
				parsed.profileId !== this.#profileId ||
				parsed.companyRoot !== this.#companyRoot ||
				parsed.projectionRoot !== this.#projectionRoot ||
				typeof parsed.stagingRoot !== "string" ||
				typeof parsed.backupRoot !== "string" ||
				!ownedRefreshPath(this.#projectionRoot, parsed.stagingRoot) ||
				!ownedRefreshPath(this.#projectionRoot, parsed.backupRoot) ||
				!(["prepared", "installed", "base_saved"] as const).includes(
					parsed.phase as ProjectionRefreshTransaction["phase"],
				) ||
				!Array.isArray(parsed.previousBase) ||
				!Array.isArray(parsed.nextBase)
			) {
				throw new Error("Company File projection refresh transaction is invalid");
			}
			transaction = parsed as ProjectionRefreshTransaction;
		} catch (error) {
			throw new Error(
				`Company File projection refresh recovery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const previousBase = entriesMap(transaction.previousBase);
		const nextBase = entriesMap(transaction.nextBase);
		const projectionExists = existsSync(this.#projectionRoot);
		const current = projectionExists
			? await inspect(this.#projectionRoot, false)
			: new Map<string, ProjectionEntry>();
		const persistedNextBase = this.#base ? sameSnapshot(this.#base, nextBase) : false;
		if (transaction.phase === "prepared" && !existsSync(transaction.backupRoot)) {
			// The journal is durable before the first rename. With no backup, the
			// live projection is still the previous tree; it must never be treated
			// as an edit against the not-yet-installed cloud tree.
			if (!this.#base || !sameSnapshot(this.#base, previousBase)) await this.#saveBase(previousBase);
			await rm(transaction.stagingRoot, { recursive: true, force: true });
			await rm(this.#refreshStatePath, { force: true });
			return;
		}
		if (transaction.phase === "base_saved" || persistedNextBase) {
			if (!this.#base || !sameSnapshot(this.#base, nextBase)) await this.#saveBase(nextBase);
			await rm(transaction.stagingRoot, { recursive: true, force: true });
			await rm(transaction.backupRoot, { recursive: true, force: true });
			await rm(this.#refreshStatePath, { force: true });
			return;
		}

		if (projectionExists && !sameSnapshot(current, nextBase)) {
			// The installed tree received a real Explorer edit before the process
			// stopped. Keep that tree and record the cloud tree as its merge base.
			await this.#saveBase(nextBase);
			await rm(transaction.stagingRoot, { recursive: true, force: true });
			await rm(transaction.backupRoot, { recursive: true, force: true });
			await rm(this.#refreshStatePath, { force: true });
			return;
		}

		if (existsSync(transaction.backupRoot)) {
			await rm(this.#projectionRoot, { recursive: true, force: true });
			await rename(transaction.backupRoot, this.#projectionRoot);
			await this.#saveBase(previousBase);
		} else if (!projectionExists && existsSync(transaction.stagingRoot)) {
			await rename(transaction.stagingRoot, this.#projectionRoot);
			await this.#saveBase(nextBase);
		}
		await rm(transaction.stagingRoot, { recursive: true, force: true });
		await rm(transaction.backupRoot, { recursive: true, force: true });
		await rm(this.#refreshStatePath, { force: true });
	}

	async #installRefresh(source: Map<string, ProjectionEntry>, discardPending: boolean): Promise<boolean> {
		const token = randomUUID();
		const stagingRoot = `${this.#projectionRoot}.qorpera-refresh-${token}-staging`;
		const backupRoot = `${this.#projectionRoot}.qorpera-refresh-${token}-backup`;
		const previousBase = this.#base ?? new Map<string, ProjectionEntry>();
		const transaction: ProjectionRefreshTransaction = {
			schema: PROJECTION_REFRESH_SCHEMA,
			profileId: this.#profileId,
			companyRoot: this.#companyRoot,
			projectionRoot: this.#projectionRoot,
			stagingRoot,
			backupRoot,
			phase: "prepared",
			previousBase: sortedEntries(previousBase),
			nextBase: sortedEntries(source),
		};
		try {
			await mirrorExact(this.#companyRoot, stagingRoot, source);
			const staged = await inspect(stagingRoot, false);
			if (!sameSnapshot(staged, source)) throw new Error("Company File projection staging verification failed");
			await this.#beforeRefreshCommit?.();
			const current = await inspect(this.#projectionRoot, false);
			if (!discardPending && !sameSnapshot(current, previousBase)) {
				this.#dirty = true;
				return false;
			}

			await writeJsonAtomic(this.#refreshStatePath, transaction);
			await this.#beforeRefreshInstall?.();
			this.#closeWatcher();
			await rename(this.#projectionRoot, backupRoot);
			await rename(stagingRoot, this.#projectionRoot);
			transaction.phase = "installed";
			await writeJsonAtomic(this.#refreshStatePath, transaction);

			const replaced = await inspect(backupRoot, false);
			if (!discardPending && !sameSnapshot(replaced, previousBase)) {
				// An Explorer save landed between the final clean check and the
				// directory swap. Roll back to the edited tree instead of losing it.
				await rename(this.#projectionRoot, stagingRoot);
				await rename(backupRoot, this.#projectionRoot);
				await rm(stagingRoot, { recursive: true, force: true });
				await rm(this.#refreshStatePath, { force: true });
				this.#dirty = true;
				return false;
			}

			await this.#saveBase(source);
			transaction.phase = "base_saved";
			await writeJsonAtomic(this.#refreshStatePath, transaction);
			await rm(backupRoot, { recursive: true, force: true });
			await rm(this.#refreshStatePath, { force: true });
			return true;
		} catch (error) {
			await this.#recoverRefreshTransaction();
			throw error;
		} finally {
			await rm(stagingRoot, { recursive: true, force: true });
			await mkdir(this.#projectionRoot, { recursive: true });
			this.#ensureWatcher();
		}
	}

	async #recoverImportTransaction(): Promise<void> {
		if (!existsSync(this.#importStatePath)) return;
		let transaction: ProjectionImportTransaction;
		let previousBase: Map<string, ProjectionEntry>;
		let nextBase: Map<string, ProjectionEntry>;
		try {
			const parsed = JSON.parse(
				readFileSync(this.#importStatePath, "utf-8"),
			) as Partial<ProjectionImportTransaction>;
			if (
				parsed.schema !== PROJECTION_IMPORT_SCHEMA ||
				parsed.profileId !== this.#profileId ||
				parsed.companyRoot !== this.#companyRoot ||
				parsed.projectionRoot !== this.#projectionRoot ||
				typeof parsed.stagingRoot !== "string" ||
				typeof parsed.backupRoot !== "string" ||
				!ownedImportPath(this.#projectionRoot, parsed.stagingRoot) ||
				!ownedImportPath(this.#projectionRoot, parsed.backupRoot) ||
				!(["prepared", "applied", "base_saved"] as const).includes(
					parsed.phase as ProjectionImportTransaction["phase"],
				) ||
				!Array.isArray(parsed.roots) ||
				parsed.roots.length === 0 ||
				parsed.roots.some((root) => typeof root !== "string" || !projectionVisible(root)) ||
				new Set(parsed.roots).size !== parsed.roots.length ||
				!Array.isArray(parsed.previousBase) ||
				!Array.isArray(parsed.nextBase)
			) {
				throw new Error("Company File projection import transaction is invalid");
			}
			const parsedPreviousBase = parseState(
				{
					schema: PROJECTION_STATE_SCHEMA,
					profileId: this.#profileId,
					companyRoot: this.#companyRoot,
					projectionRoot: this.#projectionRoot,
					base: parsed.previousBase,
				},
				this.#profileId,
				this.#companyRoot,
				this.#projectionRoot,
			);
			const parsedNextBase = parseState(
				{
					schema: PROJECTION_STATE_SCHEMA,
					profileId: this.#profileId,
					companyRoot: this.#companyRoot,
					projectionRoot: this.#projectionRoot,
					base: parsed.nextBase,
				},
				this.#profileId,
				this.#companyRoot,
				this.#projectionRoot,
			);
			if (!parsedPreviousBase || !parsedNextBase) {
				throw new Error("Company File projection import bases are invalid");
			}
			previousBase = parsedPreviousBase;
			nextBase = parsedNextBase;
			transaction = parsed as ProjectionImportTransaction;
		} catch (error) {
			throw new Error(
				`Company File projection import recovery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (transaction.phase === "base_saved") {
			if (!this.#base || !sameSnapshot(this.#base, nextBase)) await this.#saveBase(nextBase);
		} else if (transaction.phase === "applied") {
			const canonical = await inspect(this.#companyRoot, false);
			if (
				sameSnapshot(
					entriesBelowRoots(canonical, transaction.roots),
					entriesBelowRoots(nextBase, transaction.roots),
				)
			) {
				await this.#saveBase(nextBase);
			} else {
				const backup = await inspect(transaction.backupRoot, false);
				await installRoots(transaction.backupRoot, this.#companyRoot, transaction.roots, backup);
				await this.#saveBase(previousBase);
			}
		} else {
			const backup = await inspect(transaction.backupRoot, false);
			await installRoots(transaction.backupRoot, this.#companyRoot, transaction.roots, backup);
			if (!this.#base || !sameSnapshot(this.#base, previousBase)) await this.#saveBase(previousBase);
		}
		await rm(transaction.stagingRoot, { recursive: true, force: true });
		await rm(transaction.backupRoot, { recursive: true, force: true });
		await rm(this.#importStatePath, { force: true });
	}

	async #installImport(
		base: Map<string, ProjectionEntry>,
		desired: Map<string, ProjectionEntry>,
		canonical: Map<string, ProjectionEntry>,
		changed: string[],
	): Promise<void> {
		const roots = deltaRoots(changed);
		const token = randomUUID();
		const stagingRoot = `${this.#projectionRoot}.qorpera-import-${token}-staging`;
		const backupRoot = `${this.#projectionRoot}.qorpera-import-${token}-backup`;
		const desiredDelta = entriesBelowRoots(desired, roots);
		const canonicalBackup = entriesBelowRoots(canonical, roots);
		const transaction: ProjectionImportTransaction = {
			schema: PROJECTION_IMPORT_SCHEMA,
			profileId: this.#profileId,
			companyRoot: this.#companyRoot,
			projectionRoot: this.#projectionRoot,
			stagingRoot,
			backupRoot,
			phase: "prepared",
			roots,
			previousBase: sortedEntries(base),
			nextBase: sortedEntries(desired),
		};
		try {
			await mirrorExact(this.#projectionRoot, stagingRoot, desiredDelta);
			await mirrorExact(this.#companyRoot, backupRoot, canonicalBackup);
			if (!sameSnapshot(await inspect(stagingRoot, false), desiredDelta)) {
				throw new Error("Company File Explorer import staging verification failed");
			}
			if (!sameSnapshot(await inspect(backupRoot, false), canonicalBackup)) {
				throw new Error("Company File Explorer import rollback verification failed");
			}
			await writeJsonAtomic(this.#importStatePath, transaction);
			await this.#beforeImportApply?.();
			await installRoots(stagingRoot, this.#companyRoot, roots, desiredDelta, this.#afterImportRootApply);
			if (!sameSnapshot(entriesBelowRoots(await inspect(this.#companyRoot, false), roots), desiredDelta)) {
				throw new Error("Company File Explorer import installation verification failed");
			}
			transaction.phase = "applied";
			await writeJsonAtomic(this.#importStatePath, transaction);
			await this.#saveBase(desired);
			transaction.phase = "base_saved";
			await writeJsonAtomic(this.#importStatePath, transaction);
			await rm(stagingRoot, { recursive: true, force: true });
			await rm(backupRoot, { recursive: true, force: true });
			await rm(this.#importStatePath, { force: true });
		} catch (error) {
			await this.#recoverImportTransaction();
			throw error;
		}
	}

	async #recover(): Promise<void> {
		if (this.#recovered) return;
		await this.#recoverImportTransaction();
		await this.#recoverRefreshTransaction();
		await mkdir(this.#projectionRoot, { recursive: true });
		const current = await inspect(this.#projectionRoot, true);
		if (!this.#base) {
			this.#base = new Map();
			this.#dirty = current.size > 0;
		} else {
			this.#dirty = !sameSnapshot(current, this.#base);
		}
		this.#recovered = true;
	}

	async #saveBase(base: Map<string, ProjectionEntry>): Promise<void> {
		await writeState(this.#statePath, {
			schema: PROJECTION_STATE_SCHEMA,
			profileId: this.#profileId,
			companyRoot: this.#companyRoot,
			projectionRoot: this.#projectionRoot,
			base: sortedEntries(base),
		});
		this.#base = base;
	}

	async #recheckDirty(): Promise<void> {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const generation = this.#watchGeneration;
			const current = await inspect(this.#projectionRoot, true);
			if (!sameSnapshot(current, this.#base ?? new Map())) {
				this.#dirty = true;
				return;
			}
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
			if (this.#watchGeneration === generation) {
				this.#dirty = false;
				return;
			}
		}
		this.#dirty = true;
	}

	async refresh(): Promise<void> {
		await this.#exclusive(async () => {
			await this.#recover();
			this.#ensureWatcher();
			this.#syncLoop.start();
			await this.#recheckDirty();
			if (this.hasPendingChanges()) {
				this.#scheduleSync();
				return;
			}
			const source = await inspect(this.#companyRoot, false);
			if (!(await this.#installRefresh(source, false))) {
				this.#scheduleSync();
				return;
			}
			await this.#recheckDirty();
			if (this.#dirty) {
				throw new Error("Company File Explorer changed while its checkout was refreshing");
			}
		});
	}

	async importChanges(): Promise<string[]> {
		return this.#exclusive(async () => {
			if (!this.#canWrite()) throw new Error("This Company File is read-only for your account");
			if (canonicalCompanyRoot(this.#runtimeLock.root) !== this.#companyRoot) {
				throw new Error("Company File projection lock belongs to another company");
			}
			await this.#recover();
			const base = this.#base ?? new Map<string, ProjectionEntry>();
			const desired = await inspect(this.#projectionRoot, true);
			if (sameSnapshot(base, desired)) {
				this.#dirty = false;
				return [];
			}
			const canonical = await inspect(this.#companyRoot, false);
			const changed = validateDelta(base, desired, canonical);
			await this.#installImport(base, desired, canonical, changed);
			await this.#recheckDirty();
			return changed;
		});
	}

	async #discardChanges(): Promise<void> {
		await this.#exclusive(async () => {
			await this.#recover();
			const source = await inspect(this.#companyRoot, false);
			await this.#installRefresh(source, true);
			await this.#recheckDirty();
			if (this.#dirty) throw new Error("Company File Explorer changed while read-only edits were being discarded");
		});
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		if (this.#debounce) clearTimeout(this.#debounce);
		this.#debounce = undefined;
		this.#closeWatcher();
		this.#closing = (async () => {
			try {
				await this.#syncLoop.close();
			} finally {
				// A health-write failure must not let the owner release the runtime lock
				// while an already-admitted projection transaction is still finishing.
				await this.#operationTail;
			}
		})();
		return this.#closing;
	}
}

export async function cloudCompanyProjectionHasPersistedChanges(options: {
	companyRoot: string;
	projectionRoot: string;
	userData: string;
	profileId: string;
}): Promise<boolean> {
	const companyRoot = canonicalCompanyRoot(options.companyRoot);
	const projectionRoot = projectionRootWithHonestName(
		options.userData,
		options.profileId,
		companyRoot,
		options.projectionRoot,
	);
	if (!existsSync(projectionRoot)) return false;
	const current = await inspect(projectionRoot, false);
	const path = statePath(options.userData, options.profileId, companyRoot);
	if (existsSync(`${path}.import.json`)) return true;
	if (!existsSync(path)) return current.size > 0;
	try {
		const base = parseState(JSON.parse(readFileSync(path, "utf-8")), options.profileId, companyRoot, projectionRoot);
		return !base || !sameSnapshot(current, base);
	} catch {
		return true;
	}
}
