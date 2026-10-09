import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sharedExecutionConfigFromEnvironment } from "../src/shared-execution-cli.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-shared-execution-cli-"));
	roots.push(root);
	return root;
}

// G2-5: the execution host holds no service key. The check comes first, so none of the other configuration matters.
it("refuses a service key in its environment, as a systemd credential, or left in its credential source", async () => {
	const empty = await directory();
	vi.stubEnv("QORPERA_SHARED_EXECUTION_CREDENTIAL_SOURCE", empty);

	vi.stubEnv("QORPERA_SUPABASE_SERVICE_KEY", "");
	await expect(sharedExecutionConfigFromEnvironment()).rejects.toThrow("must hold no service key");
	vi.unstubAllEnvs();
	vi.stubEnv("QORPERA_SHARED_EXECUTION_CREDENTIAL_SOURCE", empty);

	const credentials = await directory();
	await writeFile(join(credentials, "qorpera-supabase-service-key"), "service-key\n", { mode: 0o600 });
	vi.stubEnv("CREDENTIALS_DIRECTORY", credentials);
	await expect(sharedExecutionConfigFromEnvironment()).rejects.toThrow("must hold no service key");
	vi.unstubAllEnvs();

	const source = await directory();
	await writeFile(join(source, "qorpera-supabase-service-key"), "service-key\n", { mode: 0o600 });
	vi.stubEnv("QORPERA_SHARED_EXECUTION_CREDENTIAL_SOURCE", source);
	await expect(sharedExecutionConfigFromEnvironment()).rejects.toThrow("must hold no service key");
	vi.unstubAllEnvs();

	// Without a key it goes on to its other checks (here: no company runtime configured).
	vi.stubEnv("QORPERA_SHARED_EXECUTION_CREDENTIAL_SOURCE", empty);
	vi.stubEnv("QORPERA_SUPABASE_SERVICE_KEY", undefined);
	vi.stubEnv("CREDENTIALS_DIRECTORY", undefined);
	await expect(sharedExecutionConfigFromEnvironment()).rejects.toThrow(
		"Shared execution requires the governed company-path-v1 runtime",
	);
});
