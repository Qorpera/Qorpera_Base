import { describe, expect, it } from "vitest";
import { companyConnectionStoragePolicy } from "../src/company-connection-storage.ts";

describe("company connection storage policy", () => {
	it("keeps local company connections and materialized data local", () => {
		expect(companyConnectionStoragePolicy({ hostedCompanyState: false, managedComputer: false })).toEqual({
			companyState: "local-company-files",
			credentialVault: "local-os-vault",
			credentialPortability: "explicit-encrypted-transfer",
			providerAccess: "local-connector-broker",
			materializedData: "local-company-files",
			rawProviderData: "source-only",
		});
	});

	it("routes hosted company connections through the hosted vault and gateway", () => {
		expect(companyConnectionStoragePolicy({ hostedCompanyState: true, managedComputer: false })).toEqual({
			companyState: "hosted-primary",
			credentialVault: "hosted-kms-vault",
			credentialPortability: "company-vault",
			providerAccess: "hosted-connector-gateway",
			materializedData: "hosted-primary",
			rawProviderData: "source-only",
		});
	});

	it("keeps an explicitly machine-scoped hosted-company connection in the local OS vault", () => {
		expect(
			companyConnectionStoragePolicy({ hostedCompanyState: true, managedComputer: false }, "machine"),
		).toMatchObject({
			companyState: "hosted-primary",
			credentialVault: "local-os-vault",
			providerAccess: "local-connector-broker",
		});
	});

	it.each([
		{ label: "Local", hostedCompanyState: false },
		{ label: "Hosted", hostedCompanyState: true },
	])(
		"routes $label company connections through the hosted vault required by managed execution",
		({ hostedCompanyState }) => {
			expect(companyConnectionStoragePolicy({ hostedCompanyState, managedComputer: true }, "machine")).toMatchObject(
				{
					credentialVault: "hosted-kms-vault",
					providerAccess: "hosted-connector-gateway",
				},
			);
		},
	);
});
