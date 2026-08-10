/**
 * Company folder scaffold (Qorpera Base slice 3, spec §2).
 *
 * The spine, idempotency, gate activation on the scaffolded folder, and the
 * sessions-are-the-trail wiring (project sessionDir → ./trail).
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import {
	captureProductTransactionStorage,
	claimCompanyRuntimeLock,
	companyRuntimeLockPath,
	createProductWorktree,
	enforceCompanyKernelSettings,
	KERNEL_PROMPT,
	listProductDepartments,
	readProductProtectionInventory,
	readProductWorktreeAssignment,
	releaseCompanyRuntimeLock,
	scaffoldCompany,
	scaffoldProductDepartment,
	scaffoldProductDepartmentWithRuntimeLock,
} from "../src/core/company.ts";
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
			join("app", "projection.json"),
			join("app", "surfaces"),
			join("app", "substrates"),
			join("app", "routines"),
			join("app", "tools"),
			"departments",
		]) {
			expect(existsSync(join(root, entry)), entry).toBe(true);
		}

		// Kernel single-sourced: both files carry the same text.
		expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(KERNEL_PROMPT);
		expect(readFileSync(join(root, "CLAUDE.md"), "utf-8")).toBe(KERNEL_PROMPT);
		expect(KERNEL_PROMPT).toContain("controller of the company rooted in this folder");

		const projection = JSON.parse(readFileSync(join(root, "app", "projection.json"), "utf-8"));
		expect(projection).toEqual({
			schema: "qorpera.projection/v1",
			default: "q:chats",
			navigation: [],
			nodes: [],
		});
		const settings = JSON.parse(readFileSync(join(root, ".qorpera", "settings.json"), "utf-8"));
		expect(settings.compaction).toEqual({ enabled: false });
		expect(settings.transport).toBe("sse");

		expect(result.created.length).toBeGreaterThan(10);
		expect(result.skipped.length).toBe(0);
		expect(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" }).status).toBe(0);
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

	it("commits the company spine when scaffolding into an existing Git history", () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "existing.md"), "seed\n");
		for (const args of [
			["init"],
			["add", "existing.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: root, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(root);
		expect(spawnSync("git", ["ls-files", "company.md"], { cwd: root, encoding: "utf-8" }).stdout.trim()).toBe(
			"company.md",
		);
		expect(spawnSync("git", ["log", "-1", "--format=%B"], { cwd: root, encoding: "utf-8" }).stdout).toContain(
			"Qorpera-Trigger: company scaffold migration",
		);
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
		expect(settings.compaction).toEqual({ enabled: false });
		expect(settings.transport).toBe("sse");

		// The kernel always restores the company trail as the session store.
		writeFileSync(
			join(root, ".qorpera", "settings.json"),
			JSON.stringify({ sessionDir: "/custom/elsewhere" }),
			"utf-8",
		);
		scaffoldCompany(root);
		const after = JSON.parse(readFileSync(join(root, ".qorpera", "settings.json"), "utf-8"));
		expect(after.sessionDir).toBe("./trail");
	});

	it("forces compaction off for existing companies", () => {
		mkdirSync(join(root, ".qorpera"), { recursive: true });
		writeFileSync(
			join(root, ".qorpera", "settings.json"),
			JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1234 } }),
			"utf-8",
		);
		scaffoldCompany(root);
		const settings = JSON.parse(readFileSync(join(root, ".qorpera", "settings.json"), "utf-8"));
		expect(settings.compaction).toEqual({ enabled: false, keepRecentTokens: 1234 });
	});

	it("fails closed on malformed company settings", () => {
		scaffoldCompany(root);
		writeFileSync(join(root, ".qorpera", "settings.json"), "null\n", "utf-8");
		expect(() => enforceCompanyKernelSettings(root)).toThrow("cannot be opened safely");
	});
});

describe("forking hub verbs (no-launch paths)", () => {
	it("qorpera new --from creates a product department with a controlling clone", async () => {
		const { handleCompanyCommand } = await import("../src/core/company.ts");
		// A tiny local git repo to integrate.
		const product = join(root, "legacy-product");
		mkdirSync(product, { recursive: true });
		writeFileSync(join(product, "index.js"), "console.log('hi');\n", "utf-8");
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
		expect(existsSync(join(company, "departments", "legacy-product-development", "repository", "index.js"))).toBe(
			true,
		);
		expect(existsSync(join(company, "departments", "legacy-product-development", "worktrees"))).toBe(true);
		expect(existsSync(join(company, "departments", "legacy-product-development", "pull-requests", "README.md"))).toBe(
			true,
		);
		const department = listProductDepartments(company)[0];
		const runtimeLock = claimCompanyRuntimeLock(company);
		let worktree: ReturnType<typeof createProductWorktree>;
		try {
			worktree = createProductWorktree(company, department, runtimeLock);
		} finally {
			releaseCompanyRuntimeLock(runtimeLock);
		}
		expect(worktree?.branch).toMatch(/^qorpera\/legacy-product-development\//);
		expect(existsSync(join(company, worktree!.path, ".git"))).toBe(true);
		expect(statSync(join(company, worktree!.path, ".git")).isDirectory()).toBe(true);
		expect(
			spawnSync("git", ["branch", "--list", worktree!.branch], {
				cwd: join(company, department.repositoryPath),
				encoding: "utf-8",
			}).stdout.trim(),
		).toBe("");
		expect(readProductWorktreeAssignment(company, department, worktree!.path)).toEqual(worktree);
		expect(readProductWorktreeAssignment(company, department, join(worktree!.path, "nested"))).toBeUndefined();
		expect(
			spawnSync("git", ["remote", "set-url", "origin", "https://example.invalid/other.git"], {
				cwd: join(company, worktree!.path),
				stdio: "ignore",
			}).status,
		).toBe(0);
		expect(readProductWorktreeAssignment(company, department, worktree!.path)).toBeUndefined();
	});

	it("qorpera fork clones a whole company folder", async () => {
		const { handleCompanyCommand } = await import("../src/core/company.ts");
		const original = join(root, "original-co");
		scaffoldCompany(original);
		expect(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: original, stdio: "ignore" }).status).toBe(0);

		const forked = join(root, "forked-co");
		const handled = await handleCompanyCommand(["fork", original, forked, "--no-launch"]);
		expect(handled).toBe(true);
		expect(existsSync(join(forked, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(forked, "authority.toml"))).toBe(true);
		expect(existsSync(join(forked, ".git"))).toBe(true);
	});
});

describe("product-development departments", () => {
	it("serializes offline and desktop product registration under one atomic runtime lock", () => {
		const previous = process.env.QORPERA_CODING_AGENT_DIR;
		process.env.QORPERA_CODING_AGENT_DIR = join(root, "agent-home");
		try {
			scaffoldCompany(root);
			const lock = claimCompanyRuntimeLock(root);
			expect(lock.path).toBe(companyRuntimeLockPath(root));
			expect(() => scaffoldProductDepartment(root, "Widget")).toThrow("already owned by another process");
			const department = scaffoldProductDepartmentWithRuntimeLock(
				root,
				"Widget",
				lock,
				captureProductTransactionStorage(root),
			);
			expect(department.id).toBe("widget-development");
			releaseCompanyRuntimeLock(lock);
		} finally {
			if (previous === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
			else process.env.QORPERA_CODING_AGENT_DIR = previous;
		}
	});

	it("uses the same runtime lock identity through filesystem aliases", () => {
		const company = join(root, "company");
		const alias = join(root, "company-alias");
		scaffoldCompany(company);
		symlinkSync(company, alias, process.platform === "win32" ? "junction" : "dir");
		expect(companyRuntimeLockPath(alias)).toBe(companyRuntimeLockPath(company));
		const lock = claimCompanyRuntimeLock(company);
		try {
			expect(() => claimCompanyRuntimeLock(alias)).toThrow("already owned by another process");
		} finally {
			releaseCompanyRuntimeLock(lock);
		}
	});

	it("rejects linked product transaction parents before writing the kit", () => {
		scaffoldCompany(root);
		const physicalDepartments = join(root, "departments-physical");
		renameSync(join(root, "departments"), physicalDepartments);
		symlinkSync(physicalDepartments, join(root, "departments"), process.platform === "win32" ? "junction" : "dir");

		expect(() => scaffoldProductDepartment(root, "Widget")).toThrow("not a link or junction");
		expect(existsSync(join(physicalDepartments, "widget-development"))).toBe(false);
	});

	it("rejects aliased kernel transaction files before writing the kit", () => {
		scaffoldCompany(root);
		const projection = join(root, "app", "projection.json");
		rmSync(projection);
		linkSync(join(root, "authority.toml"), projection);

		expect(() => scaffoldProductDepartment(root, "Widget")).toThrow("must be one physical entry");
		expect(existsSync(join(root, "departments", "widget-development"))).toBe(false);
	});

	it("tracks keep files created in pre-existing empty spine directories", () => {
		mkdirSync(join(root, "app", "tools"), { recursive: true });
		scaffoldCompany(root);
		expect(spawnSync("git", ["ls-files", "app/tools/.gitkeep"], { cwd: root, encoding: "utf-8" }).stdout.trim()).toBe(
			"app/tools/.gitkeep",
		);
	});

	it("materializes and discovers the standard department kit", () => {
		scaffoldCompany(root);
		const department = scaffoldProductDepartment(root, "My Product");
		scaffoldProductDepartment(root, "My Product");
		expect(department.id).toBe("my-product-development");
		expect(department.repositoryExists).toBe(false);
		expect(existsSync(join(root, department.path, "department.json"))).toBe(true);
		expect(existsSync(join(root, department.worktreesPath))).toBe(true);
		expect(listProductDepartments(root)).toEqual([department]);
		const projection = JSON.parse(readFileSync(join(root, "app", "projection.json"), "utf-8"));
		expect(projection.navigation).toEqual(["department:my-product-development"]);
		expect(projection.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "department:my-product-development",
					kind: "department",
					items: [
						"page:my-product-development.chat",
						"page:my-product-development.pull-requests",
						"page:my-product-development.architecture",
					],
				}),
				expect.objectContaining({
					id: "page:my-product-development.architecture",
					view: expect.objectContaining({ id: "qorpera.placeholder" }),
				}),
			]),
		);
		expect(projection.navigation.filter((id: string) => id === "department:my-product-development")).toHaveLength(1);
		expect(
			projection.nodes.filter((node: { id: string }) => node.id.startsWith("page:my-product-development.")),
		).toHaveLength(3);
	});

	it("creates valid projection IDs for punctuation-prefixed product names", () => {
		scaffoldCompany(root);
		const department = scaffoldProductDepartment(root, "...Product...");
		expect(department.id).toBe("product-development");
		const projection = JSON.parse(readFileSync(join(root, "app", "projection.json"), "utf-8"));
		expect(projection.navigation).toEqual(["department:product-development"]);
	});

	it("uses one canonical department and projection namespace for case variants", () => {
		scaffoldCompany(root);
		const first = scaffoldProductDepartment(root, "Widget");
		const second = scaffoldProductDepartment(root, "widget");
		expect(second.id).toBe(first.id);
		expect(readdirSync(join(root, "departments")).filter((id) => id.endsWith("-development"))).toEqual([
			"widget-development",
		]);
		const projection = JSON.parse(readFileSync(join(root, "app", "projection.json"), "utf-8"));
		expect(projection.navigation).toEqual(["department:widget-development"]);
	});

	it("ignores arbitrary department folders without a product-development manifest", () => {
		scaffoldCompany(root);
		mkdirSync(join(root, "departments", "sales"), { recursive: true });
		expect(listProductDepartments(root)).toEqual([]);
	});

	it("does not issue worker authority for an unregistered product-shaped folder", () => {
		scaffoldCompany(root);
		mkdirSync(join(root, "departments", "forged-development", "repository", ".git"), { recursive: true });
		writeFileSync(
			join(root, "departments", "forged-development", "department.json"),
			JSON.stringify({ version: 1, kind: "product-development", product: "Forged" }),
			"utf-8",
		);
		expect(listProductDepartments(root)).toEqual([]);
	});

	it("protects registered product paths without trusting the department manifest", () => {
		scaffoldCompany(root);
		const department = scaffoldProductDepartment(root, "Widget");
		writeFileSync(join(root, department.path, "department.json"), "{}\n", "utf-8");
		expect(readProductProtectionInventory(root)).toEqual([
			{
				id: "widget-development",
				repositoryPath: join("departments", "widget-development", "repository"),
				worktreesPath: join("departments", "widget-development", "worktrees"),
			},
		]);
		writeFileSync(join(root, ".qorpera", "products.json"), "{}\n", "utf-8");
		expect(() => readProductProtectionInventory(root)).toThrow("inventory is invalid");
	});

	it("rejects linked registered product storage before issuing a sandbox profile", () => {
		scaffoldCompany(root);
		const department = scaffoldProductDepartment(root, "Widget");
		const outside = join(root, "linked-worktrees");
		mkdirSync(outside, { recursive: true });
		rmSync(join(root, department.worktreesPath), { recursive: true });
		symlinkSync(outside, join(root, department.worktreesPath), process.platform === "win32" ? "junction" : "dir");
		expect(() => readProductProtectionInventory(root)).toThrow("must not be a link or junction");
	});

	it("uses Git-ref-safe product slugs and removes clones when branch creation fails", () => {
		scaffoldCompany(root);
		const department = scaffoldProductDepartment(root, "Foo..Bar");
		expect(department.id).toBe("foo-bar-development");
		spawnSync("git", ["init"], { cwd: join(root, department.repositoryPath), stdio: "ignore" });
		writeFileSync(join(root, department.repositoryPath, "README.md"), "seed\n", "utf-8");
		spawnSync("git", ["add", "README.md"], { cwd: join(root, department.repositoryPath), stdio: "ignore" });
		spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"], {
			cwd: join(root, department.repositoryPath),
			stdio: "ignore",
		});
		const runtimeLock = claimCompanyRuntimeLock(root);
		let failed: ReturnType<typeof createProductWorktree>;
		try {
			failed = createProductWorktree(root, { ...department, id: "bad..ref", repositoryExists: true }, runtimeLock);
		} finally {
			releaseCompanyRuntimeLock(runtimeLock);
		}
		expect(failed).toBeUndefined();
		expect(readdirSync(join(root, department.worktreesPath))).toEqual([".gitkeep"]);
	});

	it("does not partially convert an existing agent-authored department", () => {
		scaffoldCompany(root);
		const departmentPath = join(root, "departments", "widget-development");
		mkdirSync(departmentPath, { recursive: true });
		writeFileSync(join(departmentPath, "department.json"), JSON.stringify({ kind: "agent-authored" }), "utf-8");

		expect(() => scaffoldProductDepartment(root, "Widget")).toThrow("already exists");
		expect(readdirSync(departmentPath)).toEqual(["department.json"]);
	});

	it("rejects incompatible product projection node ownership", () => {
		scaffoldCompany(root);
		writeFileSync(
			join(root, "app", "projection.json"),
			`${JSON.stringify(
				{
					schema: "qorpera.projection/v1",
					navigation: [],
					nodes: [
						{
							id: "department:widget-development",
							kind: "department",
							label: "Unrelated",
							items: [],
						},
					],
				},
				null,
				"\t",
			)}\n`,
			"utf-8",
		);

		expect(() => scaffoldProductDepartment(root, "Widget")).toThrow("incompatible content");
		expect(existsSync(join(root, "departments", "widget-development"))).toBe(false);
	});
});

describe("company registry", () => {
	it("registers, dedupes, sorts by recency, and filters vanished companies", async () => {
		const prevAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
		process.env.QORPERA_CODING_AGENT_DIR = join(root, "agent-home");
		try {
			const { listCompanies, registerCompany } = await import("../src/core/company.ts");
			const companyA = join(root, "co-a");
			const companyB = join(root, "co-b");
			scaffoldCompany(companyA);
			scaffoldCompany(companyB);

			registerCompany(companyA);
			registerCompany(companyB);
			registerCompany(companyA); // re-open: dedupe + bump recency
			let companies = listCompanies();
			expect(companies.length).toBe(2);
			expect(companies[0].root).toBe(companyA);
			expect(companies[0].name).toBe("co-a");

			// A registered dir that stops being a company disappears from the list.
			rmSync(join(companyB, "authority.toml"));
			companies = listCompanies();
			expect(companies.length).toBe(1);
			expect(companies[0].root).toBe(companyA);
		} finally {
			if (prevAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
			else process.env.QORPERA_CODING_AGENT_DIR = prevAgentDir;
		}
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
		// The kernel creates the session header immediately; assistant output
		// then appends to the already-auditable trail.
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
