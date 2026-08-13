import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shareWindowsSandboxState } from "../src/agent-runtime.ts";

const onWindows = process.platform === "win32";

let root: string;
let userData: string;
let sharedSecrets: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-sandbox-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	userData = join(root, "AppData", "Roaming", "Electron");
	sharedSecrets = join(root, "AppData", "Roaming", "Qorpera", "agent-sandbox-shared", ".sandbox-secrets");
	mkdirSync(userData, { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function configDirFor(company: string): string {
	return join(userData, "agent-sandbox", company, "controller");
}

describe.runIf(onWindows)("shareWindowsSandboxState", () => {
	it("junctions per-config sandbox state into one per-user store", () => {
		const configDir = configDirFor("company-a");
		shareWindowsSandboxState(userData, configDir);
		for (const name of [".sandbox", ".sandbox-secrets"]) {
			expect(lstatSync(join(configDir, name)).isSymbolicLink()).toBe(true);
		}
		writeFileSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"), "secret", "utf-8");
		expect(readFileSync(join(sharedSecrets, "sandbox_users.json"), "utf-8")).toBe("secret");
	});

	it("shows one company's stored approval to every other company", () => {
		const first = configDirFor("company-a");
		const second = configDirFor("company-b");
		shareWindowsSandboxState(userData, first);
		writeFileSync(join(first, ".sandbox-secrets", "sandbox_users.json"), "shared-secret", "utf-8");
		shareWindowsSandboxState(userData, second);
		expect(readFileSync(join(second, ".sandbox-secrets", "sandbox_users.json"), "utf-8")).toBe("shared-secret");
	});

	it("migrates existing per-config state, newest file winning", () => {
		const configDir = configDirFor("company-a");
		mkdirSync(join(configDir, ".sandbox-secrets"), { recursive: true });
		writeFileSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"), "newer", "utf-8");
		mkdirSync(sharedSecrets, { recursive: true });
		writeFileSync(join(sharedSecrets, "sandbox_users.json"), "older", "utf-8");
		const past = new Date(Date.now() - 60_000);
		utimesSync(join(sharedSecrets, "sandbox_users.json"), past, past);
		shareWindowsSandboxState(userData, configDir);
		expect(lstatSync(join(configDir, ".sandbox-secrets")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(sharedSecrets, "sandbox_users.json"), "utf-8")).toBe("newer");
	});

	it("keeps a newer shared file over stale per-config state", () => {
		const configDir = configDirFor("company-a");
		mkdirSync(join(configDir, ".sandbox-secrets"), { recursive: true });
		writeFileSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"), "stale", "utf-8");
		const past = new Date(Date.now() - 60_000);
		utimesSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"), past, past);
		mkdirSync(sharedSecrets, { recursive: true });
		writeFileSync(join(sharedSecrets, "sandbox_users.json"), "current", "utf-8");
		shareWindowsSandboxState(userData, configDir);
		expect(readFileSync(join(sharedSecrets, "sandbox_users.json"), "utf-8")).toBe("current");
	});

	it("is idempotent across repeated child starts", () => {
		const configDir = configDirFor("company-a");
		shareWindowsSandboxState(userData, configDir);
		writeFileSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"), "kept", "utf-8");
		shareWindowsSandboxState(userData, configDir);
		expect(lstatSync(join(configDir, ".sandbox-secrets")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(sharedSecrets, "sandbox_users.json"), "utf-8")).toBe("kept");
	});
});
