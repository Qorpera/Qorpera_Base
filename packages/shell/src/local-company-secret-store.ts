import { readCompanyManifest } from "@qorpera/pi-coding-agent/company";
import type { CompanySecretStore } from "@qorpera/pi-coding-agent/company-connections";
import {
	type CompanySecretProtector,
	createProtectedCompanySecretVault,
	exportPortableCompanyCredentials,
	importPortableCompanyCredentials,
	type PortableCompanyCredentialImportOptions,
	type PortableCompanyCredentialImportResult,
	protectedCompanySecretVaultPath,
} from "@qorpera/pi-coding-agent/company-secret-vault";

export interface LocalCompanySecretStore extends CompanySecretStore {
	exportCredentials(root: string, passphrase: string): string;
	importCredentials(
		root: string,
		serialized: string,
		passphrase: string,
		options?: PortableCompanyCredentialImportOptions,
	): PortableCompanyCredentialImportResult;
}

/** Machine-local credential store keyed by durable company identity. Moving
 * the same company folder keeps access on this OS account; a new company or
 * proper fork has a new id and therefore starts without bindings. */
export function createLocalCompanySecretStore(
	vaultRoot: string,
	protector: CompanySecretProtector,
): LocalCompanySecretStore {
	const company = (root: string) => readCompanyManifest(root);
	const vault = (root: string) => {
		return createProtectedCompanySecretVault(
			protectedCompanySecretVaultPath(vaultRoot, `local-company:${company(root).id}`),
			protector,
		);
	};
	return {
		list: (root) => vault(root).list(),
		get: (root, name) => vault(root).get(name),
		put: (root, name, secret) => vault(root).put(name, secret),
		remove: (root, name) => vault(root).remove(name),
		exportCredentials: (root, passphrase) =>
			exportPortableCompanyCredentials(vault(root), company(root).id, passphrase),
		importCredentials: (root, serialized, passphrase, options) =>
			importPortableCompanyCredentials(vault(root), company(root).id, serialized, passphrase, options),
	};
}
