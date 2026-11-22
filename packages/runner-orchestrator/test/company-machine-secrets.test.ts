import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	APP_SECRETS_FILE_MODE,
	appSecretEnvNameAllowed,
	buildGuestDeliverAppSecretsPlan,
	buildGuestScrubAppSecretsCommand,
	CompanyMachineSecretsManager,
	createMaskedAppLogStream,
	isTmpfsMountedPath,
} from "../src/company-machine-secrets.ts";

describe("company-machine-secrets", () => {
	it("allows company OPENAI_* and ANTHROPIC_* env names while refusing host/harness internals", () => {
		expect(appSecretEnvNameAllowed("OPENAI_API_KEY")).toBe(true);
		expect(appSecretEnvNameAllowed("ANTHROPIC_API_KEY")).toBe(true);
		expect(appSecretEnvNameAllowed("DATABASE_URL")).toBe(true);
		expect(appSecretEnvNameAllowed("QORPERA_SECRET")).toBe(false);
		expect(appSecretEnvNameAllowed("LD_PRELOAD")).toBe(false);
		expect(appSecretEnvNameAllowed("GIT_DIR")).toBe(false);
		expect(appSecretEnvNameAllowed("CLAUDE_TOKEN")).toBe(false);
		expect(appSecretEnvNameAllowed("CODEX_HOME")).toBe(false);
	});

	it("detects tmpfs and ramfs mount points accurately and rejects disk mounts", async () => {
		const mounts = [
			"/dev/sda1 / ext4 rw,relatime 0 0",
			"tmpfs /run tmpfs rw,nosuid,nodev,noexec,mode=755 0 0",
			"tmpfs /run/qorpera-apps tmpfs rw,nosuid,nodev,noexec,mode=700 0 0",
		].join("\n");
		expect(await isTmpfsMountedPath("/run/qorpera-apps", async () => mounts)).toBe(true);
		expect(await isTmpfsMountedPath("/run/qorpera-apps/billing-app.env", async () => mounts)).toBe(true);
		expect(await isTmpfsMountedPath("/var/lib/qorpera", async () => mounts)).toBe(false);
		expect(
			await isTmpfsMountedPath("/run/qorpera-apps", async () => {
				throw new Error("no proc");
			}),
		).toBe(false);
	});

	it("delivers runtime secrets + DATABASE_URL with mode 0400, masks logs, and scrubs on stop/sleep", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-app-secrets-"));
		const siteId = randomUUID();
		const openaiKey = "sk-proj-secret-openai-99887766";
		const dbUrl = "postgres://app:supersecretdbpass@127.0.0.1:5432/billing";
		try {
			const refused = new CompanyMachineSecretsManager({ rootDir: root, verifyTmpfs: async () => false });
			await expect(
				refused.deliver({
					siteId,
					slug: "billing-app",
					scope: "runtime",
					targetEnv: "prod",
					secrets: { OPENAI_API_KEY: openaiKey },
				}),
			).rejects.toThrow("APP_SECRETS_NOT_TMPFS");

			const manager = new CompanyMachineSecretsManager({ rootDir: root, verifyTmpfs: async () => true });
			await expect(
				manager.deliver({
					siteId,
					slug: "billing-app",
					scope: "build",
					targetEnv: "prod",
					secrets: { OPENAI_API_KEY: openaiKey },
				}),
			).rejects.toThrow(/runtime scope/);

			const delivered = await manager.deliver({
				siteId,
				slug: "billing-app",
				scope: "runtime",
				targetEnv: "prod",
				secrets: { OPENAI_API_KEY: openaiKey },
				config: { NODE_ENV: "prod", PORT: "3000" },
				databaseUrl: dbUrl,
			});
			expect(delivered.envPath).toBe(join(root, "billing-app.env"));
			expect(delivered.secretNames).toEqual(["DATABASE_URL", "OPENAI_API_KEY"]);
			const info = await stat(delivered.envPath);
			expect(info.mode & 0o777).toBe(APP_SECRETS_FILE_MODE);
			const envContent = await readFile(delivered.envPath, "utf8");
			expect(envContent).toContain(`DATABASE_URL="${dbUrl}"`);
			expect(envContent).toContain(`OPENAI_API_KEY="${openaiKey}"`);
			expect(envContent).toContain('NODE_ENV="prod"');

			const logStream = createMaskedAppLogStream(delivered.mask);
			const chunks: Buffer[] = [];
			logStream.on("data", (chunk: Buffer) => chunks.push(chunk));
			const encoded = Buffer.from(openaiKey, "utf8").toString("base64");
			logStream.write(Buffer.from(`starting with ${openaiKey.slice(0, 10)}`));
			logStream.write(Buffer.from(`${openaiKey.slice(10)} db=${dbUrl} b64=${encoded}\n`));
			logStream.end();
			await new Promise<void>((resolve) => logStream.on("end", () => resolve()));
			const output = Buffer.concat(chunks).toString("utf8");
			expect(output).not.toContain(openaiKey);
			expect(output).not.toContain(dbUrl);
			expect(output).not.toContain(encoded);
			expect(output).toContain("***");

			await manager.scrubAll();
			await expect(stat(delivered.envPath)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("builds stdin-only guest deliver and scrub commands with zero secret values in argv", () => {
		const secret = "sk-ant-api03-super-secret-value";
		const plan = buildGuestDeliverAppSecretsPlan({
			siteId: randomUUID(),
			slug: "billing-app",
			scope: "runtime",
			targetEnv: "prod",
			secrets: { ANTHROPIC_API_KEY: secret },
		});
		expect(plan.envPath).toBe("/run/qorpera-apps/billing-app.env");
		expect(plan.command.join(" ")).not.toContain(secret);
		expect(plan.command.join(" ")).toContain("tmpfs");
		expect(plan.command.join(" ")).toContain("0400");
		expect(plan.stdin.toString("utf8")).toContain(`ANTHROPIC_API_KEY="${secret}"`);
		plan.stdin.fill(0);

		const scrubCmd = buildGuestScrubAppSecretsCommand("billing-app");
		expect(scrubCmd.join(" ")).toContain("/run/qorpera-apps/billing-app.env");
	});
});
