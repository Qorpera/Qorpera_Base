import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ProductStorageExpectation {
	path: string;
	kind: "repository" | "worktree";
}

interface TrustedGateRecord {
	file: string;
	establishedAt: string;
}

interface CompanyKernelState {
	version: 2;
	root: string;
	rootIdentity: string;
	trustedGates: Record<string, TrustedGateRecord>;
	hydratedProductStorage: ProductStorageExpectation[];
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
	return `${entry.dev.toString(16)}:${entry.ino.toString(16)}`;
}

export function companyKernelStatePath(userData: string, root: string): string {
	return join(userData, "company-kernel-state", rootId(canonicalRoot(root)), "state.json");
}

function emptyState(root: string): CompanyKernelState {
	return {
		version: 2,
		root,
		rootIdentity: rootIdentity(root),
		trustedGates: {},
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
		(candidate.kind === "repository" || candidate.kind === "worktree")
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
		parsed.version !== 2 ||
		typeof parsed.root !== "string" ||
		normalizedPath(parsed.root) !== normalizedPath(canonical) ||
		parsed.rootIdentity !== rootIdentity(canonical) ||
		!parsed.trustedGates ||
		typeof parsed.trustedGates !== "object" ||
		Array.isArray(parsed.trustedGates) ||
		!Array.isArray(parsed.hydratedProductStorage) ||
		!parsed.hydratedProductStorage.every(validStorageExpectation) ||
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

function expectationKey(expectation: ProductStorageExpectation): string {
	return `${expectation.kind}:${expectation.path.replace(/\\/g, "/")}`;
}

function storageIsHydrated(root: string, expectation: ProductStorageExpectation): boolean {
	const target = resolve(root, expectation.path);
	const rootRelative = relative(root, target);
	if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative) || !existsSync(target)) return false;
	try {
		const git = join(target, ".git");
		return (
			normalizedPath(realpathSync(target)) === normalizedPath(target) &&
			lstatSync(target).isDirectory() &&
			existsSync(git) &&
			normalizedPath(realpathSync(git)) === normalizedPath(git) &&
			lstatSync(git).isDirectory()
		);
	} catch {
		return false;
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
	for (const expectation of expectations) {
		if (!validStorageExpectation(expectation)) throw new Error("Product storage expectation is invalid");
		const key = expectationKey(expectation);
		if (storageIsHydrated(canonical, expectation)) {
			hydrated.set(key, expectation);
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
			unhydrated.set(key, expectation);
		}
	}
	state.hydratedProductStorage = [...hydrated.values()].sort((a, b) =>
		expectationKey(a).localeCompare(expectationKey(b)),
	);
	state.unhydratedProductStorage = [...unhydrated.values()].sort((a, b) =>
		expectationKey(a).localeCompare(expectationKey(b)),
	);
	writeState(userData, state);
	return {
		hydrated: [...state.hydratedProductStorage],
		unhydrated: [...state.unhydratedProductStorage],
	};
}
