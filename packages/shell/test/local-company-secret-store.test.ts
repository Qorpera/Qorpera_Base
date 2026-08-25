import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import {
	bindCompanySecret,
	bindNetworkDestination,
	companyConnectionsPath,
	readCompanyConnections,
	resolveCompanySecret,
	setCompanySecretStore,
} from "@qorpera/pi-coding-agent/company-connections";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalCompanySecretStore } from "../src/local-company-secret-store.ts";

describe("local company credential portability", () => {
	let root: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "qorpera-local-secret-store-"));
		previousAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
		process.env.QORPERA_CODING_AGENT_DIR = join(root, "agent-home");
		setCompanySecretStore(
			createLocalCompanySecretStore(join(root, "vaults"), {
				id: "test-machine-protector-v1",
				protect: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf-8"),
				unprotect: (ciphertext) => ciphertext.toString("utf-8").slice("protected:".length),
			}),
		);
	});

	afterEach(() => {
		setCompanySecretStore(undefined);
		if (previousAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
		else process.env.QORPERA_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps connector code portable and reuses protected bindings when the same company moves locally", async () => {
		const original = join(root, "original-company");
		scaffoldCompany(original);
		mkdirSync(join(original, "connectors", "ledger"), { recursive: true });
		bindNetworkDestination(original, "api.example.com", "Ledger API");
		bindCompanySecret(original, "ledger_api", { kind: "static", value: "top-secret-value" });

		const moved = join(root, "moved-company");
		cpSync(original, moved, { recursive: true });

		expect(readCompanyConnections(moved)).toMatchObject({
			destinations: [{ host: "api.example.com" }],
			secretNames: ["ledger_api"],
		});
		expect(await resolveCompanySecret(moved, "ledger_api")).toBe("top-secret-value");
		expect(companyConnectionsPath(moved)).toBe(companyConnectionsPath(original));
		const portableFiles = JSON.stringify(
			readFileSync(join(moved, ".qorpera", "company.json"), "utf-8") +
				readFileSync(join(moved, ".qorpera", "staff.json"), "utf-8"),
		);
		expect(portableFiles).not.toContain("top-secret-value");
		const vaultFiles = join(root, "vaults");
		expect(existsSync(vaultFiles)).toBe(true);
		expect(readFileSync(join(vaultFiles, readdirSync(vaultFiles)[0]!), "utf-8")).not.toContain("top-secret-value");
	});

	it("does not give a newly conceived company another company's credentials", () => {
		const first = join(root, "first-company");
		const second = join(root, "second-company");
		scaffoldCompany(first);
		scaffoldCompany(second);
		bindCompanySecret(first, "ledger_api", { kind: "static", value: "first-company-secret" });

		expect(readCompanyConnections(first).secretNames).toEqual(["ledger_api"]);
		expect(readCompanyConnections(second).secretNames).toEqual([]);
		expect(companyConnectionsPath(second)).not.toBe(companyConnectionsPath(first));
	});

	it("explicitly rewraps credentials for another local installation without transferring standing authority", async () => {
		const original = join(root, "portable-company");
		scaffoldCompany(original);
		process.env.QORPERA_CODING_AGENT_DIR = join(root, "source-installation");
		const sourceStore = createLocalCompanySecretStore(join(root, "source-vaults"), {
			id: "source-os-protector-v1",
			protect: (plaintext) => Buffer.from(`source-protected:${plaintext}`, "utf-8"),
			unprotect: (ciphertext) => ciphertext.toString("utf-8").slice("source-protected:".length),
		});
		setCompanySecretStore(sourceStore);
		bindNetworkDestination(original, "sheets.googleapis.com", "Google Sheets");
		bindCompanySecret(original, "google_sheets", {
			kind: "oauth2",
			accessToken: "source-access-token",
			refreshToken: "source-refresh-token",
			tokenUrl: "https://oauth2.googleapis.com/token",
			clientId: "desktop-client",
		});
		const bundle = sourceStore.exportCredentials(original, "portable company passphrase");
		expect(bundle).not.toContain("google_sheets");
		expect(bundle).not.toContain("source-refresh-token");

		const moved = join(root, "destination-installation", "portable-company");
		mkdirSync(join(root, "destination-installation"), { recursive: true });
		cpSync(original, moved, { recursive: true });
		process.env.QORPERA_CODING_AGENT_DIR = join(root, "destination-agent-home");
		const destinationStore = createLocalCompanySecretStore(join(root, "destination-vaults"), {
			id: "destination-os-protector-v1",
			protect: (plaintext) => Buffer.from(`destination-protected:${plaintext}`, "utf-8"),
			unprotect: (ciphertext) => ciphertext.toString("utf-8").slice("destination-protected:".length),
		});
		setCompanySecretStore(destinationStore);
		expect(readCompanyConnections(moved)).toEqual({ destinations: [], secretNames: [] });
		expect(destinationStore.importCredentials(moved, bundle, "portable company passphrase")).toEqual({
			imported: ["google_sheets"],
			overwritten: [],
		});
		expect(readCompanyConnections(moved)).toEqual({ destinations: [], secretNames: ["google_sheets"] });
		expect(await resolveCompanySecret(moved, "google_sheets")).toBe("source-access-token");
		const destinationVaultPath = join(root, "destination-vaults", readdirSync(join(root, "destination-vaults"))[0]!);
		const destinationVault = readFileSync(destinationVaultPath, "utf-8");
		expect(destinationVault).toContain("destination-os-protector-v1");
		expect(destinationVault).not.toContain("source-access-token");

		const unrelated = join(root, "unrelated-company");
		scaffoldCompany(unrelated);
		expect(() => destinationStore.importCredentials(unrelated, bundle, "portable company passphrase")).toThrow(
			"different company",
		);
	});
});
