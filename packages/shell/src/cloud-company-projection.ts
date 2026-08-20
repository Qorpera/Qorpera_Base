import { createHash, randomUUID } from "node:crypto";
import { type Dirent, existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type CompanyRuntimeLock, canonicalCompanyRoot } from "@qorpera/pi-coding-agent/company";
import { cloudCompanyPathBelongsToLogicalTree } from "./cloud-company-snapshot.ts";
import { type CloudSyncHealth, DurableCloudSyncLoop } from "./cloud-sync-loop.ts";

const PROJECTION_STATE_SCHEMA = "qorpera.company-file-projection/v1";

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

function normalized(path: string): string {
	return path.split(sep).join("/");
}

function projectionVisible(path: string): boolean {
	return !path.startsWith(".qorpera/") && path !== ".qorpera" && cloudCompanyPathBelongsToLogicalTree(path);
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
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
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
		if (entry.kind === "file") await rm(targetPath(destinationRoot, entry.path), { force: true });
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

async function applyDelta(
	projectionRoot: string,
	companyRoot: string,
	base: Map<string, ProjectionEntry>,
	desired: Map<string, ProjectionEntry>,
	canonical: Map<string, ProjectionEntry>,
): Promise<void> {
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

	for (const path of [...changed].sort((left, right) => right.length - left.length)) {
		const before = canonical.get(path);
		const after = desired.get(path);
		if (sameEntry(before, after) || before?.kind !== "file" || after?.kind === "file") continue;
		await rm(targetPath(companyRoot, path), { force: true });
	}
	for (const path of changed) {
		const after = desired.get(path);
		if (after?.kind === "directory") await mkdir(targetPath(companyRoot, path), { recursive: true });
	}
	for (const path of changed) {
		const after = desired.get(path);
		if (after?.kind === "file" && !sameEntry(canonical.get(path), after)) {
			await copyFile(projectionRoot, companyRoot, after);
		}
	}
	for (const path of [...changed].sort((left, right) => right.length - left.length)) {
		if (desired.has(path) || base.get(path)?.kind !== "directory") continue;
		try {
			await rmdir(targetPath(companyRoot, path));
		} catch (error) {
			if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
}

export class CloudCompanyProjection {
	readonly #companyRoot: string;
	readonly #projectionRoot: string;
	readonly #profileId: string;
	readonly #statePath: string;
	readonly #canWrite: () => boolean;
	readonly #onChanged: () => Promise<void>;
	readonly #beforeImportApply?: () => Promise<void>;
	readonly #runtimeLock: CompanyRuntimeLock;
	readonly #syncLoop: DurableCloudSyncLoop;
	#base?: Map<string, ProjectionEntry>;
	#watcher?: FSWatcher;
	#debounce?: ReturnType<typeof setTimeout>;
	#recovered = false;
	#dirty = true;

	constructor(options: {
		companyRoot: string;
		projectionRoot: string;
		userData: string;
		profileId: string;
		canWrite: () => boolean;
		onChanged: () => Promise<void>;
		beforeImportApply?: () => Promise<void>;
		onHealth?: (health: CloudSyncHealth) => void;
		runtimeLock: CompanyRuntimeLock;
	}) {
		this.#companyRoot = canonicalCompanyRoot(options.companyRoot);
		this.#projectionRoot = resolve(options.projectionRoot);
		this.#profileId = options.profileId;
		this.#statePath = statePath(options.userData, options.profileId, this.#companyRoot);
		this.#canWrite = options.canWrite;
		this.#onChanged = options.onChanged;
		this.#beforeImportApply = options.beforeImportApply;
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
				await this.#recover();
				if (!this.hasPendingChanges()) return;
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

	async #recover(): Promise<void> {
		if (this.#recovered) return;
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
			base: [...base.values()].sort((left, right) => left.path.localeCompare(right.path, "en")),
		});
		this.#base = base;
	}

	async refresh(): Promise<void> {
		await this.#recover();
		if (this.hasPendingChanges()) {
			throw new Error("Company File has pending Explorer changes that must be imported first");
		}
		this.#watcher ??= watch(this.#projectionRoot, { recursive: true }, () => {
			this.#dirty = true;
			if (this.#debounce) clearTimeout(this.#debounce);
			this.#debounce = setTimeout(() => {
				this.#debounce = undefined;
				void this.#syncLoop.trigger();
			}, 500);
			this.#debounce.unref?.();
		});
		this.#syncLoop.start();
		const source = await inspect(this.#companyRoot, false);
		await mirrorExact(this.#companyRoot, this.#projectionRoot, source);
		await this.#saveBase(source);
		this.#dirty = !sameSnapshot(await inspect(this.#projectionRoot, true), source);
		if (this.#dirty) {
			throw new Error("Company File Explorer changed while its checkout was refreshing");
		}
	}

	async importChanges(): Promise<void> {
		if (!this.#canWrite()) throw new Error("This Company File is read-only for your account");
		if (canonicalCompanyRoot(this.#runtimeLock.root) !== this.#companyRoot) {
			throw new Error("Company File projection lock belongs to another company");
		}
		await this.#recover();
		const base = this.#base ?? new Map<string, ProjectionEntry>();
		const desired = await inspect(this.#projectionRoot, true);
		if (sameSnapshot(base, desired)) {
			this.#dirty = false;
			return;
		}
		const canonical = await inspect(this.#companyRoot, false);
		await this.#beforeImportApply?.();
		await applyDelta(this.#projectionRoot, this.#companyRoot, base, desired, canonical);
		await this.#saveBase(desired);
		this.#dirty = !sameSnapshot(await inspect(this.#projectionRoot, true), desired);
	}

	async #discardChanges(): Promise<void> {
		const source = await inspect(this.#companyRoot, false);
		await mirrorExact(this.#companyRoot, this.#projectionRoot, source);
		await this.#saveBase(source);
		this.#dirty = !sameSnapshot(await inspect(this.#projectionRoot, true), source);
		if (this.#dirty) throw new Error("Company File Explorer changed while read-only edits were being discarded");
	}

	close(): void {
		if (this.#debounce) clearTimeout(this.#debounce);
		this.#debounce = undefined;
		this.#syncLoop.stop();
		this.#watcher?.close();
		this.#watcher = undefined;
	}
}
