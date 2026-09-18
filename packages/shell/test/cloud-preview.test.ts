import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CloudPreviewEndpoints, prepareCloudPreview } from "../src/cloud-preview.ts";

const roots: string[] = [];
const production = {
	projectUrl: "https://wovsmjvghnbcbfazdtvr.supabase.co",
	objectGatewayUrl: "https://objects.qorpera.com",
};
const endpoints: CloudPreviewEndpoints = {
	schema: "qorpera.desktop-preview/v1",
	projectUrl: "https://abcdefghijklmnopqrst.supabase.co",
	publishableKey: "sb_publishable_preview_key_for_test_only",
	objectGatewayUrl: "https://objects.preview.example",
	nativeProviderUrl: "https://native.preview.example",
};

function fixture(overrides: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "qorpera-cloud-preview-"));
	roots.push(root);
	chmodSync(root, 0o700);
	const path = join(root, "preview.json");
	writeFileSync(path, JSON.stringify({ ...endpoints, ...overrides }), { mode: 0o600 });
	const protectedPaths = { home: join(tmpdir(), "regular-home"), userData: join(tmpdir(), "regular-app-data") };
	const argv = ["app", `--cloud-preview=${path}`];
	return { root, path, protectedPaths, argv };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit isolated cloud preview", () => {
	it("leaves normal launches alone, including their environment", () => {
		const environment = { OPENAI_API_KEY: "not-read-or-used" };
		expect(
			prepareCloudPreview(["app"], { home: "/unused", userData: "/unused" }, production, environment),
		).toBeUndefined();
		expect(environment).toEqual({ OPENAI_API_KEY: "not-read-or-used" });
	});

	it("creates separate private paths and permits only the same target on restart", () => {
		const test = fixture();
		const preview = prepareCloudPreview(test.argv, test.protectedPaths, production, {})!;
		expect(preview).toMatchObject(endpoints);
		for (const path of [
			preview.home,
			preview.userData,
			preview.sessionData,
			preview.logs,
			preview.crashDumps,
			preview.agentDir,
			preview.githubConfigDir,
		]) {
			expect(path.startsWith(`${preview.root}/`)).toBe(true);
			expect(lstatSync(path).isDirectory()).toBe(true);
			if (process.platform !== "win32") expect(lstatSync(path).mode & 0o077).toBe(0);
		}
		writeFileSync(join(preview.userData, "test-session.json"), "preview session", { mode: 0o600 });
		expect(prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toEqual(preview);
		expect(readFileSync(join(preview.userData, "test-session.json"), "utf8")).toBe("preview session");
		writeFileSync(
			test.path,
			JSON.stringify({ ...endpoints, nativeProviderUrl: "https://different.preview.example" }),
		);
		expect(() => prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toThrow("target changed");
	});

	it.each([
		{ projectUrl: production.projectUrl },
		{ projectUrl: "https://not-a-project.example" },
		{ publishableKey: "sb_secret_private-key-must-not-be-accepted" },
		{ objectGatewayUrl: production.objectGatewayUrl },
		{ nativeProviderUrl: production.projectUrl },
		{ objectGatewayUrl: "http://objects.preview.example" },
		{ objectGatewayUrl: "https://user:password@objects.preview.example" },
		{ nativeProviderUrl: "https://native.preview.example?token=bad" },
		{ objectGatewayUrl: "https://objects.preview.example/path" },
		{ schema: "qorpera.desktop-preview/v2" },
		{ serviceRoleKey: "untrusted-extra-field" },
	])("rejects invalid, secret-bearing or production configuration %#", (overrides) => {
		const test = fixture(overrides);
		expect(() => prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toThrow();
		expect(readdirSync(test.root)).toEqual(["preview.json"]);
	});

	it.each(["--cloud-preview", "--cloud-preview=relative/preview.json", "--cloud-preview=", "--cloud-preview-other=x"])(
		"rejects ambiguous argument %s",
		(argument) => {
			const test = fixture();
			expect(() => prepareCloudPreview(["app", argument], test.protectedPaths, production, {})).toThrow();
		},
	);

	it("rejects duplicate flags and smoke/local-company bypasses", () => {
		const test = fixture();
		for (const argument of [test.argv[1]!, "--smoke", "--smoke-company", "--company"]) {
			expect(() => prepareCloudPreview([...test.argv, argument], test.protectedPaths, production, {})).toThrow();
		}
	});

	it.each([
		"OPENAI_API_KEY",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"ANTHROPIC_API_KEY",
		"QORPERA_NATIVE_PROVIDER_URL",
		"QORPERA_RUNTIME_NODE",
	])("rejects inherited credential/runtime state %s without exposing it", (name) => {
		const test = fixture();
		try {
			prepareCloudPreview(test.argv, test.protectedPaths, production, { [name]: "private-canary-not-to-log" });
			throw new Error("expected rejection");
		} catch (error) {
			expect((error as Error).message).toContain("ambient");
			expect((error as Error).message).not.toContain("private-canary");
		}
	});

	it("rejects regular home/app-data overlap and pre-existing state", () => {
		const test = fixture();
		for (const protectedPaths of [
			{ ...test.protectedPaths, home: test.root },
			{ ...test.protectedPaths, userData: join(test.root, "nested") },
			{ ...test.protectedPaths, home: tmpdir() },
		]) {
			expect(() => prepareCloudPreview(test.argv, protectedPaths, production, {})).toThrow("separate");
		}
		writeFileSync(join(test.root, "account-auth.json"), "existing state");
		expect(() => prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toThrow("pre-existing");
	});

	it("rejects configuration and state symlinks without touching their targets", () => {
		const target = fixture();
		const test = fixture();
		rmSync(test.path);
		symlinkSync(target.path, test.path);
		expect(() => prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toThrow("regular file");
		rmSync(test.path);
		writeFileSync(test.path, JSON.stringify(endpoints));
		const preview = prepareCloudPreview(test.argv, test.protectedPaths, production, {})!;
		rmSync(preview.userData, { recursive: true });
		symlinkSync(target.root, preview.userData, "dir");
		expect(() => prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toThrow("without symlinks");
		expect(readdirSync(target.root)).toEqual(["preview.json"]);
	});

	it("rejects oversized configuration and non-private storage", () => {
		const test = fixture();
		writeFileSync(test.path, " ".repeat(8193));
		expect(() => prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toThrow("bounded");
		if (process.platform !== "win32") {
			writeFileSync(test.path, JSON.stringify(endpoints));
			chmodSync(test.root, 0o755);
			expect(() => prepareCloudPreview(test.argv, test.protectedPaths, production, {})).toThrow("private");
		}
	});

	it("does not import a regular account store into preview paths", () => {
		const test = fixture();
		const external = fixture();
		const externalHome = join(external.root, "regular-home");
		mkdirSync(externalHome);
		const account = join(externalHome, "auth.json");
		writeFileSync(account, "private-regular-account-canary");
		const preview = prepareCloudPreview(test.argv, { ...test.protectedPaths, home: externalHome }, production, {})!;
		expect(readdirSync(preview.agentDir)).toEqual([]);
		expect(readdirSync(preview.userData)).toEqual([]);
		expect(readFileSync(account, "utf8")).toBe("private-regular-account-canary");
	});
});
