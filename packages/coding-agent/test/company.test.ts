/**
 * Company folder scaffold (Qorpera Base slice 3, spec §2).
 *
 * The spine, idempotency, gate activation on the scaffolded folder, and the
 * sessions-are-the-trail wiring (project sessionDir → ./trail).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import { KERNEL_PROMPT, scaffoldCompany } from "../src/core/company.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-company-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
	if (root && existsSync(root)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("scaffoldCompany", () => {
	it("creates the full spine with kernel files materialized from one source", () => {
		const result = scaffoldCompany(root);

		for (const entry of [
			"AGENTS.md",
			"CLAUDE.md",
			"company.md",
			"authority.toml",
			join("connections", "README.md"),
			join("inbox", "README.md"),
			"trail",
			join("app", "manifest.json"),
			join("app", "surfaces"),
			join("app", "substrates"),
			join("app", "routines"),
			join("app", "tools"),
			"work",
		]) {
			expect(existsSync(join(root, entry)), entry).toBe(true);
		}

		// Kernel single-sourced: both files carry the same text.
		expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(KERNEL_PROMPT);
		expect(readFileSync(join(root, "CLAUDE.md"), "utf-8")).toBe(KERNEL_PROMPT);
		expect(KERNEL_PROMPT).toContain("controller of the company rooted in this folder");

		const manifest = JSON.parse(readFileSync(join(root, "app", "manifest.json"), "utf-8"));
		expect(manifest).toEqual({ version: 1, surfaces: [], routines: [] });

		expect(result.created.length).toBeGreaterThan(10);
		expect(result.skipped.length).toBe(0);
	});

	it("is idempotent and never overwrites existing company files", () => {
		scaffoldCompany(root);
		writeFileSync(join(root, "company.md"), "# Acme\n\nWe make anvils.\n", "utf-8");
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "auto"\n`, "utf-8");

		const second = scaffoldCompany(root);
		expect(readFileSync(join(root, "company.md"), "utf-8")).toContain("anvils");
		expect(readFileSync(join(root, "authority.toml"), "utf-8")).toContain("auto");
		expect(second.created.length).toBe(0);
		expect(second.skipped.length).toBeGreaterThan(10);
	});

	it("initializes a git repository when none exists", () => {
		const result = scaffoldCompany(root);
		// git is present on dev/CI machines; if init reported success the dir must exist.
		if (result.gitInitialized) {
			expect(existsSync(join(root, ".git"))).toBe(true);
		}
		const again = scaffoldCompany(root);
		expect(again.gitInitialized).toBe(false);
	});

	it("activates authority gates: the scaffolded folder immediately protects its own spine", () => {
		scaffoldCompany(root);
		const authority = discoverAuthority(root);
		expect(authority?.root).toBe(root);

		// The default gates protect the kernel and the gate machinery itself.
		const decision = evaluateToolCall(authority!, "write", { path: join(root, "AGENTS.md"), content: "x" }, root);
		expect(decision.kind).toBe("block");
		const destructive = evaluateToolCall(authority!, "bash", { command: "rm -rf work" }, root);
		expect(destructive.kind).toBe("block");
	});

	it("merges sessionDir into existing project settings without clobbering", () => {
		mkdirSync(join(root, ".qorpera"), { recursive: true });
		writeFileSync(join(root, ".qorpera", "settings.json"), JSON.stringify({ theme: "dark" }), "utf-8");
		scaffoldCompany(root);
		const settings = JSON.parse(readFileSync(join(root, ".qorpera", "settings.json"), "utf-8"));
		expect(settings.theme).toBe("dark");
		expect(settings.sessionDir).toBe("./trail");

		// A pre-existing sessionDir is respected.
		writeFileSync(
			join(root, ".qorpera", "settings.json"),
			JSON.stringify({ sessionDir: "/custom/elsewhere" }),
			"utf-8",
		);
		scaffoldCompany(root);
		const after = JSON.parse(readFileSync(join(root, ".qorpera", "settings.json"), "utf-8"));
		expect(after.sessionDir).toBe("/custom/elsewhere");
	});
});

describe("forking hub verbs (no-launch paths)", () => {
	it("qorpera new --from clones an existing repo into work/", async () => {
		const { handleCompanyCommand } = await import("../src/core/company.ts");
		// A tiny local git repo to integrate.
		const product = join(root, "legacy-product");
		mkdirSync(product, { recursive: true });
		writeFileSync(join(product, "index.js"), "console.log('hi');\n", "utf-8");
		const { spawnSync } = await import("node:child_process");
		for (const cmd of [
			["init"],
			["add", "."],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", cmd, { cwd: product, stdio: "ignore" }).status).toBe(0);
		}

		const company = join(root, "integrated-co");
		const handled = await handleCompanyCommand(["new", company, "--from", product, "--no-launch"]);
		expect(handled).toBe(true);
		expect(existsSync(join(company, "authority.toml"))).toBe(true);
		expect(existsSync(join(company, "work", "legacy-product", "index.js"))).toBe(true);
	});

	it("qorpera fork clones a whole company folder", async () => {
		const { handleCompanyCommand } = await import("../src/core/company.ts");
		const original = join(root, "original-co");
		scaffoldCompany(original);
		const { spawnSync } = await import("node:child_process");
		expect(spawnSync("git", ["add", "."], { cwd: original, stdio: "ignore" }).status).toBe(0);
		expect(
			spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "genesis"], {
				cwd: original,
				stdio: "ignore",
			}).status,
		).toBe(0);

		const forked = join(root, "forked-co");
		const handled = await handleCompanyCommand(["fork", original, forked, "--no-launch"]);
		expect(handled).toBe(true);
		expect(existsSync(join(forked, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(forked, "authority.toml"))).toBe(true);
		expect(existsSync(join(forked, ".git"))).toBe(true);
	});
});

describe("sessions are the trail", () => {
	it("project settings route session storage into <root>/trail", async () => {
		scaffoldCompany(root);
		const agentDir = join(root, ".agent-home");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.create(root, agentDir);
		const sessionDir = settingsManager.getSessionDir();
		expect(sessionDir).toBe("./trail");

		// Resolve the way the CLI does at launch (cwd = company root) and
		// write a session: its tree file must land inside trail/. With an
		// explicit sessionDir the file is written flat (no --cwd-- encoding).
		const resolved = join(root, "trail");
		const sessionManager = SessionManager.create(root, resolved, { id: "trail-smoke" });
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello trail" }],
			timestamp: Date.now(),
		} as never);
		// The session file flushes on the first assistant message (upstream
		// behavior: abandoned prompts don't litter the store).
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "recorded" }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);

		const files = readdirSync(resolved).filter((name) => name.endsWith(".jsonl"));
		expect(files.length).toBe(1);
		const lines = readFileSync(join(resolved, files[0]), "utf-8")
			.split("\n")
			.filter((line) => line.trim());
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(lines.some((line) => line.includes("hello trail"))).toBe(true);
	});
});
