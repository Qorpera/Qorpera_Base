import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";

const COMPANY_HOST_STORAGE_DIRECTORY = "company-host-state";
const LEGACY_COMPANY_HOST_STORAGE_DIRECTORY = "company-kernel-state";

function assertPhysicalDirectory(path: string): void {
	const entry = lstatSync(path);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error("Company host storage must use physical directories");
	}
}

/**
 * Resolve one machine-local host file and lazily move its retired storage
 * location. File-by-file migration avoids overwriting newer host state when
 * both namespaces exist after an interrupted upgrade.
 */
export function companyHostStorageFile(userData: string, companyId: string, file: string): string {
	if (!/^[a-f0-9]{64}$/i.test(companyId) || !/^[a-z0-9][a-z0-9._-]*$/i.test(file)) {
		throw new Error("Company host storage identity is invalid");
	}
	const current = join(userData, COMPANY_HOST_STORAGE_DIRECTORY, companyId, file);
	if (existsSync(current)) return current;
	const legacyNamespace = join(userData, LEGACY_COMPANY_HOST_STORAGE_DIRECTORY);
	const legacyDirectory = join(legacyNamespace, companyId);
	const legacy = join(legacyDirectory, file);
	if (!existsSync(legacy)) return current;

	assertPhysicalDirectory(legacyNamespace);
	assertPhysicalDirectory(legacyDirectory);
	const legacyEntry = lstatSync(legacy);
	if (!legacyEntry.isFile() || legacyEntry.isSymbolicLink() || legacyEntry.nlink !== 1) {
		throw new Error("Legacy company host state must be one physical file");
	}
	const currentNamespace = join(userData, COMPANY_HOST_STORAGE_DIRECTORY);
	if (existsSync(currentNamespace)) assertPhysicalDirectory(currentNamespace);
	else mkdirSync(currentNamespace, { mode: 0o700 });
	const currentDirectory = dirname(current);
	if (existsSync(currentDirectory)) assertPhysicalDirectory(currentDirectory);
	else mkdirSync(currentDirectory, { mode: 0o700 });
	if (!existsSync(current)) {
		renameSync(legacy, current);
		try {
			rmdirSync(legacyDirectory);
			rmdirSync(legacyNamespace);
		} catch {
			// Other retired files still await their own migration.
		}
	}
	return current;
}
