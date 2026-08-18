export type CompanyConnectionScope = "machine" | "company";

export interface CompanyConnectionCapabilities {
	hostedCompanyState: boolean;
	managedComputer: boolean;
}

export interface CompanyConnectionStoragePolicy {
	companyState: "local-company-files" | "hosted-primary";
	credentialVault: "local-os-vault" | "hosted-kms-vault";
	credentialPortability: "explicit-encrypted-transfer" | "company-vault";
	providerAccess: "local-connector-broker" | "hosted-connector-gateway";
	materializedData: "local-company-files" | "hosted-primary";
	rawProviderData: "source-only";
}

/**
 * Company manifests, artifact definitions, and evidence references remain
 * portable company content. Credential placement follows who must execute the
 * connection: company-shared and remotely executed connections need a hosted
 * vault/gateway; a machine-only connection can remain in the local OS vault.
 */
export function companyConnectionStoragePolicy(
	capabilities: CompanyConnectionCapabilities,
	scope: CompanyConnectionScope = "company",
): CompanyConnectionStoragePolicy {
	const hostedCredential = capabilities.managedComputer || (scope === "company" && capabilities.hostedCompanyState);
	return {
		companyState: capabilities.hostedCompanyState ? "hosted-primary" : "local-company-files",
		credentialVault: hostedCredential ? "hosted-kms-vault" : "local-os-vault",
		credentialPortability: hostedCredential ? "company-vault" : "explicit-encrypted-transfer",
		providerAccess: hostedCredential ? "hosted-connector-gateway" : "local-connector-broker",
		materializedData: capabilities.hostedCompanyState ? "hosted-primary" : "local-company-files",
		rawProviderData: "source-only",
	};
}
