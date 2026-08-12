import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ProductStorageExpectation {
	path: string;
	kind: "repository" | "worktree";
	remote: string;
	head?: string;
	branch?: string;
}

export interface PendingGateCreation {
	file: string;
	hash: string;
	trailFile: string;
	startedAt: string;
	phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted";
}

interface TrustedGateRecord {
	file: string;
	establishedAt: string;
}

interface HydratedProductStorage extends ProductStorageExpectation {
	storageIdentity: string;
	observedHead: string;
}

interface CompanyKernelState {
	version: 3;
	root: string;
	rootIdentity: string;
	trustedGates: Record<string, TrustedGateRecord>;
	pendingGateCreations: Record<string, PendingGateCreation>;
	hydratedProductStorage: HydratedProductStorage[];
	unhydratedProductStorage: ProductStorageExpectation[];
}

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalRoot(root: string): string {
	return realpathSync(resolve(root));
}

function rootId(root: string): string {
	return createHash("sha256").update(normalizedPath(root)).digest("hex");
}

function rootIdentity(root: string): string {
	const entry = lstatSync(root, { bigint: true });
	if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Company kernel state requires a physical root");
	return `${entry.dev.toString(16)}:${entry.ino.toString(16)}:${entry.birthtimeNs.toString(16)}`;
}

export function companyKernelStatePath(userData: string, root: string): string {
	return join(userData, "company-kernel-state", rootId(canonicalRoot(root)), "state.json");
}

function emptyState(root: string): CompanyKernelState {
	return {
		version: 3,
		root,
		rootIdentity: rootIdentity(root),
		trustedGates: {},
		pendingGateCreations: {},
		hydratedProductStorage: [],
		unhydratedProductStorage: [],
	};
}

function validStorageExpectation(value: unknown): value is ProductStorageExpectation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<ProductStorageExpectation>;
	return (
		typeof candidate.path === "string" &&
		!isAbsolute(candidate.path) &&
		!candidate.path.split(/[\\/]+/).some((part) => part === "..") &&
		(candidate.kind === "repository" || candidate.kind === "worktree") &&
		typeof candidate.remote === "string" &&
		candidate.remote.length > 0 &&
		(candidate.head === undefined || /^[a-f0-9]{40,64}$/i.test(candidate.head)) &&
		(candidate.branch === undefined || (typeof candidate.branch === "string" && candidate.branch.length > 0)) &&
		(candidate.kind === "worktree" || candidate.branch === undefined)
	);
}

function validHydratedProductStorage(value: unknown): value is HydratedProductStorage {
	if (!validStorageExpectation(value)) return false;
	const candidate = value as Partial<HydratedProductStorage>;
	return (
		typeof candidate.storageIdentity === "string" &&
		/^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+\|[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/i.test(candidate.storageIdentity) &&
		typeof candidate.observedHead === "string" &&
		/^[a-f0-9]{40,64}$/i.test(candidate.observedHead)
	);
}

function readState(userData: string, root: string): CompanyKernelState | undefined {
	const canonical = canonicalRoot(root);
	const path = companyKernelStatePath(userData, canonical);
	if (!existsSync(path)) return undefined;
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
		throw new Error("Company kernel state must be one physical file");
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CompanyKernelState>;
	if (
		parsed.version !== 3 ||
		typeof parsed.root !== "string" ||
		normalizedPath(parsed.root) !== normalizedPath(canonical) ||
		parsed.rootIdentity !== rootIdentity(canonical) ||
		!parsed.trustedGates ||
		typeof parsed.trustedGates !== "object" ||
		Array.isArray(parsed.trustedGates) ||
		!parsed.pendingGateCreations ||
		typeof parsed.pendingGateCreations !== "object" ||
		Array.isArray(parsed.pendingGateCreations) ||
		!Array.isArray(parsed.hydratedProductStorage) ||
		!parsed.hydratedProductStorage.every(validHydratedProductStorage) ||
		!Array.isArray(parsed.unhydratedProductStorage) ||
		!parsed.unhydratedProductStorage.every(validStorageExpectation)
	) {
		throw new Error("Company kernel state is invalid");
	}
	for (const [hash, record] of Object.entries(parsed.trustedGates)) {
		if (
			!/^[a-f0-9]{64}$/.test(hash) ||
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			typeof record.file !== "string" ||
			typeof record.establishedAt !== "string"
		) {
			throw new Error("Company kernel trust state is invalid");
		}
	}
	for (const [file, record] of Object.entries(parsed.pendingGateCreations)) {
		if (
			!/^gate-[a-f0-9-]+\.md$/i.test(file) ||
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			record.file !== file ||
			!/^[a-f0-9]{64}$/.test(record.hash) ||
			!/^[^/\\]+\.jsonl$/i.test(record.trailFile) ||
			typeof record.startedAt !== "string" ||
			!(["planned", "started", "finalizing-created", "finalizing-aborted"] as const).includes(record.phase)
		) {
			throw new Error("Company kernel gate-creation state is invalid");
		}
	}
	return parsed as CompanyKernelState;
}

function writeState(userData: string, state: CompanyKernelState): void {
	const path = companyKernelStatePath(userData, state.root);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
	renameSync(temporary, path);
}

function updateState(userData: string, root: string, mutate: (state: CompanyKernelState) => void): void {
	const canonical = canonicalRoot(root);
	const state = readState(userData, canonical) ?? emptyState(canonical);
	mutate(state);
	writeState(userData, state);
}

export function hasCompanyKernelState(userData: string, root: string): boolean {
	return readState(userData, root) !== undefined;
}

export function hasCompanyGateTrust(userData: string, root: string, file: string, hash: string): boolean {
	const state = readState(userData, root);
	return state?.trustedGates[hash]?.file === file;
}

export function rememberCompanyGateTrust(userData: string, root: string, file: string, hash: string): void {
	if (!/^gate-[a-f0-9-]+\.md$/i.test(file) || !/^[a-f0-9]{64}$/.test(hash)) {
		throw new Error("Company gate trust identity is invalid");
	}
	updateState(userData, root, (state) => {
		state.trustedGates[hash] = { file, establishedAt: new Date().toISOString() };
	});
}

export function revokeCompanyGateTrust(userData: string, root: string, file: string, hash: string): void {
	updateState(userData, root, (state) => {
		if (state.trustedGates[hash]?.file === file) delete state.trustedGates[hash];
	});
}

export function listPendingCompanyGateCreations(userData: string, root: string): PendingGateCreation[] {
	return Object.values(readState(userData, root)?.pendingGateCreations ?? {}).map((record) => ({ ...record }));
}

export function beginCompanyGateCreation(
	userData: string,
	root: string,
	file: string,
	hash: string,
	trailFile: string,
): void {
	if (!/^gate-[a-f0-9-]+\.md$/i.test(file) || !/^[a-f0-9]{64}$/.test(hash) || !/^[^/\\]+\.jsonl$/i.test(trailFile)) {
		throw new Error("Company gate-creation identity is invalid");
	}
	updateState(userData, root, (state) => {
		if (state.pendingGateCreations[file]) throw new Error("Company gate creation is already pending");
		state.pendingGateCreations[file] = {
			file,
			hash,
			trailFile,
			startedAt: new Date().toISOString(),
			phase: "planned",
		};
	});
}

export function advanceCompanyGateCreation(
	userData: string,
	root: string,
	file: string,
	hash: string,
	trailFile: string,
	phase: PendingGateCreation["phase"],
): void {
	if (!/^[^/\\]+\.jsonl$/i.test(trailFile)) {
		throw new Error("Company gate-creation phase is invalid");
	}
	updateState(userData, root, (state) => {
		const record = state.pendingGateCreations[file];
		if (!record || record.hash !== hash) throw new Error("Company gate creation is not pending");
		const allowed =
			(record.phase === "planned" && (phase === "planned" || phase === "started")) ||
			(record.phase === "started" && (phase === "finalizing-created" || phase === "finalizing-aborted")) ||
			(record.phase === phase && (phase === "finalizing-created" || phase === "finalizing-aborted"));
		if (!allowed) throw new Error("Company gate-creation phase transition is invalid");
		record.trailFile = trailFile;
		record.phase = phase;
	});
}

export function completeCompanyGateCreation(userData: string, root: string, file: string, hash: string): void {
	updateState(userData, root, (state) => {
		if (state.pendingGateCreations[file]?.hash === hash) delete state.pendingGateCreations[file];
	});
}

function expectationKey(expectation: ProductStorageExpectation): string {
	return `${expectation.kind}:${expectation.path.replace(/\\/g, "/")}`;
}

function gitOutput(root: string, args: string[]): string | undefined {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", shell: false, windowsHide: true });
	return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function normalizedRepositorySource(source: string): string {
	try {
		return normalizedPath(realpathSync(resolve(source)));
	} catch {
		return process.platform === "win32" ? source.trim().toLowerCase() : source.trim();
	}
}

function storageFingerprint(
	root: string,
	expectation: ProductStorageExpectation,
): { storageIdentity: string; observedHead: string } | undefined {
	const target = resolve(root, expectation.path);
	const rootRelative = relative(root, target);
	if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative) || !existsSync(target))
		return undefined;
	try {
		const git = join(target, ".git");
		const physical =
			normalizedPath(realpathSync(target)) === normalizedPath(target) &&
			lstatSync(target).isDirectory() &&
			existsSync(git) &&
			normalizedPath(realpathSync(git)) === normalizedPath(git) &&
			lstatSync(git).isDirectory();
		if (!physical) return undefined;
		const topLevel = gitOutput(target, ["rev-parse", "--show-toplevel"]);
		const remote = gitOutput(target, ["remote", "get-url", "origin"]);
		if (
			!topLevel ||
			normalizedPath(topLevel) !== normalizedPath(target) ||
			!remote ||
			normalizedRepositorySource(remote) !== normalizedRepositorySource(expectation.remote) ||
			(expectation.branch !== undefined && gitOutput(target, ["branch", "--show-current"]) !== expectation.branch)
		)
			return undefined;
		if (
			expectation.head !== undefined &&
			spawnSync("git", ["-C", target, "merge-base", "--is-ancestor", expectation.head, "HEAD"], {
				stdio: "ignore",
				shell: false,
				windowsHide: true,
			}).status !== 0
		)
			return undefined;
		const observedHead = gitOutput(target, ["rev-parse", "HEAD"]);
		if (!observedHead || !/^[a-f0-9]{40,64}$/i.test(observedHead)) return undefined;
		return { storageIdentity: `${rootIdentity(target)}|${rootIdentity(git)}`, observedHead };
	} catch {
		return undefined;
	}
}

/**
 * Bind clone-local product hydration outside company Git. The first local
 * binding may record company-cloned assignments as unhydrated; after that,
 * disappearance of storage previously observed on this machine fails closed.
 */
export function reconcileCompanyProductStorage(
	userData: string,
	root: string,
	expectations: ProductStorageExpectation[],
	allowInitialUnhydrated: boolean,
): { hydrated: ProductStorageExpectation[]; unhydrated: ProductStorageExpectation[] } {
	const canonical = canonicalRoot(root);
	const existing = readState(userData, canonical);
	const state = existing ?? emptyState(canonical);
	const hydrated = new Map(state.hydratedProductStorage.map((entry) => [expectationKey(entry), entry]));
	const unhydrated = new Map(state.unhydratedProductStorage.map((entry) => [expectationKey(entry), entry]));
	const expectedKeys = new Set(expectations.map(expectationKey));
	for (const key of hydrated.keys()) if (!expectedKeys.has(key)) hydrated.delete(key);
	for (const key of unhydrated.keys()) if (!expectedKeys.has(key)) unhydrated.delete(key);
	for (const expectation of expectations) {
		if (!validStorageExpectation(expectation)) throw new Error("Product storage expectation is invalid");
		const key = expectationKey(expectation);
		const fingerprint = storageFingerprint(canonical, expectation);
		if (fingerprint) {
			const previous = hydrated.get(key);
			if (previous && previous.storageIdentity !== fingerprint.storageIdentity) {
				throw new Error(`Previously hydrated product ${expectation.kind} identity changed: ${expectation.path}`);
			}
			if (
				previous &&
				previous.observedHead !== fingerprint.observedHead &&
				spawnSync(
					"git",
					[
						"-C",
						resolve(canonical, expectation.path),
						"merge-base",
						"--is-ancestor",
						previous.observedHead,
						fingerprint.observedHead,
					],
					{
						stdio: "ignore",
						shell: false,
						windowsHide: true,
					},
				).status !== 0
			) {
				throw new Error(
					`Previously hydrated product ${expectation.kind} history moved backward: ${expectation.path}`,
				);
			}
			hydrated.set(key, { ...expectation, ...fingerprint });
			unhydrated.delete(key);
			continue;
		}
		if (hydrated.has(key)) {
			throw new Error(`Previously hydrated product ${expectation.kind} is missing: ${expectation.path}`);
		}
		if (!unhydrated.has(key)) {
			if (!allowInitialUnhydrated || existing) {
				throw new Error(`New product ${expectation.kind} record has no local storage: ${expectation.path}`);
			}
		}
		unhydrated.set(key, expectation);
	}
	state.hydratedProductStorage = [...hydrated.values()].sort((a, b) =>
		expectationKey(a).localeCompare(expectationKey(b)),
	);
	state.unhydratedProductStorage = [...unhydrated.values()].sort((a, b) =>
		expectationKey(a).localeCompare(expectationKey(b)),
	);
	writeState(userData, state);
	return {
		hydrated: state.hydratedProductStorage.map(
			({ storageIdentity: _storageIdentity, observedHead: _observedHead, ...entry }) => entry,
		),
		unhydrated: [...state.unhydratedProductStorage],
	};
}
