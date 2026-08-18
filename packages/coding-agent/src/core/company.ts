/** Agents-only company storage and optional product/environment operations. */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	cpSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { getAgentDir } from "../config.ts";
import { spawnSync } from "../utils/child-process.ts";
import {
	bindCompanySecret,
	bindNetworkDestination,
	type CompanySecret,
	companyConnectionsPath,
	disableWebhook,
	enableWebhook,
	type OAuth2Secret,
	readCompanyConnections,
	readWebhookBinding,
	removeCompanySecret,
	removeNetworkDestination,
} from "./company-connections.ts";
import {
	generateFounderIdentity,
	readFounderIdentity,
	signAuthorityPolicy,
	signGateApproval,
} from "./founder-identity.ts";
import { runOAuthOnboarding } from "./oauth-onboarding.ts";
export const COMPANY_MANIFEST_SCHEMA = "qorpera.company/v1" as const;
export const COMPANY_MANIFEST_RELATIVE_PATH = join(".qorpera", "company.json");
const STAFF_REGISTRY_RELATIVE_PATH = join(".qorpera", "staff.json");

export interface CompanyManifestParent {
	companyId: string;
	state: string | null;
	forkedAt: string;
}

export interface CompanyManifest {
	schema: typeof COMPANY_MANIFEST_SCHEMA;
	id: string;
	name: string;
	createdAt: string;
	parent?: CompanyManifestParent;
}

const COMPANY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function manifestTimestamp(value: unknown, field: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new Error(`Company manifest ${field} is invalid`);
	}
	return value;
}

function parseCompanyManifest(value: unknown): CompanyManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Company manifest is invalid");
	const record = value as Record<string, unknown>;
	if (
		record.schema !== COMPANY_MANIFEST_SCHEMA ||
		typeof record.id !== "string" ||
		!COMPANY_ID_PATTERN.test(record.id) ||
		typeof record.name !== "string" ||
		record.name !== record.name.trim() ||
		!record.name ||
		record.name.includes("\0") ||
		Buffer.byteLength(record.name, "utf-8") > 160 ||
		Object.keys(record).some((key) => !["schema", "id", "name", "createdAt", "parent"].includes(key))
	) {
		throw new Error("Company manifest is invalid");
	}
	let parent: CompanyManifestParent | undefined;
	if (record.parent !== undefined) {
		if (!record.parent || typeof record.parent !== "object" || Array.isArray(record.parent)) {
			throw new Error("Company manifest parent is invalid");
		}
		const candidate = record.parent as Record<string, unknown>;
		if (
			typeof candidate.companyId !== "string" ||
			!COMPANY_ID_PATTERN.test(candidate.companyId) ||
			(candidate.state !== null &&
				(typeof candidate.state !== "string" || !/^[0-9a-f]{40,64}$/i.test(candidate.state))) ||
			Object.keys(candidate).some((key) => !["companyId", "state", "forkedAt"].includes(key))
		) {
			throw new Error("Company manifest parent is invalid");
		}
		parent = {
			companyId: candidate.companyId,
			state: candidate.state,
			forkedAt: manifestTimestamp(candidate.forkedAt, "parent.forkedAt"),
		};
	}
	return {
		schema: COMPANY_MANIFEST_SCHEMA,
		id: record.id,
		name: record.name,
		createdAt: manifestTimestamp(record.createdAt, "createdAt"),
		...(parent ? { parent } : {}),
	};
}

export function readCompanyManifest(rootDir: string): CompanyManifest {
	const root = canonicalCompanyRoot(rootDir);
	const path = join(root, COMPANY_MANIFEST_RELATIVE_PATH);
	storageIdentity(path, "file");
	return parseCompanyManifest(JSON.parse(readFileSync(path, "utf-8")) as unknown);
}

const PRODUCT_DEPARTMENT_GITIGNORE = `# Product Git data belongs to the product repository, not the company repository.
repository/
worktrees/
`;

const PULL_REQUESTS_README = `# Pull Requests

Local, synchronized pull-request read models for this product. Connectors or
department routines may write one JSON record per pull request here. The
product department UI reads these records; credentials never belong here.
`;

const PRODUCT_DEPARTMENT_KIND = "product-development";
const PRODUCT_REGISTRY_PATH = join(".qorpera", "products.json");
const PRODUCT_WORKTREE_ASSIGNMENTS_PATH = join(".qorpera", "product-worktrees");

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Resolve an existing company through aliases once, then use that physical identity everywhere. */
export function canonicalCompanyRoot(rootDir: string): string {
	return realpathSync(resolve(rootDir));
}

function canonicalDirectory(root: string, relativePath: string): string {
	const target = resolve(root, relativePath);
	const actual = realpathSync(target);
	if (normalizedPath(actual) !== normalizedPath(target) || !lstatSync(target).isDirectory()) {
		throw new Error(`Company storage must be a physical directory, not a link or junction: ${relativePath}`);
	}
	return actual;
}

export function assertPhysicalCompanyTree(rootDir: string, relativePath: string): string {
	const root = canonicalCompanyRoot(rootDir);
	const target = resolve(root, relativePath);
	const rootRelative = relative(root, target);
	if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative)) {
		throw new Error(`Company storage escaped its root: ${relativePath}`);
	}
	const visit = (path: string): void => {
		const entry = lstatSync(path);
		if (
			entry.isSymbolicLink() ||
			normalizedPath(realpathSync(path)) !== normalizedPath(path) ||
			(entry.isFile() && entry.nlink !== 1)
		) {
			throw new Error(`Company storage must be one physical entry: ${relativePath}`);
		}
		if (entry.isDirectory()) {
			for (const child of readdirSync(path)) visit(join(path, child));
		}
	};
	visit(target);
	return target;
}

export function validateCompanyHostStorage(rootDir: string): void {
	const root = canonicalCompanyRoot(rootDir);
	for (const directory of [".qorpera", "trail", "inbox", join("inbox", "messages"), "connectors", "agents", "files"]) {
		canonicalDirectory(root, directory);
	}
	for (const tree of ["trail", "inbox", "connectors", "agents", "files"]) assertPhysicalCompanyTree(root, tree);
	for (const file of [COMPANY_MANIFEST_RELATIVE_PATH, STAFF_REGISTRY_RELATIVE_PATH]) {
		storageIdentity(join(root, file), "file");
	}
	readCompanyManifest(root);
	if (existsSync(join(root, ".qorpera", "settings.json"))) {
		storageIdentity(join(root, ".qorpera", "settings.json"), "file");
	}
	if (existsSync(join(root, "authority.toml"))) storageIdentity(join(root, "authority.toml"), "file");
	const hasProductStorage = ["departments", PRODUCT_REGISTRY_PATH].some((path) => existsSync(join(root, path)));
	if (hasProductStorage) {
		canonicalDirectory(root, "departments");
		storageIdentity(join(root, PRODUCT_REGISTRY_PATH), "file");
	}
	for (const optionalTree of [
		join(".qorpera", "product-worktrees"),
		join(".qorpera", "product-integrations"),
		join(".qorpera", "w"),
	]) {
		if (existsSync(join(root, optionalTree))) assertPhysicalCompanyTree(root, optionalTree);
	}
}

interface StorageIdentity {
	path: string;
	device: string;
	inode: string;
	kind: "directory" | "file";
}

export interface ProductTransactionStorage {
	root: StorageIdentity;
	departments: StorageIdentity;
	qorpera: StorageIdentity;
	productRegistry: StorageIdentity;
}

function storageIdentity(path: string, kind: StorageIdentity["kind"]): StorageIdentity {
	const actual = realpathSync(path);
	const entry = lstatSync(path);
	if (
		normalizedPath(actual) !== normalizedPath(path) ||
		(kind === "directory" ? !entry.isDirectory() : !entry.isFile()) ||
		(kind === "file" && entry.nlink !== 1)
	) {
		throw new Error(`Company transaction ${kind} must be one physical entry: ${path}`);
	}
	const stats = statSync(path, { bigint: true });
	return { path, device: stats.dev.toString(), inode: stats.ino.toString(), kind };
}

/**
 * Bind a product transaction to the canonical company roots before review.
 * Rechecking the device/inode tuple prevents a reviewed directory from being
 * replaced with a junction before a later transaction write.
 */
export function captureProductTransactionStorage(rootDir: string): ProductTransactionStorage {
	const root = canonicalCompanyRoot(rootDir);
	materializeProductSpine(root);
	return {
		root: storageIdentity(root, "directory"),
		departments: storageIdentity(canonicalDirectory(root, "departments"), "directory"),
		qorpera: storageIdentity(canonicalDirectory(root, ".qorpera"), "directory"),
		productRegistry: storageIdentity(join(root, PRODUCT_REGISTRY_PATH), "file"),
	};
}

export function assertProductTransactionStorage(storage: ProductTransactionStorage): string {
	for (const identity of [storage.root, storage.departments, storage.qorpera, storage.productRegistry]) {
		const actual = storageIdentity(identity.path, identity.kind);
		if (
			normalizedPath(actual.path) !== normalizedPath(identity.path) ||
			actual.device !== identity.device ||
			actual.inode !== identity.inode
		) {
			throw new Error(`Company transaction storage changed after review: ${identity.path}`);
		}
	}
	return storage.root.path;
}

export function companyRuntimeLockPath(rootDir: string): string {
	const root = canonicalCompanyRoot(rootDir);
	const gitPath = spawnSync(
		"git",
		["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "qorpera-runtime-locks"],
		{ encoding: "utf-8", shell: false },
	);
	if (gitPath.status !== 0 || !gitPath.stdout.trim()) {
		throw new Error("company transaction requires a valid Git repository");
	}
	const id = createHash("sha256").update(normalizedPath(root)).digest("hex");
	return join(gitPath.stdout.trim(), `${id}.json`);
}

export interface CompanyRuntimeLock {
	path: string;
	root: string;
	token: string;
	processInstance: string;
	release: () => void;
}

interface CompanyLockRecord {
	version: 3;
	pid: number;
	processInstance: string;
	root: string;
	token: string;
	mode: "runtime" | "product-registration";
}

const ownedRuntimeLocks = new WeakSet<CompanyRuntimeLock>();
const lockHeartbeats = new WeakMap<CompanyRuntimeLock, Worker>();
const failedLockHeartbeats = new WeakSet<CompanyRuntimeLock>();
const COMPANY_LOCK_STALE_MS = 30_000;
const COMPANY_LOCK_HEARTBEAT_MS = 1_000;

function writeAtomicText(path: string, content: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx");
		writeFileSync(descriptor, content, "utf-8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
		throw error;
	}
}

function startCompanyLockHeartbeat(path: string, token: string): Worker {
	const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	const worker = new Worker(new URL(`./company-lock-heartbeat${extension}`, import.meta.url), {
		workerData: { path, token, intervalMs: COMPANY_LOCK_HEARTBEAT_MS },
	});
	worker.unref();
	return worker;
}

function lockOwnerProcessIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function processInstanceIdentity(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "win32") {
		const result = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks) } catch { exit 3 }`,
			],
			{ encoding: "utf-8", shell: false, timeout: 5_000, windowsHide: true },
		);
		const ticks = result.status === 0 ? result.stdout.trim() : "";
		return /^\d{10,}$/.test(ticks) ? `windows:${ticks}` : undefined;
	}
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const fields = stat
				.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/);
			const startTicks = fields[19];
			return /^\d+$/.test(startTicks ?? "") ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function acquireCompanyLock(rootDir: string, mode: CompanyLockRecord["mode"]): CompanyRuntimeLock {
	const root = canonicalCompanyRoot(rootDir);
	const path = companyRuntimeLockPath(root);
	mkdirSync(dirname(path), { recursive: true });
	const token = randomUUID();
	const processInstance = processInstanceIdentity(process.pid);
	if (!processInstance) throw new Error("Could not establish the company lock process identity");
	const record: CompanyLockRecord = { version: 3, pid: process.pid, processInstance, root, token, mode };
	for (let attempt = 0; attempt < 3; attempt++) {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(path, "wx");
			writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf-8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			const lock: CompanyRuntimeLock = {
				path,
				root,
				token,
				processInstance,
				release: () => {
					const heartbeat = lockHeartbeats.get(lock);
					if (!heartbeat) return;
					lockHeartbeats.delete(lock);
					try {
						heartbeat.postMessage("stop");
					} catch {}
					void heartbeat.terminate();
				},
			};
			const heartbeat = startCompanyLockHeartbeat(path, token);
			lockHeartbeats.set(lock, heartbeat);
			const markHeartbeatFailure = (): void => {
				if (lockHeartbeats.get(lock) === heartbeat) failedLockHeartbeats.add(lock);
			};
			heartbeat.once("error", markHeartbeatFailure);
			heartbeat.once("exit", markHeartbeatFailure);
			return lock;
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				rmSync(path, { force: true });
				throw error;
			}
			let modifiedAt: number;
			try {
				modifiedAt = statSync(path).mtimeMs;
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw statError;
			}
			const recentlyModified = Date.now() - modifiedAt <= COMPANY_LOCK_STALE_MS;
			let owner: Partial<CompanyLockRecord>;
			try {
				owner = JSON.parse(readFileSync(path, "utf-8")) as Partial<CompanyLockRecord>;
			} catch (readError) {
				if (recentlyModified) {
					throw new Error("Company transaction is already owned by another process", { cause: error });
				}
				throw new Error("Stale company transaction lock has invalid owner identity", { cause: readError });
			}
			if (
				owner.version !== 3 ||
				!Number.isSafeInteger(owner.pid) ||
				owner.pid! <= 0 ||
				typeof owner.processInstance !== "string" ||
				!/^(?:windows|linux):\d+$/.test(owner.processInstance) ||
				typeof owner.token !== "string" ||
				!/^[0-9a-f-]{36}$/i.test(owner.token) ||
				(owner.mode !== "runtime" && owner.mode !== "product-registration") ||
				normalizedPath(owner.root ?? "") !== normalizedPath(root)
			) {
				if (recentlyModified) {
					throw new Error("Company transaction is already owned by another process", { cause: error });
				}
				throw new Error("Stale company transaction lock has invalid owner identity");
			}
			if (lockOwnerProcessIsAlive(owner.pid!)) {
				const liveInstance = processInstanceIdentity(owner.pid!);
				if (!liveInstance) {
					throw new Error("Could not validate the live company lock owner", { cause: error });
				}
				if (liveInstance === owner.processInstance) {
					if (recentlyModified) {
						throw new Error("Company transaction is already owned by another process", { cause: error });
					}
					throw new Error("Company transaction is already owned by another live process", { cause: error });
				}
			}
			try {
				renameSync(path, `${path}.stale-${Date.now()}-${randomUUID()}`);
			} catch (renameError) {
				if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw renameError;
			}
		}
	}
	throw new Error("Could not acquire the company transaction lock atomically");
}

export function claimCompanyRuntimeLock(rootDir: string): CompanyRuntimeLock {
	const lock = acquireCompanyLock(rootDir, "runtime");
	ownedRuntimeLocks.add(lock);
	return lock;
}

export function releaseCompanyRuntimeLock(lock: CompanyRuntimeLock): void {
	try {
		const record = JSON.parse(readFileSync(lock.path, "utf-8")) as Partial<CompanyLockRecord>;
		if (record.token !== lock.token || normalizedPath(record.root ?? "") !== normalizedPath(lock.root)) {
			throw new Error("company transaction lock ownership changed before release");
		}
		rmSync(lock.path, { force: true });
		lock.release();
	} catch (error) {
		try {
			lock.release();
		} catch {}
		throw error;
	} finally {
		ownedRuntimeLocks.delete(lock);
		failedLockHeartbeats.delete(lock);
	}
}

function assertRuntimeLock(root: string, lock: CompanyRuntimeLock): void {
	const canonicalRoot = canonicalCompanyRoot(root);
	if (
		!ownedRuntimeLocks.has(lock) ||
		failedLockHeartbeats.has(lock) ||
		normalizedPath(lock.root) !== normalizedPath(canonicalRoot)
	) {
		throw new Error("desktop product transaction has no host-owned runtime capability");
	}
	const path = companyRuntimeLockPath(canonicalRoot);
	let record: Partial<CompanyLockRecord>;
	try {
		record = JSON.parse(readFileSync(path, "utf-8")) as Partial<CompanyLockRecord>;
	} catch (error) {
		throw new Error("desktop product transaction has no valid runtime lock", { cause: error });
	}
	if (
		record.version !== 3 ||
		record.mode !== "runtime" ||
		record.pid !== process.pid ||
		record.processInstance !== lock.processInstance ||
		record.token !== lock.token ||
		normalizedPath(record.root ?? "") !== normalizedPath(canonicalRoot)
	) {
		throw new Error("desktop product transaction does not own the company runtime lock");
	}
}

interface ProductDepartmentManifest {
	version: 1;
	kind: typeof PRODUCT_DEPARTMENT_KIND;
	product: string;
}

interface ProductRegistry {
	version: 1;
	products: string[];
}

const PRODUCT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-development$/;

function parseProductRegistry(root: string, allowMissing: boolean): ProductRegistry {
	const path = join(root, PRODUCT_REGISTRY_PATH);
	if (!existsSync(path)) {
		if (allowMissing) return { version: 1, products: [] };
		throw new Error(`Company product inventory is missing: ${PRODUCT_REGISTRY_PATH}`);
	}
	try {
		if (normalizedPath(realpathSync(path)) !== normalizedPath(path) || !lstatSync(path).isFile()) {
			throw new Error("product inventory must be a physical file");
		}
		const registry = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProductRegistry>;
		if (
			registry.version === 1 &&
			Array.isArray(registry.products) &&
			registry.products.every((id) => typeof id === "string" && PRODUCT_ID_PATTERN.test(id)) &&
			new Set(registry.products).size === registry.products.length
		) {
			return { version: 1, products: [...registry.products] };
		}
	} catch (error) {
		throw new Error(
			`Company product inventory is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	throw new Error(`Company product inventory is invalid: ${PRODUCT_REGISTRY_PATH}`);
}

function readProductRegistry(root: string): ProductRegistry {
	return parseProductRegistry(root, true);
}

function registerProductDepartment(root: string, id: string, storage: ProductTransactionStorage): void {
	const registry = parseProductRegistry(root, true);
	if (registry.products.includes(id)) return;
	registry.products.push(id);
	registry.products.sort();
	mkdirSync(join(root, ".qorpera"), { recursive: true });
	const path = join(root, PRODUCT_REGISTRY_PATH);
	writeAtomicText(path, `${JSON.stringify(registry, null, "\t")}\n`);
	storage.productRegistry = storageIdentity(path, "file");
}

function checkpointProductKit(root: string, id: string): void {
	if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore", shell: false }).status !== 0)
		return;
	const paths = [
		PRODUCT_REGISTRY_PATH,
		join("departments", id, "department.json"),
		join("departments", id, ".gitignore"),
		join("departments", id, "briefs", ".gitkeep"),
		join("departments", id, "pull-requests", "README.md"),
		join("departments", id, "repository", ".gitkeep"),
		join("departments", id, "worktrees", ".gitkeep"),
	].filter(
		(path) =>
			existsSync(join(root, path)) ||
			spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path], {
				stdio: "ignore",
				shell: false,
			}).status === 0,
	);
	const integrationRecord = join(".qorpera", "product-integrations", `${id}.json`);
	if (existsSync(join(root, integrationRecord))) paths.push(integrationRecord);
	// The product storage roots are deliberately ignored once populated. Force
	// their explicit placeholders into the company history without ever adding
	// product repository or worktree content.
	const added = spawnSync("git", ["-C", root, "add", "--force", "--", ...paths], {
		stdio: "ignore",
		shell: false,
	});
	if (added.status !== 0) throw new Error(`Could not stage product department ${id}`);
	const changed = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", ...paths], {
		stdio: "ignore",
		shell: false,
	});
	if (changed.status === 0) return;
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Host",
			"-c",
			"user.email=host@qorpera.local",
			"commit",
			"--only",
			"-m",
			`feat: add ${id} product department\n\nQorpera-Trigger: founder product kit request\nQorpera-Rationale: preserve the registered product boundary`,
			"--",
			...paths,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit product department ${id}: ${committed.stderr || committed.stdout}`);
	}
}

function checkpointProductIntegrationRecord(root: string, id: string, rationale: string): void {
	const path = join(".qorpera", "product-integrations", `${id}.json`);
	const added = spawnSync("git", ["-C", root, "add", "--", path], { encoding: "utf-8", shell: false });
	if (added.status !== 0)
		throw new Error(`Could not stage product integration journal: ${added.stderr || added.stdout}`);
	const changed = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", path], {
		stdio: "ignore",
		shell: false,
	});
	if (changed.status === 0) return;
	if (changed.status !== 1) throw new Error("Could not inspect the product integration journal");
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Host",
			"-c",
			"user.email=host@qorpera.local",
			"commit",
			"--only",
			"-m",
			`docs: journal ${id} product integration\n\nQorpera-Trigger: founder product integration\nQorpera-Rationale: ${rationale}`,
			"--",
			path,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit product integration journal: ${committed.stderr || committed.stdout}`);
	}
}

export interface ProductDepartment {
	/** Stable folder identifier, for example `qorpera-development`. */
	id: string;
	/** Product display name from the department manifest. */
	name: string;
	/** Root-relative department path. */
	path: string;
	/** Root-relative path of the controlling clone. */
	repositoryPath: string;
	/** Root-relative parent for task worktrees. */
	worktreesPath: string;
	/** Root-relative synchronized pull-request read model. */
	pullRequestsPath: string;
	repositoryExists: boolean;
}

export interface ProductWorktree {
	path: string;
	branch: string;
	departmentId: string;
	repositoryPath: string;
	sourceRemote: string;
	sourceHead?: string;
	recoveryHead?: string;
	recoveryBundles: ProductRecoveryBundle[];
	recoveryUpdatedAt?: string;
	sourceHistory: Array<{ sourceRemote: string; reboundAt: string }>;
	createdAt: string;
}

export interface ProductRecoveryBundle {
	path: string;
	head: string;
	baseHead?: string;
}

export interface ProductWorktreePlan {
	taskId: string;
	path: string;
	branch: string;
	departmentId: string;
	repositoryPath: string;
	sourceRemote: string;
	sourceHead?: string;
}

interface ProductWorktreeAssignment extends ProductWorktree {
	version: 3;
}

export interface ProductWorktreeRecoveryPlan {
	assignment: ProductWorktree;
	path: string;
	repositoryPath: string;
	repositoryRemote: string;
	sourceHead?: string;
	recoveryHead?: string;
	recoveryBundles: ProductRecoveryBundle[];
}

export interface ScaffoldResult {
	root: string;
	created: string[];
	skipped: string[];
	gitInitialized: boolean;
}

function writeIfMissing(root: string, relPath: string, content: string, result: ScaffoldResult): void {
	const target = join(root, relPath);
	if (existsSync(target)) {
		result.skipped.push(relPath);
		return;
	}
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content, "utf-8");
	result.created.push(relPath);
}

function ensureDir(root: string, relPath: string, result: ScaffoldResult): void {
	const target = join(root, relPath);
	if (!existsSync(target)) {
		mkdirSync(target, { recursive: true });
		result.created.push(`${relPath}/`);
	} else {
		result.skipped.push(`${relPath}/`);
	}
	// Keep empty spine directories present in git.
	const keep = join(target, ".gitkeep");
	if (!existsSync(keep) && readdirIsEmpty(target)) {
		writeFileSync(keep, "", "utf-8");
		result.created.push(join(relPath, ".gitkeep"));
	}
}

/** Product-development storage is an optional capability, not part of
 * agents-only company genesis. Materialize it only when requested. */
function materializeProductSpine(root: string): void {
	const result: ScaffoldResult = { root, created: [], skipped: [], gitInitialized: false };
	if (!existsSync(join(root, "departments"))) mkdirSync(join(root, "departments"));
	writeIfMissing(root, PRODUCT_REGISTRY_PATH, `${JSON.stringify({ version: 1, products: [] }, null, "\t")}\n`, result);
}

function readdirIsEmpty(dir: string): boolean {
	try {
		return readdirSync(dir).length === 0;
	} catch {
		return false;
	}
}

/** Merge company runtime defaults into project settings without clobbering. */
function ensureProjectSettings(root: string, result: ScaffoldResult): boolean {
	const settingsDir = join(root, ".qorpera");
	const settingsPath = join(settingsDir, "settings.json");
	if (existsSync(settingsDir)) canonicalDirectory(root, ".qorpera");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			if (
				normalizedPath(realpathSync(settingsPath)) !== normalizedPath(settingsPath) ||
				!lstatSync(settingsPath).isFile() ||
				lstatSync(settingsPath).nlink !== 1
			) {
				throw new Error("settings must be one physical in-company file");
			}
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("settings root must be an object");
			}
			settings = parsed as Record<string, unknown>;
		} catch (error) {
			throw new Error(
				`Company settings are invalid and cannot be opened safely: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	let changed = false;
	if (settings.sessionDir !== "./trail") {
		settings.sessionDir = "./trail";
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (sessionDir already set)");
	}
	if (!settings.compaction || typeof settings.compaction !== "object" || Array.isArray(settings.compaction)) {
		settings.compaction = { enabled: false };
		changed = true;
	} else if ((settings.compaction as Record<string, unknown>).enabled !== false) {
		(settings.compaction as Record<string, unknown>).enabled = false;
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (compaction already configured)");
	}
	if (settings.transport !== "sse") {
		settings.transport = "sse";
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (brokered SSE transport already set)");
	}
	if (!changed) return false;
	mkdirSync(settingsDir, { recursive: true });
	canonicalDirectory(root, ".qorpera");
	writeAtomicText(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`);
	result.created.push(".qorpera/settings.json (trail retained; auto-compaction disabled)");
	return true;
}

/** Reassert host-owned retention policy whenever an existing company opens. */
export function enforceCompanyHostSettings(rootDir: string): void {
	const root = canonicalCompanyRoot(rootDir);
	if (!ensureProjectSettings(root, { root, created: [], skipped: [], gitInitialized: false })) return;
	if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore", shell: false }).status !== 0)
		return;
	const path = join(".qorpera", "settings.json");
	if (spawnSync("git", ["-C", root, "add", "--", path], { stdio: "ignore", shell: false }).status !== 0) {
		throw new Error("Could not stage host retention settings");
	}
	if (
		spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", path], {
			stdio: "ignore",
			shell: false,
		}).status === 0
	)
		return;
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Host",
			"-c",
			"user.email=host@qorpera.local",
			"commit",
			"--only",
			"-m",
			"fix: enforce append-only company trails\n\nQorpera-Trigger: company open\nQorpera-Rationale: keep company session storage local and disable compaction",
			"--",
			path,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit host retention settings: ${committed.stderr || committed.stdout}`);
	}
}

function productSlug(product: string): string {
	const slug = product
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "product";
}

/** Canonical folder identifier reviewed before any product-registration transaction. */
export function productDepartmentId(product: string): string {
	return `${productSlug(product)}-development`;
}

function productDepartmentFromEntry(root: string, id: string): ProductDepartment | undefined {
	if (!id.endsWith("-development") || id.includes("/") || id.includes("\\")) return undefined;
	const path = join("departments", id);
	try {
		canonicalDirectory(root, path);
		const manifestPath = join(root, path, "department.json");
		if (
			normalizedPath(realpathSync(manifestPath)) !== normalizedPath(manifestPath) ||
			!lstatSync(manifestPath).isFile()
		)
			return undefined;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<ProductDepartmentManifest>;
		if (manifest.version !== 1 || manifest.kind !== PRODUCT_DEPARTMENT_KIND || typeof manifest.product !== "string") {
			return undefined;
		}
		const repositoryPath = join(path, "repository");
		return {
			id,
			name: manifest.product,
			path,
			repositoryPath,
			worktreesPath: join(path, "worktrees"),
			pullRequestsPath: join(path, "pull-requests"),
			repositoryExists: existsSync(join(root, repositoryPath, ".git")),
		};
	} catch {
		return undefined;
	}
}

/** Product-development departments are an optional Base kit, discovered from the folder. */
export function listProductDepartments(rootDir: string): ProductDepartment[] {
	const root = canonicalCompanyRoot(rootDir);
	return readProductRegistry(root)
		.products.map((id) => productDepartmentFromEntry(root, id))
		.filter((entry): entry is ProductDepartment => entry !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Host protection inventory; never depends on agent-writable department manifests. */
export function readProductProtectionInventory(
	rootDir: string,
): Array<{ id: string; repositoryPath: string; worktreesPath: string }> {
	const root = canonicalCompanyRoot(rootDir);
	const actualRoot = root;
	return readProductRegistry(root).products.map((id) => {
		const repositoryPath = join("departments", id, "repository");
		const worktreesPath = join("departments", id, "worktrees");
		for (const path of [repositoryPath, worktreesPath]) {
			const expected = resolve(root, path);
			const expectedActual = resolve(actualRoot, path);
			let actual: string;
			try {
				actual = realpathSync(expected);
			} catch (error) {
				throw new Error(`Registered product storage is unavailable: ${path}`, { cause: error });
			}
			const normalizedExpected = process.platform === "win32" ? expectedActual.toLowerCase() : expectedActual;
			const normalizedActual = process.platform === "win32" ? actual.toLowerCase() : actual;
			if (normalizedActual !== normalizedExpected) {
				throw new Error(`Registered product storage must not be a link or junction: ${path}`);
			}
		}
		return { id, repositoryPath, worktreesPath };
	});
}

export interface ProductStorageExpectation {
	path: string;
	kind: "repository" | "worktree";
	remote: string;
	head?: string;
	branch?: string;
}

/** Durable records whose machine-local Git storage must be hydrated. */
export function readProductStorageExpectations(rootDir: string): ProductStorageExpectation[] {
	const root = canonicalCompanyRoot(rootDir);
	const expectations: ProductStorageExpectation[] = [];
	for (const id of readProductRegistry(root).products) {
		const department = productDepartmentFromEntry(root, id);
		if (!department) throw new Error(`Registered product department is invalid: ${id}`);
		const integration = readProductIntegrationRecord(productIntegrationRecordPath(root, id));
		if (integration?.status === "completed") {
			expectations.push({
				path: join("departments", id, "repository"),
				kind: "repository",
				remote: integration.source,
				...(integration.sourceHead ? { head: integration.sourceHead } : {}),
			});
		}
		const assignmentDir = join(root, PRODUCT_WORKTREE_ASSIGNMENTS_PATH, id);
		if (!existsSync(assignmentDir)) continue;
		canonicalDirectory(root, join(PRODUCT_WORKTREE_ASSIGNMENTS_PATH, id));
		for (const entry of readdirSync(assignmentDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const path = join(assignmentDir, entry.name);
			const record = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProductWorktreeAssignment>;
			const expectedParent = join("departments", id, "worktrees").replace(/\\/g, "/");
			const worktreePath = record.path?.replace(/\\/g, "/");
			if (
				record.version !== 3 ||
				record.departmentId !== id ||
				typeof worktreePath !== "string" ||
				!worktreePath.startsWith(`${expectedParent}/`) ||
				worktreePath.slice(expectedParent.length + 1).includes("/") ||
				typeof record.sourceRemote !== "string" ||
				!record.sourceRemote ||
				!repositorySourceAllowed(record.sourceRemote) ||
				typeof record.branch !== "string" ||
				!record.branch ||
				(record.recoveryHead !== undefined && typeof record.recoveryHead !== "string") ||
				!validProductRecoveryChain(record.recoveryBundles, record.recoveryHead)
			) {
				throw new Error(`Product worktree assignment is invalid: ${relative(root, path)}`);
			}
			const parsed = readProductWorktreeRecord(root, department, worktreePath);
			if (!parsed) throw new Error(`Product worktree assignment is invalid: ${relative(root, path)}`);
			for (const record of parsed.assignment.recoveryBundles) {
				const bundle = assertPhysicalCompanyTree(root, record.path);
				if (!productRecoveryBundleMatches(root, bundle, record, parsed.assignment.branch)) {
					throw new Error(`Product worktree recovery bundle is invalid: ${record.path}`);
				}
			}
			expectations.push({
				path: worktreePath,
				kind: "worktree",
				remote: parsed.assignment.sourceRemote,
				...((parsed.assignment.recoveryHead ?? parsed.assignment.sourceHead)
					? { head: parsed.assignment.recoveryHead ?? parsed.assignment.sourceHead }
					: {}),
				branch: parsed.assignment.branch,
			});
		}
	}
	return expectations.sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`));
}

/** Recreate ignored storage roots only while binding a fresh local company clone. */
export function materializeClonedProductStorage(rootDir: string): void {
	const root = canonicalCompanyRoot(rootDir);
	for (const id of readProductRegistry(root).products) {
		canonicalDirectory(root, join("departments", id));
		for (const relativePath of [join("departments", id, "repository"), join("departments", id, "worktrees")]) {
			const target = join(root, relativePath);
			if (!existsSync(target)) mkdirSync(target);
			canonicalDirectory(root, relativePath);
			const keep = join(target, ".gitkeep");
			if (readdirIsEmpty(target)) writeFileSync(keep, "", { encoding: "utf-8", flag: "wx" });
		}
	}
}

/** Materialize the standard product-development department while its caller owns the company transaction lock. */
function scaffoldProductDepartmentUnlocked(
	rootDir: string,
	product: string,
	storage: ProductTransactionStorage,
): ProductDepartment {
	const root = assertProductTransactionStorage(storage);
	if (normalizedPath(root) !== normalizedPath(canonicalCompanyRoot(rootDir))) {
		throw new Error("Product transaction storage does not belong to this company");
	}
	const id = productDepartmentId(product);
	const path = join("departments", id);
	const target = join(root, path);
	const existing = productDepartmentFromEntry(root, id);
	if (existsSync(target) && !existing) {
		throw new Error(
			`Cannot create product department ${id}: ${path} already exists without a valid product-development manifest`,
		);
	}
	if (existing) {
		assertProductTransactionStorage(storage);
		registerProductDepartment(root, id, storage);
		assertProductTransactionStorage(storage);
		checkpointProductKit(root, id);
		return existing;
	}
	const result: ScaffoldResult = { root, created: [], skipped: [], gitInitialized: false };
	const manifest: ProductDepartmentManifest = {
		version: 1,
		kind: PRODUCT_DEPARTMENT_KIND,
		product: product.trim() || productSlug(product),
	};
	assertProductTransactionStorage(storage);
	writeIfMissing(root, join(path, "department.json"), `${JSON.stringify(manifest, null, "\t")}\n`, result);
	writeIfMissing(root, join(path, ".gitignore"), PRODUCT_DEPARTMENT_GITIGNORE, result);
	ensureDir(root, join(path, "briefs"), result);
	ensureDir(root, join(path, "worktrees"), result);
	ensureDir(root, join(path, "repository"), result);
	writeIfMissing(root, join(path, "pull-requests", "README.md"), PULL_REQUESTS_README, result);
	const created = productDepartmentFromEntry(root, id)!;
	assertProductTransactionStorage(storage);
	registerProductDepartment(root, id, storage);
	assertProductTransactionStorage(storage);
	checkpointProductKit(root, id);
	return created;
}

/** Offline product registration. The lock is held across inventory, folder, and Git mutation. */
export function scaffoldProductDepartment(rootDir: string, product: string): ProductDepartment {
	const lock = acquireCompanyLock(rootDir, "product-registration");
	try {
		const storage = captureProductTransactionStorage(lock.root);
		return scaffoldProductDepartmentUnlocked(lock.root, product, storage);
	} finally {
		releaseCompanyRuntimeLock(lock);
	}
}

/** Desktop-host product registration under the already-held runtime transaction. */
export function scaffoldProductDepartmentWithRuntimeLock(
	rootDir: string,
	product: string,
	runtimeLock: CompanyRuntimeLock,
	storage: ProductTransactionStorage,
): ProductDepartment {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	return scaffoldProductDepartmentUnlocked(root, product, storage);
}

function worktreeAssignmentPath(root: string, departmentId: string, taskId: string): string {
	return join(root, PRODUCT_WORKTREE_ASSIGNMENTS_PATH, departmentId, `${taskId}.json`);
}

function validProductRecoveryChain(value: unknown, recoveryHead: unknown): value is ProductRecoveryBundle[] {
	if (!Array.isArray(value)) return false;
	let previousHead: string | undefined;
	const paths = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const candidate = entry as Partial<ProductRecoveryBundle>;
		const path = candidate.path?.replace(/\\/g, "/");
		if (
			typeof path !== "string" ||
			!/^\.qorpera\/w\/[a-f0-9]{32}\.bundle$/.test(path) ||
			paths.has(path) ||
			typeof candidate.head !== "string" ||
			!/^[a-f0-9]{40,64}$/i.test(candidate.head) ||
			(candidate.baseHead !== undefined && !/^[a-f0-9]{40,64}$/i.test(candidate.baseHead)) ||
			(candidate.baseHead ?? undefined) !== previousHead
		)
			return false;
		paths.add(path);
		previousHead = candidate.head;
	}
	return value.length === 0 ? true : typeof recoveryHead === "string" && previousHead === recoveryHead;
}

function productRecoveryBundleMatches(
	root: string,
	bundle: string,
	record: ProductRecoveryBundle,
	branch: string,
): boolean {
	const objectId = gitOutput(root, ["hash-object", "--no-filters", bundle]);
	if (!objectId || !record.path.endsWith(`/${objectId.slice(0, 32)}.bundle`)) return false;
	return (
		gitOutput(root, ["bundle", "list-heads", bundle, `refs/heads/${branch}`]) ===
		`${record.head} refs/heads/${branch}`
	);
}

function commitProductWorktreeAssignment(root: string, path: string, departmentId: string): void {
	const relativePath = join(PRODUCT_WORKTREE_ASSIGNMENTS_PATH, departmentId, `${path}.json`);
	const added = spawnSync("git", ["-C", root, "add", "--", relativePath], { encoding: "utf-8", shell: false });
	if (added.status !== 0)
		throw new Error(`Could not stage product worktree assignment: ${added.stderr || added.stdout}`);
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Host",
			"-c",
			"user.email=host@qorpera.local",
			"commit",
			"--only",
			"-m",
			`docs: assign ${departmentId} worktree\n\nQorpera-Trigger: founder product-chat request\nQorpera-Rationale: bind product-code authority to one host-created clone`,
			"--",
			relativePath,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit product worktree assignment: ${committed.stderr || committed.stdout}`);
	}
}

function gitOutput(root: string, args: string[]): string | undefined {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", shell: false });
	return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/** Plan the exact founder-reviewed worktree without mutating product storage. */
export function planProductWorktree(
	rootDir: string,
	department: ProductDepartment,
	runtimeLock: CompanyRuntimeLock,
): ProductWorktreePlan | undefined {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	readProductProtectionInventory(root);
	if (!department.repositoryExists) return undefined;
	const registered = listProductDepartments(root).find(
		(entry) =>
			entry.id === department.id &&
			entry.repositoryPath === department.repositoryPath &&
			entry.worktreesPath === department.worktreesPath &&
			entry.repositoryExists,
	);
	if (!registered) return undefined;
	const taskId = `${new Date()
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14)}-${randomUUID().slice(0, 8)}`;
	const path = join(department.worktreesPath, taskId);
	const branch = `qorpera/${taskId}`;
	const repository = canonicalDirectory(root, department.repositoryPath);
	canonicalDirectory(root, department.worktreesPath);
	const sourceRemote = gitOutput(repository, ["remote", "get-url", "origin"]) ?? repository;
	if (!cloneSourceAllowed(sourceRemote)) {
		throw new Error("Product worktree source cannot contain embedded credentials or query data");
	}
	const sourceHead = gitOutput(repository, ["rev-parse", "HEAD"]);
	return {
		taskId,
		path,
		branch,
		departmentId: department.id,
		repositoryPath: department.repositoryPath,
		sourceRemote,
		...(sourceHead ? { sourceHead } : {}),
	};
}

/** Materialize one founder-reviewed product task clone under worktrees/. */
export function createProductWorktree(
	rootDir: string,
	department: ProductDepartment,
	runtimeLock: CompanyRuntimeLock,
	plan: ProductWorktreePlan,
): ProductWorktree | undefined {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	const currentPlan = planProductWorktree(root, department, runtimeLock);
	if (
		!currentPlan ||
		plan.departmentId !== currentPlan.departmentId ||
		plan.repositoryPath !== currentPlan.repositoryPath ||
		plan.path !== join(department.worktreesPath, plan.taskId) ||
		plan.branch !== `qorpera/${plan.taskId}` ||
		plan.sourceRemote !== currentPlan.sourceRemote ||
		plan.sourceHead !== currentPlan.sourceHead ||
		!/^\d{14}-[a-f0-9]{8}$/i.test(plan.taskId)
	) {
		throw new Error("Product worktree plan changed after founder review");
	}
	const { taskId, path, branch } = plan;
	const worktreesRoot = canonicalDirectory(root, department.worktreesPath);
	const repository = canonicalDirectory(root, department.repositoryPath);
	const target = join(root, path);
	if (existsSync(target) || existsSync(worktreeAssignmentPath(root, department.id, taskId))) {
		throw new Error("Founder-reviewed product worktree target is no longer available");
	}
	const clone = spawnSync("git", ["clone", "--no-hardlinks", repository, target], {
		encoding: "utf-8",
		shell: false,
	});
	if (clone.status !== 0) {
		console.error(`Could not create product worktree: ${clone.stderr || clone.stdout || "git clone failed"}`);
		return undefined;
	}
	const checkout = spawnSync("git", ["-C", target, "switch", "-c", branch], {
		encoding: "utf-8",
		shell: false,
	});
	if (checkout.status === 0) {
		const remote = gitOutput(repository, ["remote", "get-url", "origin"]);
		if (remote) {
			spawnSync("git", ["-C", target, "remote", "set-url", "origin", remote], {
				stdio: "ignore",
				shell: false,
			});
		}
		const actualTarget = realpathSync(target);
		if (
			normalizedPath(actualTarget) !== normalizedPath(resolve(worktreesRoot, taskId)) ||
			normalizedPath(dirname(actualTarget)) !== normalizedPath(worktreesRoot)
		) {
			rmSync(target, { recursive: true, force: true });
			throw new Error("Host-created product worktree escaped its assigned parent");
		}
		const sourceRemote = gitOutput(target, ["remote", "get-url", "origin"]);
		const sourceHead = gitOutput(target, ["rev-parse", "HEAD"]);
		if (!sourceRemote || sourceRemote !== plan.sourceRemote || sourceHead !== plan.sourceHead) {
			rmSync(target, { recursive: true, force: true });
			throw new Error("Host-created product worktree source changed after founder review");
		}
		const assignment: ProductWorktreeAssignment = {
			version: 3,
			path,
			branch,
			departmentId: department.id,
			repositoryPath: department.repositoryPath,
			sourceRemote,
			...(plan.sourceHead ? { sourceHead: plan.sourceHead } : {}),
			...(plan.sourceHead ? { recoveryHead: plan.sourceHead } : {}),
			recoveryBundles: [],
			sourceHistory: [],
			createdAt: new Date().toISOString(),
		};
		const assignmentDir = join(root, PRODUCT_WORKTREE_ASSIGNMENTS_PATH, department.id);
		mkdirSync(assignmentDir, { recursive: true });
		canonicalDirectory(root, join(PRODUCT_WORKTREE_ASSIGNMENTS_PATH, department.id));
		const assignmentPath = worktreeAssignmentPath(root, department.id, taskId);
		try {
			writeFileSync(assignmentPath, `${JSON.stringify(assignment, null, "\t")}\n`, {
				encoding: "utf-8",
				flag: "wx",
			});
			commitProductWorktreeAssignment(root, taskId, department.id);
			return assignment;
		} catch (error) {
			rmSync(assignmentPath, { force: true });
			rmSync(target, { recursive: true, force: true });
			throw error;
		}
	}
	console.error(`Could not create product worktree branch: ${checkout.stderr || checkout.stdout || "git failed"}`);
	rmSync(target, { recursive: true, force: true });
	return undefined;
}

function readProductWorktreeRecord(
	rootDir: string,
	department: ProductDepartment,
	worktreePath: string,
): { assignment: ProductWorktreeAssignment; assignmentPath: string; taskId: string } | undefined {
	const root = canonicalCompanyRoot(rootDir);
	const normalizedRelative = worktreePath.replace(/[\\/]+/g, "/");
	const expectedParent = department.worktreesPath.replace(/\\/g, "/");
	const taskId = normalizedRelative.slice(expectedParent.length + 1);
	if (
		!normalizedRelative.startsWith(`${expectedParent}/`) ||
		!taskId ||
		taskId.includes("/") ||
		taskId === "." ||
		taskId === ".."
	)
		return undefined;
	let assignment: Partial<ProductWorktreeAssignment>;
	let assignmentPath: string;
	try {
		assignmentPath = worktreeAssignmentPath(root, department.id, taskId);
		if (
			normalizedPath(realpathSync(assignmentPath)) !== normalizedPath(assignmentPath) ||
			!lstatSync(assignmentPath).isFile()
		) {
			return undefined;
		}
		assignment = JSON.parse(readFileSync(assignmentPath, "utf-8")) as Partial<ProductWorktreeAssignment>;
	} catch {
		return undefined;
	}
	if (
		assignment.version !== 3 ||
		assignment.departmentId !== department.id ||
		assignment.path?.replace(/\\/g, "/") !== normalizedRelative ||
		assignment.repositoryPath !== department.repositoryPath ||
		typeof assignment.branch !== "string" ||
		!assignment.branch ||
		typeof assignment.sourceRemote !== "string" ||
		!assignment.sourceRemote ||
		!repositorySourceAllowed(assignment.sourceRemote) ||
		!Array.isArray(assignment.sourceHistory) ||
		!assignment.sourceHistory.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				typeof entry.sourceRemote === "string" &&
				repositorySourceAllowed(entry.sourceRemote) &&
				typeof entry.reboundAt === "string",
		) ||
		typeof assignment.createdAt !== "string" ||
		(assignment.sourceHead !== undefined && typeof assignment.sourceHead !== "string") ||
		(assignment.recoveryHead !== undefined && typeof assignment.recoveryHead !== "string") ||
		(assignment.recoveryUpdatedAt !== undefined && typeof assignment.recoveryUpdatedAt !== "string") ||
		!validProductRecoveryChain(assignment.recoveryBundles, assignment.recoveryHead)
	)
		return undefined;
	return { assignment: assignment as ProductWorktreeAssignment, assignmentPath, taskId };
}

/** Verify an existing assignment against its immutable host record and clone identity. */
export function readProductWorktreeAssignment(
	rootDir: string,
	department: ProductDepartment,
	worktreePath: string,
): ProductWorktree | undefined {
	const root = canonicalCompanyRoot(rootDir);
	const record = readProductWorktreeRecord(root, department, worktreePath);
	if (!record) return undefined;
	const { assignment, taskId } = record;
	const worktreesRoot = canonicalDirectory(root, department.worktreesPath);
	const target = resolve(root, worktreePath);
	let actual: string;
	try {
		actual = realpathSync(target);
	} catch {
		return undefined;
	}
	const topLevel = gitOutput(actual, ["rev-parse", "--show-toplevel"]);
	if (
		normalizedPath(dirname(actual)) !== normalizedPath(worktreesRoot) ||
		normalizedPath(actual) !== normalizedPath(resolve(worktreesRoot, taskId)) ||
		!topLevel ||
		normalizedPath(topLevel) !== normalizedPath(actual) ||
		gitOutput(actual, ["branch", "--show-current"]) !== assignment.branch ||
		gitOutput(actual, ["remote", "get-url", "origin"]) !== assignment.sourceRemote
	)
		return undefined;
	if (
		(assignment.recoveryHead ?? assignment.sourceHead) &&
		spawnSync(
			"git",
			["-C", actual, "merge-base", "--is-ancestor", assignment.recoveryHead ?? assignment.sourceHead!, "HEAD"],
			{
				stdio: "ignore",
				shell: false,
			},
		).status !== 0
	)
		return undefined;
	return assignment as ProductWorktree;
}

/** Plan recovery of one clone from its host-tracked source and portable bundle. */
export function planProductWorktreeRecovery(
	rootDir: string,
	department: ProductDepartment,
	worktreePath: string,
	runtimeLock: CompanyRuntimeLock,
): ProductWorktreeRecoveryPlan | undefined {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	const record = readProductWorktreeRecord(root, department, worktreePath);
	if (!record || existsSync(join(root, record.assignment.path))) return undefined;
	const repository = canonicalDirectory(root, department.repositoryPath);
	const repositoryRemote = gitOutput(repository, ["remote", "get-url", "origin"]);
	if (!repositoryRemote) return undefined;
	if (!cloneSourceAllowed(repositoryRemote)) {
		throw new Error("Product recovery source cannot contain embedded credentials or query data");
	}
	if (
		record.assignment.sourceHead &&
		spawnSync("git", ["-C", repository, "merge-base", "--is-ancestor", record.assignment.sourceHead, "HEAD"], {
			stdio: "ignore",
			shell: false,
		}).status !== 0
	)
		return undefined;
	const recoveryBundles: ProductRecoveryBundle[] = [];
	for (const bundleRecord of record.assignment.recoveryBundles) {
		const bundle = assertPhysicalCompanyTree(root, bundleRecord.path);
		if (!productRecoveryBundleMatches(root, bundle, bundleRecord, record.assignment.branch)) return undefined;
		recoveryBundles.push({ ...bundleRecord, path: bundle });
	}
	if (
		recoveryBundles.length === 0 &&
		record.assignment.recoveryHead &&
		spawnSync("git", ["-C", repository, "cat-file", "-e", `${record.assignment.recoveryHead}^{commit}`], {
			stdio: "ignore",
			shell: false,
		}).status !== 0
	) {
		return undefined;
	}
	return {
		assignment: record.assignment,
		path: record.assignment.path,
		repositoryPath: department.repositoryPath,
		repositoryRemote,
		...(record.assignment.sourceHead ? { sourceHead: record.assignment.sourceHead } : {}),
		...(record.assignment.recoveryHead ? { recoveryHead: record.assignment.recoveryHead } : {}),
		recoveryBundles,
	};
}

/** Restore an assigned clone after exact native review of this immutable plan. */
export function recoverProductWorktree(
	rootDir: string,
	department: ProductDepartment,
	runtimeLock: CompanyRuntimeLock,
	plan: ProductWorktreeRecoveryPlan,
): ProductWorktree | undefined {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	const current = planProductWorktreeRecovery(root, department, plan.path, runtimeLock);
	if (!current || JSON.stringify(current) !== JSON.stringify(plan)) {
		throw new Error("Product worktree recovery plan changed after founder review");
	}
	const record = readProductWorktreeRecord(root, department, plan.path);
	if (!record) throw new Error("Product worktree recovery assignment is invalid");
	const repository = canonicalDirectory(root, department.repositoryPath);
	const worktreesRoot = canonicalDirectory(root, department.worktreesPath);
	const target = resolve(root, plan.path);
	if (existsSync(target) || normalizedPath(dirname(target)) !== normalizedPath(worktreesRoot)) {
		throw new Error("Product worktree recovery target is no longer available");
	}
	const preserveFailedClone = (): void => {
		if (!existsSync(target)) return;
		renameSync(target, `${target}.recovery-failed-${randomUUID().replace(/-/g, "").slice(0, 12)}`);
	};
	const clone = spawnSync("git", ["clone", "--no-hardlinks", repository, target], {
		encoding: "utf-8",
		shell: false,
	});
	if (clone.status !== 0) {
		preserveFailedClone();
		return undefined;
	}
	for (const bundle of plan.recoveryBundles) {
		const verified = spawnSync("git", ["-C", target, "bundle", "verify", bundle.path], {
			stdio: "ignore",
			shell: false,
		});
		const fetched = spawnSync("git", ["-C", target, "fetch", bundle.path, plan.assignment.branch], {
			encoding: "utf-8",
			shell: false,
		});
		if (
			verified.status !== 0 ||
			fetched.status !== 0 ||
			spawnSync("git", ["-C", target, "cat-file", "-e", `${bundle.head}^{commit}`], {
				stdio: "ignore",
				shell: false,
			}).status !== 0
		) {
			preserveFailedClone();
			return undefined;
		}
	}
	const recoveryHead = plan.recoveryHead ?? plan.sourceHead;
	const checkout = recoveryHead
		? spawnSync("git", ["-C", target, "switch", "-C", plan.assignment.branch, recoveryHead], {
				encoding: "utf-8",
				shell: false,
			})
		: spawnSync("git", ["-C", target, "switch", "-c", plan.assignment.branch], {
				encoding: "utf-8",
				shell: false,
			});
	if (checkout.status !== 0) {
		preserveFailedClone();
		return undefined;
	}
	spawnSync("git", ["-C", target, "remote", "set-url", "origin", plan.repositoryRemote], {
		stdio: "ignore",
		shell: false,
	});
	if (
		gitOutput(target, ["branch", "--show-current"]) !== plan.assignment.branch ||
		gitOutput(target, ["remote", "get-url", "origin"]) !== plan.repositoryRemote ||
		(recoveryHead && gitOutput(target, ["rev-parse", "HEAD"]) !== recoveryHead)
	) {
		preserveFailedClone();
		return undefined;
	}
	const updated: ProductWorktreeAssignment = {
		...record.assignment,
		sourceRemote: plan.repositoryRemote,
		sourceHistory:
			record.assignment.sourceRemote === plan.repositoryRemote
				? record.assignment.sourceHistory
				: [
						...record.assignment.sourceHistory,
						{ sourceRemote: record.assignment.sourceRemote, reboundAt: new Date().toISOString() },
					],
	};
	if (JSON.stringify(updated) === JSON.stringify(record.assignment)) return updated;
	try {
		writeAtomicText(record.assignmentPath, `${JSON.stringify(updated, null, "\t")}\n`);
		commitProductWorktreeAssignment(root, record.taskId, department.id);
		return updated;
	} catch (error) {
		writeAtomicText(record.assignmentPath, `${JSON.stringify(record.assignment, null, "\t")}\n`);
		preserveFailedClone();
		throw error;
	}
}

function ensureCompanyGenesis(root: string, createdPaths: string[]): void {
	const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore", shell: false });
	const materializedPaths = [
		...new Set(createdPaths.map((path) => path.replace(/ \([^)]*\)$/, "").replace(/\/$/, ""))),
	].filter((path) => path && existsSync(join(root, path)));
	if (head.status === 0 && materializedPaths.length === 0) return;
	const added = spawnSync(
		"git",
		head.status === 0 ? ["-C", root, "add", "--", ...materializedPaths] : ["-C", root, "add", "--all"],
		{ stdio: "ignore", shell: false },
	);
	if (added.status !== 0) throw new Error("Could not stage the company genesis snapshot");
	if (head.status === 0) {
		const changed = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", ...materializedPaths], {
			stdio: "ignore",
			shell: false,
		});
		if (changed.status === 0) return;
		if (changed.status !== 1) throw new Error("Could not inspect the company materialization snapshot");
	}
	const message =
		head.status === 0
			? "docs: materialize company home\n\nQorpera-Trigger: company scaffold migration\nQorpera-Rationale: make host-managed company state cloneable before agent execution"
			: "feat: create company genesis\n\nQorpera-Trigger: company scaffold\nQorpera-Rationale: make the complete company spine cloneable and recoverable";
	const pathArgs = head.status === 0 ? ["--only", "--", ...materializedPaths] : [];
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Host",
			"-c",
			"user.email=host@qorpera.local",
			"commit",
			"-m",
			message,
			...pathArgs,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit the company genesis snapshot: ${committed.stderr || committed.stdout}`);
	}
}

/** Create an agents-only company home. Service data and credentials do
 * not belong here: the company carries internal identity, agent workspaces,
 * shared files, connector recipes, and reconstructable Git history. */
export function scaffoldCompany(dir: string): ScaffoldResult {
	const root = resolve(dir);
	mkdirSync(root, { recursive: true });
	const result: ScaffoldResult = { root, created: [], skipped: [], gitInitialized: false };
	const createdAt = new Date().toISOString();
	const manifest: CompanyManifest = {
		schema: COMPANY_MANIFEST_SCHEMA,
		id: randomUUID(),
		name: basename(root),
		createdAt,
	};
	writeIfMissing(root, COMPANY_MANIFEST_RELATIVE_PATH, `${JSON.stringify(manifest, null, "\t")}\n`, result);
	writeIfMissing(
		root,
		STAFF_REGISTRY_RELATIVE_PATH,
		`${JSON.stringify({ version: 1, agents: {} }, null, "\t")}\n`,
		result,
	);
	ensureDir(root, join("inbox", "messages"), result);
	ensureDir(root, "trail", result);
	ensureDir(root, "connectors", result);
	ensureDir(root, "agents", result);
	ensureDir(root, "files", result);
	ensureProjectSettings(root, result);

	if (!existsSync(join(root, ".git"))) {
		const git = spawnSync("git", ["init"], { cwd: root, stdio: "ignore", shell: false });
		result.gitInitialized = git.status === 0;
	}
	ensureCompanyGenesis(root, result.created);

	return result;
}

function printScaffoldReport(result: ScaffoldResult): void {
	console.log(`Company spine at ${result.root}`);
	for (const entry of result.created) console.log(`  created ${entry}`);
	for (const entry of result.skipped) console.log(`  kept    ${entry}`);
	if (result.gitInitialized) console.log("  initialized git repository");
}

/**
 * Re-exec this CLI interactively inside the company folder. Launched bare on
 * purpose: main() detects and registers the company so an agent can be hired.
 * New companies never start a universal company agent.
 */
function launchSession(dir: string): Promise<number> {
	console.log(`Company ready at ${resolve(dir)}. Open it in Qorpera Base desktop to hire its first agent.`);
	return Promise.resolve(0);
}

function repositorySourceAllowed(source: string): boolean {
	try {
		const parsed = new URL(source);
		const sshUsername = parsed.username && (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:");
		if (parsed.password || parsed.search || parsed.hash || (parsed.username && !sshUsername)) return false;
	} catch {
		// Local paths and SCP-style SSH remotes are not URL-userinfo credentials.
	}
	return true;
}

function cloneSourceAllowed(source: string): boolean {
	if (repositorySourceAllowed(source)) return true;
	console.error(
		"Repository URLs with embedded credentials or query data are not allowed; use a Git credential helper.",
	);
	return false;
}

function cloneInto(source: string, destination: string): boolean {
	if (!cloneSourceAllowed(source)) return false;
	const clone = spawnSync("git", ["clone", "--no-hardlinks", source, destination], { stdio: "inherit", shell: false });
	return clone.status === 0;
}

// ---- environment export / import (build plan §3; manifesto §10) ------------
//
// An export is the company folder as plain files — Git history, JSONL trail,
// markdown — plus a manifest carrying the environment contract version, so it
// is inspectable with no Qorpera installation and portable across Base
// versions that share the contract. Secrets and standing authority never
// appear in an export because they never live in the folder: credentials sit
// in the machine auth store and durable gate trust in machine-local host
// state keyed by the canonical root path, which is also why an imported
// company starts with a fresh environment identity and no inherited trust.

export const ENVIRONMENT_CONTRACT_VERSION = 1;
export const EXPORT_MANIFEST_SCHEMA = "qorpera.export/v1";
export const EXPORT_MANIFEST_FILE = "export-manifest.json";
const EXPORT_COMPANY_DIR = "company";
const RUNTIME_LOCK_DIR_SEGMENT = "qorpera-runtime-locks";

export interface ExportManifest {
	schema: typeof EXPORT_MANIFEST_SCHEMA;
	contractVersion: number;
	exportedAt: string;
	companyName: string;
	sourceHead: string | null;
}

export interface ExportResult {
	target: string;
	manifest: ExportManifest;
}

export interface ImportResult {
	root: string;
	manifest: ExportManifest;
	head: string | null;
}

function gitHead(root: string): string | null {
	const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf-8", shell: false });
	return head.status === 0 ? head.stdout.trim() : null;
}

function assertEmptyDestination(target: string): void {
	if (existsSync(target) && readdirSync(target).length > 0) {
		throw new Error(`Destination ${target} exists and is not empty`);
	}
}

function assertOutsideCompany(root: string, target: string): void {
	const rootRelative = relative(root, target);
	if (!rootRelative || (!rootRelative.startsWith("..") && !isAbsolute(rootRelative))) {
		throw new Error("Export destination cannot be inside the company folder");
	}
}

export function exportCompany(companyDir: string, targetDir: string): ExportResult {
	const root = canonicalCompanyRoot(companyDir);
	validateCompanyHostStorage(root);
	const target = resolve(targetDir);
	assertOutsideCompany(root, target);
	assertEmptyDestination(target);
	// Exports are defined at checkpoint boundaries only: holding the runtime
	// lock guarantees no live agent is mutating the environment mid-copy.
	const lock = claimCompanyRuntimeLock(root);
	try {
		mkdirSync(target, { recursive: true });
		cpSync(root, join(target, EXPORT_COMPANY_DIR), {
			recursive: true,
			filter: (source) => !normalizedPath(source).split(/[\\/]/).includes(RUNTIME_LOCK_DIR_SEGMENT),
		});
		const manifest: ExportManifest = {
			schema: EXPORT_MANIFEST_SCHEMA,
			contractVersion: ENVIRONMENT_CONTRACT_VERSION,
			exportedAt: new Date().toISOString(),
			companyName: readCompanyManifest(root).name,
			sourceHead: gitHead(root),
		};
		writeAtomicText(join(target, EXPORT_MANIFEST_FILE), `${JSON.stringify(manifest, null, "\t")}\n`);
		return { target, manifest };
	} finally {
		releaseCompanyRuntimeLock(lock);
	}
}

function parseExportManifest(exportDir: string): ExportManifest {
	const manifestPath = join(exportDir, EXPORT_MANIFEST_FILE);
	if (!existsSync(manifestPath)) {
		throw new Error(`Not a company export: missing ${EXPORT_MANIFEST_FILE}`);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<ExportManifest>;
	if (manifest.schema !== EXPORT_MANIFEST_SCHEMA) {
		throw new Error(`Unsupported export schema: ${String(manifest.schema)}`);
	}
	if (!Number.isSafeInteger(manifest.contractVersion) || (manifest.contractVersion as number) < 1) {
		throw new Error("Export manifest carries no valid environment contract version");
	}
	if ((manifest.contractVersion as number) > ENVIRONMENT_CONTRACT_VERSION) {
		throw new Error(
			`This export requires environment contract v${manifest.contractVersion}; this Base supports v${ENVIRONMENT_CONTRACT_VERSION}`,
		);
	}
	if (manifest.sourceHead !== null && typeof manifest.sourceHead !== "string") {
		throw new Error("Export manifest carries an invalid source head");
	}
	return manifest as ExportManifest;
}

export function importCompany(exportDir: string, targetDir: string): ImportResult {
	const source = resolve(exportDir);
	const manifest = parseExportManifest(source);
	const companySource = join(source, EXPORT_COMPANY_DIR);
	if (!existsSync(companySource)) {
		throw new Error(`Not a company export: missing ${EXPORT_COMPANY_DIR}/`);
	}
	const target = resolve(targetDir);
	assertEmptyDestination(target);
	cpSync(companySource, target, { recursive: true });
	validateCompanyHostStorage(target);
	const head = gitHead(target);
	if (manifest.sourceHead && head !== manifest.sourceHead) {
		throw new Error(
			`Imported history head ${head ?? "(none)"} does not match the export manifest ${manifest.sourceHead}`,
		);
	}
	registerCompany(target);
	return { root: canonicalCompanyRoot(target), manifest, head };
}

// ---- environment operations (build plan §7) --------------------------------
//
// Snapshot, restore, fork, trail playback, and erase — operations on the
// company environment as a whole, built on the export mechanism Build 1
// proved. All of them prove the environment is not live (the runtime lock)
// before acting; none of them interprets business content. Fork severs
// authority structurally: credentials, gate trust, wake state, and
// schedules live in machine-local stores keyed by the canonical root path,
// so a fork at a new path starts with none of them, and its lineage is
// recorded in the folder for the fork to understand its origin without
// being able to impersonate it.

function environmentStateId(root: string): string {
	return createHash("sha256").update(normalizedPath(root)).digest("hex");
}

export function snapshotsDir(rootDir: string): string {
	return join(getAgentDir(), "snapshots", environmentStateId(canonicalCompanyRoot(rootDir)));
}

export interface SnapshotRecord {
	id: string;
	path: string;
	createdAt: string;
	sourceHead: string | null;
	contractVersion: number;
}

/** Point-in-time capture of the environment; quiesced via the export lane's runtime lock. */
export function snapshotCompany(companyDir: string, label?: string): SnapshotRecord {
	const root = canonicalCompanyRoot(companyDir);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const slug = label
		? `_${label
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40)}`
		: "";
	const id = `${stamp}${slug}`;
	const target = join(snapshotsDir(root), id);
	const exported = exportCompany(root, target);
	return {
		id,
		path: target,
		createdAt: exported.manifest.exportedAt,
		sourceHead: exported.manifest.sourceHead,
		contractVersion: exported.manifest.contractVersion,
	};
}

export function listSnapshots(companyDir: string): SnapshotRecord[] {
	const directory = snapshotsDir(companyDir);
	if (!existsSync(directory)) return [];
	const records: SnapshotRecord[] = [];
	for (const id of readdirSync(directory)) {
		try {
			const path = join(directory, id);
			const manifest = parseExportManifest(path);
			records.push({
				id,
				path,
				createdAt: manifest.exportedAt,
				sourceHead: manifest.sourceHead,
				contractVersion: manifest.contractVersion,
			});
		} catch {
			// Not a readable snapshot; never let one bad directory hide the rest.
		}
	}
	return records.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Restore the environment to a snapshot. A pre-restore safety snapshot is
 * always taken first, so restore is itself forward-recoverable. The runtime
 * lock is claimed and released as a liveness proof before the swap (holding
 * it through the swap is impossible: the lock file lives under the .git
 * being replaced).
 */
export function restoreCompany(companyDir: string, snapshotId: string): { root: string; safetySnapshot: string } {
	const root = canonicalCompanyRoot(companyDir);
	const source = join(snapshotsDir(root), snapshotId);
	parseExportManifest(source);
	const companySource = join(source, EXPORT_COMPANY_DIR);
	if (!existsSync(companySource)) throw new Error(`Snapshot is missing its company payload: ${snapshotId}`);
	const safety = snapshotCompany(root, "pre-restore");
	releaseCompanyRuntimeLock(claimCompanyRuntimeLock(root));
	for (const entry of readdirSync(root)) {
		rmSync(join(root, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	cpSync(companySource, root, {
		recursive: true,
		filter: (path) => !normalizedPath(path).split(/[\\/]/).includes(RUNTIME_LOCK_DIR_SEGMENT),
	});
	validateCompanyHostStorage(root);
	return { root, safetySnapshot: safety.id };
}

export interface ForkLineage {
	version: 1;
	forkedFrom: { name: string; head: string | null; contractVersion: number };
	forkedAt: string;
}

/**
 * Fork the environment: the fork carries the files, Git history, and trail,
 * a lineage record, and — structurally — no credentials, gate trust,
 * schedules, or standing authority (all machine-local, keyed by root path).
 */
export function forkCompany(companyDir: string, targetDir: string): ImportResult & { lineage: ForkLineage } {
	const root = canonicalCompanyRoot(companyDir);
	const sourceCompany = readCompanyManifest(root);
	const target = resolve(targetDir);
	const staging = `${target}.fork-${randomUUID()}`;
	try {
		const exported = exportCompany(root, staging);
		const imported = importCompany(staging, target);
		const forkedAt = new Date().toISOString();
		const lineage: ForkLineage = {
			version: 1,
			forkedFrom: {
				name: exported.manifest.companyName,
				head: exported.manifest.sourceHead,
				contractVersion: exported.manifest.contractVersion,
			},
			forkedAt,
		};
		const forkManifest: CompanyManifest = {
			schema: COMPANY_MANIFEST_SCHEMA,
			id: randomUUID(),
			name: basename(target),
			createdAt: forkedAt,
			parent: { companyId: sourceCompany.id, state: exported.manifest.sourceHead, forkedAt },
		};
		writeFileSync(
			join(target, COMPANY_MANIFEST_RELATIVE_PATH),
			`${JSON.stringify(forkManifest, null, "\t")}\n`,
			"utf-8",
		);
		writeFileSync(join(target, ".qorpera", "lineage.json"), `${JSON.stringify(lineage, null, "\t")}\n`, "utf-8");
		spawnSync("git", ["-C", target, "add", "--", COMPANY_MANIFEST_RELATIVE_PATH, join(".qorpera", "lineage.json")], {
			stdio: "ignore",
			shell: false,
		});
		spawnSync(
			"git",
			[
				"-C",
				target,
				"-c",
				"user.name=Qorpera Host",
				"-c",
				"user.email=host@qorpera.local",
				"commit",
				"-m",
				"chore: record fork lineage\n\nQorpera-Trigger: environment fork\nQorpera-Rationale: the fork may understand its origin without inheriting its authority",
				"--only",
				"--",
				COMPANY_MANIFEST_RELATIVE_PATH,
				join(".qorpera", "lineage.json"),
			],
			{ stdio: "ignore", shell: false },
		);
		registerCompany(target);
		return { ...imported, head: gitHead(target), lineage };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Erase the company environment: the folder plus every machine-local record
 * this foundation holds for it — connections (secrets, destinations, wake
 * schedule) and snapshots. The registry self-heals (vanished roots are
 * filtered on read). Desktop-host state under the shell's own data
 * directory is keyed by the now-gone root path and becomes inert.
 */
export function eraseCompany(companyDir: string): { root: string; removed: string[] } {
	const root = canonicalCompanyRoot(companyDir);
	validateCompanyHostStorage(root);
	releaseCompanyRuntimeLock(claimCompanyRuntimeLock(root));
	const removed: string[] = [];
	const snapshots = snapshotsDir(root);
	const connections = companyConnectionsPath(root);
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	removed.push(root);
	if (existsSync(connections)) {
		rmSync(connections, { force: true });
		removed.push(connections);
	}
	if (existsSync(snapshots)) {
		rmSync(snapshots, { recursive: true, force: true });
		removed.push(snapshots);
	}
	return { root, removed };
}

// ---- trail playback (build plan §7: inspection, not re-execution) ----------

export interface TrailVerification {
	file: string;
	status: "verified" | "unaudited" | "broken";
	entries: number;
	detail?: string;
}

/**
 * Re-run the trusted-host hash chain over a trail session, outside the runtime.
 * "unaudited" marks sessions with no host envelopes (the serialized field
 * remains `kernel` for trail compatibility); any break in
 * an audited chain is "broken".
 */
export function verifyTrailFile(path: string): TrailVerification {
	const file = basename(path);
	let lines: string[];
	try {
		lines = readFileSync(path, "utf-8")
			.split(/\r?\n/)
			.filter((line) => line.trim());
	} catch (error) {
		return { file, status: "broken", entries: 0, detail: (error as Error).message };
	}
	let header: { type?: unknown };
	try {
		header = JSON.parse(lines[0] ?? "") as { type?: unknown };
	} catch {
		return { file, status: "broken", entries: 0, detail: "unparseable session header" };
	}
	if (header.type !== "session") return { file, status: "broken", entries: 0, detail: "missing session header" };
	let lastHash = "";
	let sequence = 0;
	let audited = false;
	for (const [index, line] of lines.slice(1).entries()) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return { file, status: "broken", entries: index, detail: `unparseable entry at line ${index + 2}` };
		}
		const kernel = entry.kernel as { sequence?: unknown; previousHash?: unknown; hash?: unknown } | undefined;
		if (!kernel) {
			if (audited) return { file, status: "broken", entries: index, detail: `chain gap at line ${index + 2}` };
			continue;
		}
		audited = true;
		const unsigned = { ...entry };
		delete unsigned.kernel;
		const expectedHash = createHash("sha256")
			.update(`${lastHash}\n${JSON.stringify(unsigned)}`)
			.digest("hex");
		if (
			kernel.sequence !== sequence + 1 ||
			kernel.previousHash !== (lastHash || null) ||
			kernel.hash !== expectedHash
		) {
			return { file, status: "broken", entries: index, detail: `integrity break at line ${index + 2}` };
		}
		sequence = kernel.sequence as number;
		lastHash = kernel.hash as string;
	}
	return { file, status: audited ? "verified" : "unaudited", entries: lines.length - 1 };
}

export interface TrailSessionSummary {
	file: string;
	id: string;
	timestamp: string;
	actor?: string;
	label?: string;
}

export function listTrailFiles(companyDir: string): TrailSessionSummary[] {
	const trailDir = join(canonicalCompanyRoot(companyDir), "trail");
	if (!existsSync(trailDir)) return [];
	const sessions: TrailSessionSummary[] = [];
	for (const file of readdirSync(trailDir).filter((name) => name.endsWith(".jsonl"))) {
		try {
			const firstLine = readFileSync(join(trailDir, file), "utf-8").split(/\r?\n/, 1)[0];
			const header = JSON.parse(firstLine) as {
				type?: string;
				id?: string;
				timestamp?: string;
				qorpera?: { actor?: string; label?: string };
			};
			if (header.type !== "session") continue;
			sessions.push({
				file,
				id: header.id ?? "?",
				timestamp: header.timestamp ?? "?",
				actor: header.qorpera?.actor,
				label: header.qorpera?.label,
			});
		} catch {
			// Unreadable session files show up in verify, not list.
		}
	}
	return sessions.sort((a, b) => a.file.localeCompare(b.file));
}

/** One human-readable line per entry — playback is inspection, never re-execution. */
export function renderTrailFile(path: string): string[] {
	const lines = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim());
	const rendered: string[] = [];
	const excerpt = (text: string): string => (text.length > 160 ? `${text.slice(0, 160)}…` : text);
	for (const line of lines) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			rendered.push("[unparseable line]");
			continue;
		}
		if (entry.type === "session") {
			const authority = entry.qorpera as { actor?: string; label?: string } | undefined;
			rendered.push(
				`session ${String(entry.id)} @ ${String(entry.timestamp)} (${authority?.actor ?? "?"}${authority?.label ? `, ${authority.label}` : ""})`,
			);
			continue;
		}
		const kernel = entry.kernel as { sequence?: number } | undefined;
		const prefix = kernel ? `#${kernel.sequence} ` : "";
		if (entry.type === "message") {
			const message = entry.message as { role?: string; content?: Array<{ type?: string; text?: string }> };
			const text = (message.content ?? [])
				.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
				.join(" ")
				.trim();
			rendered.push(`${prefix}${message.role}: ${excerpt(text || "(no text)")}`);
		} else if (entry.type === "custom") {
			rendered.push(`${prefix}${String(entry.customType)}: ${excerpt(JSON.stringify(entry.data ?? {}))}`);
		} else {
			rendered.push(`${prefix}${String(entry.type)}`);
		}
	}
	return rendered;
}

interface ProductIntegrationRecord {
	version: 4;
	productId: string;
	source: string;
	portableSource?: string;
	destination: string;
	staging: string;
	status: "pending" | "completed";
	sourceHead?: string;
	sourceHistory: Array<{
		source: string;
		portableSource?: string;
		sourceHead?: string;
		reboundAt: string;
	}>;
	recoveries: Array<{
		staging: string;
		quarantined: string;
		startedAt: string;
		completedAt?: string;
		outcome?: "quarantined" | "source-storage-unavailable";
		reason: string;
	}>;
}

function normalizedRepositorySource(source: string): string {
	try {
		return normalizedPath(realpathSync(resolve(source)));
	} catch {
		return source.trim();
	}
}

function portableRepositorySource(source: string): string | undefined {
	let candidate: string | undefined;
	try {
		const local = realpathSync(resolve(source));
		candidate = gitOutput(local, ["remote", "get-url", "origin"]);
	} catch {
		candidate = source.trim() || undefined;
	}
	if (candidate && !cloneSourceAllowed(candidate)) {
		throw new Error("Repository origin cannot be persisted because it contains embedded credentials or query data");
	}
	return candidate;
}

function repositoryMatchesSource(repository: string, source: string): boolean {
	const topLevel = gitOutput(repository, ["rev-parse", "--show-toplevel"]);
	const remote = gitOutput(repository, ["remote", "get-url", "origin"]);
	if (!topLevel || !remote) return false;
	return (
		normalizedPath(topLevel) === normalizedPath(repository) &&
		normalizedRepositorySource(remote) === normalizedRepositorySource(source)
	);
}

function stagedCloneMatchesSource(repository: string, source: string): boolean {
	if (!repositoryMatchesSource(repository, source)) return false;
	const status = spawnSync("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"], {
		encoding: "utf-8",
		shell: false,
	});
	return (
		spawnSync("git", ["-C", repository, "rev-parse", "--verify", "HEAD"], { stdio: "ignore", shell: false })
			.status === 0 &&
		spawnSync("git", ["-C", repository, "fsck", "--no-dangling"], { stdio: "ignore", shell: false }).status === 0 &&
		status.status === 0 &&
		typeof status.stdout === "string" &&
		status.stdout.trim() === ""
	);
}

function productIntegrationRecordPath(root: string, productId: string): string {
	return join(root, ".qorpera", "product-integrations", `${productId}.json`);
}

function productIntegrationStorageRoot(root: string, productId: string): string {
	const gitAdmin = canonicalDirectory(root, ".git");
	const storageRoot = join(gitAdmin, "qorpera-product-integrations", productId);
	mkdirSync(join(storageRoot, "attempts"), { recursive: true });
	mkdirSync(join(storageRoot, "quarantine"), { recursive: true });
	return storageRoot;
}

function readProductIntegrationRecord(path: string): ProductIntegrationRecord | undefined {
	if (!existsSync(path)) return undefined;
	const record = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProductIntegrationRecord>;
	if (
		record.version !== 4 ||
		typeof record.productId !== "string" ||
		typeof record.source !== "string" ||
		!repositorySourceAllowed(record.source) ||
		(record.portableSource !== undefined &&
			(typeof record.portableSource !== "string" || !repositorySourceAllowed(record.portableSource))) ||
		typeof record.destination !== "string" ||
		typeof record.staging !== "string" ||
		isAbsolute(record.destination) ||
		!/^[a-f0-9]{12}$/i.test(record.staging) ||
		(record.status !== "pending" && record.status !== "completed") ||
		(record.sourceHead !== undefined && typeof record.sourceHead !== "string") ||
		!Array.isArray(record.sourceHistory) ||
		!record.sourceHistory.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				typeof entry.source === "string" &&
				repositorySourceAllowed(entry.source) &&
				(entry.portableSource === undefined || typeof entry.portableSource === "string") &&
				(entry.portableSource === undefined || repositorySourceAllowed(entry.portableSource)) &&
				(entry.sourceHead === undefined || typeof entry.sourceHead === "string") &&
				typeof entry.reboundAt === "string",
		) ||
		!Array.isArray(record.recoveries) ||
		!record.recoveries.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				typeof entry.staging === "string" &&
				/^[a-f0-9]{12}$/i.test(entry.staging) &&
				typeof entry.quarantined === "string" &&
				/^[a-f0-9]{12}\.failed-[a-f0-9]{12}$/i.test(entry.quarantined) &&
				typeof entry.startedAt === "string" &&
				(entry.completedAt === undefined || typeof entry.completedAt === "string") &&
				(entry.outcome === undefined ||
					entry.outcome === "quarantined" ||
					entry.outcome === "source-storage-unavailable") &&
				((entry.completedAt === undefined && entry.outcome === undefined) ||
					(typeof entry.completedAt === "string" && entry.outcome !== undefined)) &&
				typeof entry.reason === "string",
		)
	) {
		throw new Error("Product integration transaction record is invalid");
	}
	return record as ProductIntegrationRecord;
}

function productIntegrationAttemptPath(root: string, productId: string, id: string): string {
	return join(productIntegrationStorageRoot(root, productId), "attempts", id);
}

function productIntegrationQuarantinePath(root: string, productId: string, id: string): string {
	return join(productIntegrationStorageRoot(root, productId), "quarantine", id);
}

function nextProductIntegrationStaging(root: string, productId: string): { id: string; path: string } {
	const id = randomUUID().replace(/-/g, "").slice(0, 12);
	return {
		id,
		path: productIntegrationAttemptPath(root, productId, id),
	};
}

function reconcileProductIntegrationRecoveries(
	root: string,
	transactionPath: string,
	transaction: ProductIntegrationRecord,
): void {
	let changed = false;
	for (const recovery of transaction.recoveries) {
		if (recovery.completedAt) continue;
		const staging = productIntegrationAttemptPath(root, transaction.productId, recovery.staging);
		const quarantined = productIntegrationQuarantinePath(root, transaction.productId, recovery.quarantined);
		const stagingExists = existsSync(staging);
		const quarantineExists = existsSync(quarantined);
		if (stagingExists && quarantineExists) {
			throw new Error("Incomplete product integration recovery cannot be reconciled without data loss");
		}
		if (stagingExists) {
			renameSync(staging, quarantined);
			recovery.outcome = "quarantined";
		} else if (quarantineExists) {
			recovery.outcome = "quarantined";
		} else {
			recovery.outcome = "source-storage-unavailable";
		}
		recovery.completedAt = new Date().toISOString();
		changed = true;
	}
	if (changed) {
		writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
		checkpointProductIntegrationRecord(
			root,
			transaction.productId,
			"complete an interrupted quarantine move without discarding clone data",
		);
	}
}

function quarantineProductIntegrationAttempt(
	root: string,
	transactionPath: string,
	transaction: ProductIntegrationRecord,
	reason: string,
): string {
	const staging = productIntegrationAttemptPath(root, transaction.productId, transaction.staging);
	const quarantineId = `${transaction.staging}.failed-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const quarantined = productIntegrationQuarantinePath(root, transaction.productId, quarantineId);
	const recovery: ProductIntegrationRecord["recoveries"][number] = {
		staging: transaction.staging,
		quarantined: quarantineId,
		startedAt: new Date().toISOString(),
		reason,
	};
	transaction.recoveries.push(recovery);
	const next = nextProductIntegrationStaging(root, transaction.productId);
	transaction.staging = next.id;
	writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
	checkpointProductIntegrationRecord(root, transaction.productId, "record a quarantine move before changing storage");
	renameSync(staging, quarantined);
	recovery.outcome = "quarantined";
	recovery.completedAt = new Date().toISOString();
	writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
	checkpointProductIntegrationRecord(
		root,
		transaction.productId,
		"attest completion of the preserved quarantine move",
	);
	return next.path;
}

/** Clone an existing repo while its caller owns the company transaction lock. */
function integrateRepoUnlocked(
	root: string,
	from: string,
	product: string,
	storage: ProductTransactionStorage,
): boolean {
	if (!cloneSourceAllowed(from)) return false;
	const portableSource = portableRepositorySource(from);
	const department = scaffoldProductDepartmentUnlocked(root, product, storage);
	assertProductTransactionStorage(storage);
	const destination = join(root, department.repositoryPath);
	const transactionPath = productIntegrationRecordPath(root, department.id);
	let transaction = readProductIntegrationRecord(transactionPath);
	let transactionStaging: string | undefined;
	if (transaction) {
		reconcileProductIntegrationRecoveries(root, transactionPath, transaction);
		transactionStaging = productIntegrationAttemptPath(root, department.id, transaction.staging);
		if (
			transaction.productId !== department.id ||
			transaction.destination.replace(/\\/g, "/") !== department.repositoryPath.replace(/\\/g, "/")
		) {
			throw new Error("Existing product integration transaction is not valid for this product department");
		}
		const sameSource = normalizedRepositorySource(transaction.source) === normalizedRepositorySource(from);
		if (!sameSource) {
			if (transaction.status !== "completed" || existsSync(join(destination, ".git"))) {
				throw new Error("Existing product integration transaction does not match the founder-reviewed source");
			}
			transaction.sourceHistory.push({
				source: transaction.source,
				...(transaction.portableSource ? { portableSource: transaction.portableSource } : {}),
				...(transaction.sourceHead ? { sourceHead: transaction.sourceHead } : {}),
				reboundAt: new Date().toISOString(),
			});
			const next = nextProductIntegrationStaging(root, department.id);
			transaction.source = from;
			transaction.portableSource = portableSource;
			transaction.staging = next.id;
			transaction.status = "pending";
			delete transaction.sourceHead;
			transactionStaging = next.path;
			writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
			checkpointProductIntegrationRecord(
				root,
				department.id,
				"preserve a founder-reviewed repository source rebind",
			);
		} else if (transaction.status === "completed" && !existsSync(join(destination, ".git"))) {
			const next = nextProductIntegrationStaging(root, department.id);
			transaction.staging = next.id;
			transaction.status = "pending";
			transactionStaging = next.path;
			writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
			checkpointProductIntegrationRecord(root, department.id, "prepare clone hydration from the reviewed source");
		}
	}
	if (existsSync(join(destination, ".git"))) {
		if (!repositoryMatchesSource(destination, from)) {
			throw new Error(`${department.repositoryPath} does not match the founder-reviewed repository source`);
		}
		if (transaction?.status === "pending") {
			if (transactionStaging && existsSync(transactionStaging)) {
				throw new Error("Pending product integration has both staged and promoted repositories");
			}
			transaction.status = "completed";
			transaction.sourceHead = gitOutput(destination, ["rev-parse", "HEAD"]);
			writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
			checkpointProductKit(root, department.id);
		}
		console.log(`  kept    ${department.repositoryPath} (verified source)`);
		return true;
	}
	assertProductTransactionStorage(storage);
	canonicalDirectory(root, department.path);
	const destinationEntries = existsSync(destination) ? readdirSync(destination) : [];
	if (destinationEntries.some((entry) => entry !== ".gitkeep")) {
		throw new Error(`${department.repositoryPath} contains an incomplete or unrelated repository`);
	}

	mkdirSync(dirname(transactionPath), { recursive: true });
	if (!transaction) {
		const staging = nextProductIntegrationStaging(root, department.id);
		transaction = {
			version: 4,
			productId: department.id,
			source: from,
			portableSource,
			destination: department.repositoryPath.replace(/\\/g, "/"),
			staging: staging.id,
			status: "pending",
			sourceHistory: [],
			recoveries: [],
		};
		writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
		checkpointProductIntegrationRecord(root, department.id, "establish the recoverable clone transaction before I/O");
		transactionStaging = staging.path;
	}

	if (!transactionStaging) throw new Error("Product integration transaction has no staging identity");
	if (existsSync(transactionStaging) && !stagedCloneMatchesSource(transactionStaging, from)) {
		transactionStaging = quarantineProductIntegrationAttempt(
			root,
			transactionPath,
			transaction,
			"staging clone was incomplete or did not match the reviewed source",
		);
	}
	if (!existsSync(transactionStaging)) {
		if (!cloneInto(from, transactionStaging)) {
			console.error(
				`Could not clone ${from}. The recoverable transaction remains at ${transactionPath}; retry with the same source.`,
			);
			return false;
		}
	}
	if (!stagedCloneMatchesSource(transactionStaging, from)) {
		quarantineProductIntegrationAttempt(
			root,
			transactionPath,
			transaction,
			"completed clone failed repository integrity validation",
		);
		console.error("Staged product repository failed validation; the attempt was preserved and a retry is ready.");
		return false;
	}
	assertProductTransactionStorage(storage);
	if (existsSync(destination)) rmSync(destination, { recursive: true });
	renameSync(transactionStaging, destination);
	canonicalDirectory(root, department.repositoryPath);
	if (!repositoryMatchesSource(destination, from)) {
		throw new Error("Promoted product repository changed identity during integration");
	}
	transaction.status = "completed";
	transaction.sourceHead = gitOutput(destination, ["rev-parse", "HEAD"]);
	writeAtomicText(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`);
	checkpointProductKit(root, department.id);
	console.log(`  cloned  ${from} -> ${department.repositoryPath}`);
	return true;
}

/** Offline integration holds one transaction across registration and clone materialization. */
export function integrateRepo(root: string, from: string, product = basenameOf(from)): boolean {
	const lock = acquireCompanyLock(root, "product-registration");
	try {
		const storage = captureProductTransactionStorage(lock.root);
		return integrateRepoUnlocked(lock.root, from, product, storage);
	} finally {
		releaseCompanyRuntimeLock(lock);
	}
}

/** Desktop-host integration under the already-held runtime transaction. */
export function integrateRepoWithRuntimeLock(
	root: string,
	from: string,
	product: string,
	runtimeLock: CompanyRuntimeLock,
	storage: ProductTransactionStorage,
): ProductDepartment | undefined {
	const resolvedRoot = canonicalCompanyRoot(root);
	assertRuntimeLock(resolvedRoot, runtimeLock);
	if (!integrateRepoUnlocked(resolvedRoot, from, product, storage)) return undefined;
	return productDepartmentFromEntry(resolvedRoot, productDepartmentId(product));
}

/** Ask the OS for a free loopback port, so a no-arg webhook enable still yields a stable persisted endpoint. */
function pickFreeLoopbackPort(): Promise<number> {
	return new Promise((resolvePort, rejectPort) => {
		const probe = createNetServer();
		probe.once("error", rejectPort);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => resolvePort(port));
		});
	});
}

/**
 * Early CLI handlers in the `handlePackageCommand` style. The forking-hub
 * verbs (spec §6.1a): `new` starts or integrates a company, `fork` clones an
 * existing one, `company init` remains the bare scaffold plumbing.
 */
export async function handleCompanyCommand(args: string[]): Promise<boolean> {
	if (args[0] === "new") {
		const rest = args.slice(1);
		const noLaunch = rest.includes("--no-launch");
		const fromIndex = rest.indexOf("--from");
		const from = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
		const positional = rest.filter((arg, index) => !arg.startsWith("--") && index !== fromIndex + 1);
		const dir = positional[0];
		if (!dir || (fromIndex >= 0 && !from)) {
			console.error("Usage: new <dir> [--from <repo-path-or-url>] [--no-launch]");
			process.exitCode = 1;
			return true;
		}
		const result = scaffoldCompany(dir);
		printScaffoldReport(result);
		registerCompany(result.root);
		if (from && !integrateRepo(result.root, from)) {
			process.exitCode = 1;
			return true;
		}
		if (noLaunch) {
			console.log("\nNext: open the company in Qorpera Base desktop.");
			return true;
		}
		process.exitCode = await launchSession(result.root);
		return true;
	}

	if (args[0] === "fork") {
		const source = args[1];
		if (!source) {
			console.error("Usage: fork <company-repo-path-or-url> [dir]");
			process.exitCode = 1;
			return true;
		}
		const dir = args[2] ?? basenameOf(source);
		if (existsSync(dir) && readdirSync(dir).length > 0) {
			console.error(`Destination ${dir} exists and is not empty.`);
			process.exitCode = 1;
			return true;
		}
		if (existsSync(source) && existsSync(join(source, COMPANY_MANIFEST_RELATIVE_PATH))) {
			forkCompany(source, dir);
		} else if (!cloneInto(source, dir)) {
			console.error(`Could not clone ${source}.`);
			process.exitCode = 1;
			return true;
		}
		console.log(`Forked company into ${resolve(dir)}`);
		registerCompany(resolve(dir));
		if (!args.includes("--no-launch")) {
			process.exitCode = await launchSession(resolve(dir));
		}
		return true;
	}

	if (args[0] === "founder") {
		const action = args[1];
		try {
			if (action === "init") {
				const identity = generateFounderIdentity(args.slice(2).join(" ") || undefined);
				console.log(`Founder identity created (${identity.createdAt}). The private key stays on this machine.`);
				console.log("Ratify each company's policy with 'qorpera founder ratify' from its root.");
			} else if (action === "status") {
				const identity = readFounderIdentity();
				if (!identity) console.log("No founder identity on this machine. Create one with 'qorpera founder init'.");
				else {
					console.log(
						`Founder identity${identity.name ? ` (${identity.name})` : ""}, created ${identity.createdAt}.`,
					);
					console.log(
						identity.privateKeyPem ? "Signing: available here." : "Signing: public key only in this context.",
					);
				}
			} else if (action === "ratify") {
				const root = companyRootFromCwd();
				const record = signAuthorityPolicy(root);
				console.log(`Ratified authority.toml (sha256 ${record.contentSha256.slice(0, 12)}…).`);
				console.log("Policy now grants its configured modes; any edit needs re-ratification or everything gates.");
			} else if (action === "approve" && args[2]) {
				const root = companyRootFromCwd();
				const gateFile = join(root, "inbox", `${args[2]}.md`);
				if (!existsSync(gateFile)) throw new Error(`No such gate request: ${args[2]}`);
				const content = readFileSync(gateFile, "utf-8");
				const hash = content.match(/^hash:\s*([a-f0-9]{64})/m)?.[1];
				if (!hash) throw new Error(`${args[2]} carries no request hash`);
				const signature = signGateApproval(args[2], hash);
				const updated = content
					.replace(/^approval:.*\r?\n?/m, "")
					.replace(/^status:.*$/m, "status: approved")
					.replace(/^hash:.*$/m, (line) => `${line}\napproval: ${signature}`);
				writeFileSync(gateFile, updated, "utf-8");
				console.log(`Approved ${args[2]} with your founder signature.`);
			} else {
				console.error("Usage: founder init [name] | status | ratify | approve <gate-id>");
				process.exitCode = 1;
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}

	if (args[0] !== "company") return false;
	const sub = args[1];
	if (sub === "product" && args[2] === "add") {
		const product = args[3];
		const fromIndex = args.indexOf("--from");
		const from = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
		if (!product || (fromIndex >= 0 && !from)) {
			console.error("Usage: company product add <product> [--from <repo-path-or-url>]");
			process.exitCode = 1;
			return true;
		}
		try {
			const root = process.cwd();
			if (!existsSync(join(root, COMPANY_MANIFEST_RELATIVE_PATH))) {
				throw new Error("current directory is not a company root");
			}
			if (from) {
				if (!integrateRepo(root, from, product)) throw new Error("product source clone failed");
			} else {
				scaffoldProductDepartment(root, product);
			}
			console.log(`Added ${productDepartmentId(product)}. Open the company in Qorpera Base.`);
			process.exitCode = 0;
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "destination") {
		const action = args[2];
		const host = args[3];
		try {
			const root = companyRootFromCwd();
			if (action === "add" && host) {
				bindNetworkDestination(root, host, args.slice(4).join(" ") || undefined);
				console.log(
					`Bound destination ${host.toLowerCase()} (HTTPS only). Company agents can now reach it via http_request.`,
				);
			} else if (action === "remove" && host) {
				console.log(
					removeNetworkDestination(root, host) ? `Removed destination ${host}.` : `No such destination: ${host}`,
				);
			} else if (action === "list") {
				const { destinations } = readCompanyConnections(root);
				if (destinations.length === 0) console.log("No bound network destinations.");
				for (const destination of destinations) {
					console.log(
						`${destination.host}${destination.note ? `  — ${destination.note}` : ""}  (bound ${destination.boundAt})`,
					);
				}
			} else {
				console.error("Usage: company destination add <host> [note] | remove <host> | list");
				process.exitCode = 1;
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "secret") {
		const action = args[2];
		const name = args[3];
		try {
			const root = companyRootFromCwd();
			if (action === "set" && name) {
				const raw = (await readAllStdin()).trim();
				if (!raw) throw new Error("Provide the secret on stdin (piped or typed then Ctrl+D/Ctrl+Z)");
				const secret: CompanySecret = args.includes("--oauth2")
					? { kind: "oauth2", ...(JSON.parse(raw) as Omit<OAuth2Secret, "kind">) }
					: { kind: "static", value: raw };
				bindCompanySecret(root, name, secret);
				console.log(
					`Bound secret://${name} (${secret.kind}). The value never enters company files, prompts, or the trail.`,
				);
			} else if (action === "oauth" && name) {
				const flag = (flagName: string): string | undefined => {
					const index = args.indexOf(flagName);
					return index >= 0 ? args[index + 1] : undefined;
				};
				const authUrl = flag("--auth-url");
				const tokenUrl = flag("--token-url");
				const clientId = flag("--client-id");
				if (!authUrl || !tokenUrl || !clientId) {
					throw new Error(
						"Usage: company secret oauth <name> --auth-url <url> --token-url <url> --client-id <id> [--client-secret <secret>] [--scope <scope>]",
					);
				}
				const result = await runOAuthOnboarding(
					root,
					name,
					{
						authUrl,
						tokenUrl,
						clientId,
						clientSecret: flag("--client-secret"),
						scope: flag("--scope"),
					},
					{
						onAuthorizeUrl: (url) => {
							console.log("Open this URL in your browser to authorize (waiting up to 5 minutes):");
							console.log(url);
							openInBrowser(url);
						},
					},
				);
				console.log(
					result.kind === "oauth2"
						? `Bound secret://${name} (oauth2${result.expiresAt ? `, refreshes automatically` : ""}). Tokens went straight to the trusted local store — nothing to paste.`
						: `Bound secret://${name} (static — the provider returned no refresh token, so it will not auto-refresh).`,
				);
			} else if (action === "remove" && name) {
				console.log(removeCompanySecret(root, name) ? `Removed secret://${name}.` : `No such secret: ${name}`);
			} else if (action === "list") {
				const { secretNames } = readCompanyConnections(root);
				if (secretNames.length === 0) console.log("No bound secrets.");
				for (const secretName of secretNames) console.log(`secret://${secretName}`);
			} else {
				console.error(
					"Usage: company secret set <name> [--oauth2] (value/JSON on stdin) | oauth <name> --auth-url … --token-url … --client-id … | remove <name> | list",
				);
				process.exitCode = 1;
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "snapshot") {
		try {
			const record = snapshotCompany(companyRootFromCwd(), args[2]);
			console.log(
				`Snapshot ${record.id} (head ${record.sourceHead ?? "none"}, contract v${record.contractVersion}).`,
			);
			console.log(`Stored outside the company at ${record.path} — plain files, inspectable without Qorpera.`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "snapshots") {
		try {
			const records = listSnapshots(companyRootFromCwd());
			if (records.length === 0) console.log("No snapshots.");
			for (const record of records) console.log(`${record.id}  head ${record.sourceHead ?? "none"}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "restore") {
		const snapshotId = args[2];
		if (!snapshotId) {
			console.error("Usage: company restore <snapshot-id> (see 'company snapshots'; company must not be open)");
			process.exitCode = 1;
			return true;
		}
		try {
			const result = restoreCompany(companyRootFromCwd(), snapshotId);
			console.log(`Restored ${result.root} to ${snapshotId}.`);
			console.log(
				`The replaced state was captured first as snapshot ${result.safetySnapshot} — restore is reversible.`,
			);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "fork") {
		const dir = args[2];
		if (!dir) {
			console.error("Usage: company fork <target-dir> (run from the company root)");
			process.exitCode = 1;
			return true;
		}
		try {
			const result = forkCompany(companyRootFromCwd(), dir);
			console.log(`Forked into ${result.root} (lineage recorded, head ${result.head ?? "none"}).`);
			console.log(
				"The fork carries files, history, and trail — no credentials, schedules, signatures, or standing authority.",
			);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "erase") {
		if (!args.includes("--force")) {
			console.error(
				"company erase permanently deletes the company folder, its secrets, destinations, routine state, and snapshots. Re-run with --force to proceed.",
			);
			process.exitCode = 1;
			return true;
		}
		try {
			const result = eraseCompany(companyRootFromCwd());
			for (const path of result.removed) console.log(`removed ${path}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "trail") {
		const action = args[2];
		try {
			const root = companyRootFromCwd();
			if (action === "list") {
				const sessions = listTrailFiles(root);
				if (sessions.length === 0) console.log("No trail sessions.");
				for (const session of sessions) {
					console.log(
						`${session.file}  ${session.timestamp}  ${session.actor ?? "?"}${session.label ? `  (${session.label})` : ""}`,
					);
				}
			} else if (action === "verify") {
				const targets = args[3] ? [args[3]] : listTrailFiles(root).map((session) => session.file);
				let broken = 0;
				for (const file of targets) {
					const result = verifyTrailFile(join(root, "trail", file));
					if (result.status === "broken") broken++;
					console.log(
						`${result.status.padEnd(9)} ${result.file} (${result.entries} entries)${result.detail ? ` — ${result.detail}` : ""}`,
					);
				}
				if (broken > 0) process.exitCode = 1;
			} else if (action === "show" && args[3]) {
				for (const line of renderTrailFile(join(root, "trail", args[3]))) console.log(line);
			} else {
				console.error("Usage: company trail list | verify [file] | show <file>");
				process.exitCode = 1;
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "webhook") {
		const action = args[2];
		try {
			const root = companyRootFromCwd();
			if (action === "enable") {
				// The port is always concrete and persisted: a founder cannot
				// point a tunnel or provider at an endpoint that moves.
				const explicit = args[3] ? Number(args[3]) : undefined;
				const port = explicit ?? readWebhookBinding(root)?.port ?? (await pickFreeLoopbackPort());
				const binding = enableWebhook(root, port);
				console.log(
					`Inbound webhooks enabled. While the company is open, Qorpera listens at http://127.0.0.1:${binding.port}/hook/${binding.token}`,
				);
				console.log(
					"Local loopback only — expose it through a tunnel or reverse proxy of your choosing if a provider must reach it. Events land in inbox/events/ and trigger matching agent routines.",
				);
			} else if (action === "disable") {
				console.log(disableWebhook(root) ? "Inbound webhooks disabled." : "Inbound webhooks were not enabled.");
			} else if (action === "status") {
				const binding = readWebhookBinding(root);
				if (!binding?.enabled) console.log("Inbound webhooks are off by default.");
				else if (binding.port === undefined) {
					// Enabled before ports were persisted: the host records one
					// at the next company open; re-running enable fixes it now.
					console.log(
						`Enabled, but no port is persisted yet. Re-run 'company webhook enable' to fix one; token /hook/${binding.token}`,
					);
				} else console.log(`Enabled: http://127.0.0.1:${binding.port}/hook/${binding.token}`);
			} else {
				console.error("Usage: company webhook enable [port] | disable | status");
				process.exitCode = 1;
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "export") {
		const target = args[2];
		if (!target) {
			console.error("Usage: company export <target-dir> (run from the company root; company must not be open)");
			process.exitCode = 1;
			return true;
		}
		try {
			const result = exportCompany(process.cwd(), target);
			console.log(
				`Exported company to ${result.target} (contract v${result.manifest.contractVersion}, head ${result.manifest.sourceHead ?? "none"}).`,
			);
			console.log("The export is plain files — Git history, JSONL trail, markdown — inspectable without Qorpera.");
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub === "import") {
		const source = args[2];
		const dir = args[3];
		if (!source || !dir) {
			console.error("Usage: company import <export-dir> <target-dir>");
			process.exitCode = 1;
			return true;
		}
		try {
			const result = importCompany(source, dir);
			console.log(
				`Imported company into ${result.root} (contract v${result.manifest.contractVersion}, head ${result.head ?? "none"}).`,
			);
			console.log("Fresh environment identity: no credentials, schedules, or standing authority were imported.");
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub !== "init") {
		console.error(
			`Unknown company command: ${sub ?? "(none)"}. Usage: company init [dir] | export | import | snapshot [label] | snapshots | restore <id> | fork <dir> | erase --force | trail list|verify|show | destination … | secret …`,
		);
		process.exitCode = 1;
		return true;
	}
	const dir = args[2] ?? process.cwd();
	const result = scaffoldCompany(dir);
	printScaffoldReport(result);
	registerCompany(result.root);
	console.log("\nNext: open the company in Qorpera Base desktop and hire its first agent.");
	return true;
}

function companyRootFromCwd(): string {
	const root = process.cwd();
	if (!existsSync(join(root, COMPANY_MANIFEST_RELATIVE_PATH))) {
		throw new Error("current directory is not a company root");
	}
	return root;
}

/** Best-effort: open the founder's browser at a URL; the URL is printed either way. */
function openInBrowser(url: string): void {
	const attempt =
		process.platform === "win32"
			? spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", shell: false })
			: process.platform === "darwin"
				? spawnSync("open", [url], { stdio: "ignore", shell: false })
				: spawnSync("xdg-open", [url], { stdio: "ignore", shell: false });
	void attempt;
}

function readAllStdin(): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.once("end", () => resolvePromise(data));
		process.stdin.once("error", rejectPromise);
	});
}

function basenameOf(source: string): string {
	const cleaned = source.replace(/\.git$/, "").replace(/[/\\]+$/, "");
	const segments = cleaned.split(/[/\\]/);
	return segments[segments.length - 1] || "company";
}

// ---- company registry (the hub's memory) ----------------------------------

export interface CompanyRecord {
	root: string;
	name: string;
	lastOpened: string;
}

function registryPath(): string {
	return join(getAgentDir(), "companies.json");
}

/** Companies known to this machine; roots that stopped being companies are filtered out. */
export function listCompanies(): CompanyRecord[] {
	try {
		const records = JSON.parse(readFileSync(registryPath(), "utf-8")) as CompanyRecord[];
		if (!Array.isArray(records)) return [];
		return records
			.filter(
				(record) =>
					record &&
					typeof record.root === "string" &&
					existsSync(join(record.root, COMPANY_MANIFEST_RELATIVE_PATH)),
			)
			.sort((a, b) => (b.lastOpened ?? "").localeCompare(a.lastOpened ?? ""));
	} catch {
		return [];
	}
}

export function registerCompany(rootDir: string): void {
	const root = canonicalCompanyRoot(rootDir);
	const name = readCompanyManifest(root).name;
	const existing = listCompanies().filter((record) => {
		try {
			return normalizedPath(canonicalCompanyRoot(record.root)) !== normalizedPath(root);
		} catch {
			return false;
		}
	});
	const records: CompanyRecord[] = [{ root, name, lastOpened: new Date().toISOString() }, ...existing];
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(registryPath(), `${JSON.stringify(records, null, "\t")}\n`, "utf-8");
	} catch {
		// The registry is a convenience; failure to write it never blocks a session.
	}
}

/** Remove a company from this machine's company selector without touching its files. */
export function unregisterCompany(rootDir: string): boolean {
	const root = canonicalCompanyRoot(rootDir);
	const records = listCompanies().filter((record) => {
		try {
			return normalizedPath(canonicalCompanyRoot(record.root)) !== normalizedPath(root);
		} catch {
			return false;
		}
	});
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(registryPath(), `${JSON.stringify(records, null, "\t")}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ---- the hub ---------------------------------------------------------------

function askLine(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolvePromise) => {
		rl.question(question, (answer) => {
			rl.close();
			resolvePromise(answer.trim());
		});
	});
}

type HubChoice = { kind: "enter"; root: string } | { kind: "new" } | { kind: "integrate" } | { kind: "plain" };

/**
 * The forking hub (spec §6.1a): bare `qorpera` outside a company offers
 * enter / new / integrate / plain-session. Returns undefined to continue
 * normal startup (plain session), or an exit code when it ran a session.
 */
export async function runCompanyHub(
	showSelector: (title: string, options: Array<{ label: string; value: HubChoice }>) => Promise<HubChoice | undefined>,
): Promise<number | undefined> {
	const companies = listCompanies();
	const options: Array<{ label: string; value: HubChoice }> = [
		...companies.map((company) => ({
			label: `Enter ${company.name}  (${company.root})`,
			value: { kind: "enter", root: company.root } as HubChoice,
		})),
		{ label: "New company…", value: { kind: "new" } },
		{ label: "Integrate an existing repo into a new company…", value: { kind: "integrate" } },
		{ label: "Plain session in this directory", value: { kind: "plain" } },
	];
	const choice = await showSelector("Qorpera — company hub", options);
	if (choice === undefined) return 0; // esc/ctrl-c: quit
	switch (choice.kind) {
		case "plain":
			return undefined;
		case "enter": {
			registerCompany(choice.root);
			return await launchSession(choice.root);
		}
		case "new":
		case "integrate": {
			const dir = await askLine("Directory for the new company (e.g. C:\\Companies\\my-co): ");
			if (!dir) return 0;
			const from =
				choice.kind === "integrate" ? await askLine("Existing repo to integrate (path or git URL): ") : "";
			if (choice.kind === "integrate" && !from) return 0;
			const result = scaffoldCompany(dir);
			printScaffoldReport(result);
			registerCompany(result.root);
			if (from && !integrateRepo(result.root, from)) return 1;
			return await launchSession(result.root);
		}
	}
}
