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
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import {
	captureProductTransactionStorage,
	claimCompanyRuntimeLock,
	companyRuntimeLockPath,
	createProductWorktree,
	ENVIRONMENT_CONTRACT_VERSION,
	EXPORT_MANIFEST_FILE,
	enforceCompanyKernelSettings,
	exportCompany,
	importCompany,
	integrateRepo,
	KERNEL_PROMPT,
	listProductDepartments,
	materializeClonedProductStorage,
	planProductWorktree,
	planProductWorktreeRecovery,
	readProductProtectionInventory,
	readProductWorktreeAssignment,
	recoverProductWorktree,
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

	it("rejects linked kernel settings without modifying the external file", () => {
		scaffoldCompany(root);
		const outside = join(root, "outside-settings.json");
		const settings = join(root, ".qorpera", "settings.json");
		writeFileSync(outside, `${JSON.stringify({ founder: true })}\n`, "utf-8");
		rmSync(settings);
		linkSync(outside, settings);
		expect(() => enforceCompanyKernelSettings(root)).toThrow("one physical in-company file");
		expect(readFileSync(outside, "utf-8")).toBe(`${JSON.stringify({ founder: true })}\n`);
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
			const plan = planProductWorktree(company, department, runtimeLock)!;
			expect(existsSync(join(company, plan.path))).toBe(false);
			worktree = createProductWorktree(company, department, runtimeLock, plan);
		} finally {
			releaseCompanyRuntimeLock(runtimeLock);
		}
		expect(worktree?.branch).toMatch(/^qorpera\/\d{14}-[a-f0-9]{8}$/);
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

	it("heartbeats the atomic company lock while the main thread is synchronously blocked", () => {
		scaffoldCompany(root);
		const lock = claimCompanyRuntimeLock(root);
		try {
			const before = statSync(lock.path).mtimeMs;
			const blocked = spawnSync(process.execPath, [
				"-e",
				"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500)",
			]);
			expect(blocked.status).toBe(0);
			expect(statSync(lock.path).mtimeMs).toBeGreaterThan(before);
			expect(() => claimCompanyRuntimeLock(root)).toThrow("already owned by another process");
		} finally {
			releaseCompanyRuntimeLock(lock);
		}
	});

	it.runIf(process.platform === "win32")("establishes lock identity without PowerShell module state", () => {
		scaffoldCompany(root);
		const previous = process.env.PSModulePath;
		delete process.env.PSModulePath;
		try {
			const lock = claimCompanyRuntimeLock(root);
			releaseCompanyRuntimeLock(lock);
		} finally {
			if (previous !== undefined) process.env.PSModulePath = previous;
		}
	});

	it("distinguishes a live lock owner from a reused process ID", () => {
		scaffoldCompany(root);
		const lockPath = companyRuntimeLockPath(root);
		const original = claimCompanyRuntimeLock(root);
		const liveRecord = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
		releaseCompanyRuntimeLock(original);
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, `${JSON.stringify(liveRecord)}\n`, "utf-8");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath, old, old);

		expect(() => claimCompanyRuntimeLock(root)).toThrow("already owned by another live process");

		liveRecord.processInstance = process.platform === "win32" ? "windows:1" : "linux:1";
		writeFileSync(lockPath, `${JSON.stringify(liveRecord)}\n`, "utf-8");
		utimesSync(lockPath, old, old);
		const recovered = claimCompanyRuntimeLock(root);
		releaseCompanyRuntimeLock(recovered);
	});

	it("keeps empty registered product storage cloneable", () => {
		const company = join(root, "company");
		const clone = join(root, "company-clone");
		scaffoldCompany(company);
		const department = scaffoldProductDepartment(company, "Widget");
		expect(spawnSync("git", ["clone", company, clone], { stdio: "ignore" }).status).toBe(0);
		expect(readProductProtectionInventory(clone)).toHaveLength(1);
		expect(existsSync(join(clone, department.repositoryPath, ".gitkeep"))).toBe(true);
		expect(existsSync(join(clone, department.worktreesPath, ".gitkeep"))).toBe(true);
	});

	it("fails closed when an existing product repository differs from the reviewed source", () => {
		const company = join(root, "company");
		const sourceA = join(root, "source-a");
		const sourceB = join(root, "source-b");
		for (const source of [sourceA, sourceB]) {
			mkdirSync(source, { recursive: true });
			writeFileSync(join(source, "README.md"), `${source}\n`, "utf-8");
			for (const args of [
				["init"],
				["add", "README.md"],
				["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
			]) {
				expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
			}
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, sourceA, "Widget")).toBe(true);
		expect(() => integrateRepo(company, sourceB, "Widget")).toThrow("does not match");
	});

	it("reconciles a pending product transaction after repository promotion", () => {
		const company = join(root, "company");
		const source = join(root, "source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "README.md"), "source\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		const transactionPath = join(company, ".qorpera", "product-integrations", "widget-development.json");
		const interrupted = JSON.parse(readFileSync(transactionPath, "utf-8")) as Record<string, unknown>;
		interrupted.status = "pending";
		delete interrupted.sourceHead;
		writeFileSync(transactionPath, `${JSON.stringify(interrupted, null, "\t")}\n`, "utf-8");

		expect(integrateRepo(company, source, "Widget")).toBe(true);
		expect(JSON.parse(readFileSync(transactionPath, "utf-8"))).toMatchObject({
			status: "completed",
			sourceHead: expect.stringMatching(/^[a-f0-9]{40,64}$/),
		});
		expect(spawnSync("git", ["status", "--porcelain"], { cwd: company, encoding: "utf-8" }).stdout).toBe("");
	});

	it("materializes and re-integrates a registered product after cloning the company", () => {
		const company = join(root, "company");
		const clone = join(root, "company-clone");
		const source = join(root, "source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "README.md"), "source\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		expect(spawnSync("git", ["clone", company, clone], { stdio: "ignore" }).status).toBe(0);
		expect(existsSync(join(clone, "departments", "widget-development", "repository"))).toBe(false);

		materializeClonedProductStorage(clone);
		expect(readProductProtectionInventory(clone)).toHaveLength(1);
		const transaction = JSON.parse(
			readFileSync(join(clone, ".qorpera", "product-integrations", "widget-development.json"), "utf-8"),
		) as { destination: string; staging: string };
		expect(isAbsolute(transaction.destination)).toBe(false);
		expect(isAbsolute(transaction.staging)).toBe(false);
		expect(integrateRepo(clone, source, "Widget")).toBe(true);
		expect(existsSync(join(clone, "departments", "widget-development", "repository", ".git"))).toBe(true);
	});

	it("supports an explicit source rebind when hydrating a cloned company", () => {
		const company = join(root, "company");
		const clone = join(root, "company-clone");
		const source = join(root, "source");
		const reboundSource = join(root, "rebound-source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "README.md"), "source\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		expect(spawnSync("git", ["clone", source, reboundSource], { stdio: "ignore" }).status).toBe(0);
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		expect(spawnSync("git", ["clone", company, clone], { stdio: "ignore" }).status).toBe(0);
		materializeClonedProductStorage(clone);

		expect(integrateRepo(clone, reboundSource, "Widget")).toBe(true);
		const transaction = JSON.parse(
			readFileSync(join(clone, ".qorpera", "product-integrations", "widget-development.json"), "utf-8"),
		) as { source: string; sourceHistory: Array<{ source: string }> };
		expect(transaction.source).toBe(reboundSource);
		expect(transaction.sourceHistory).toEqual([expect.objectContaining({ source })]);
	});

	it("rejects credential and query data in derived remotes across URL schemes", () => {
		for (const [index, origin] of [
			"https://user:secret@example.invalid/widget.git",
			"ssh://git:secret@example.invalid/widget.git",
			"git://example.invalid/widget.git?token=secret",
		].entries()) {
			const company = join(root, `company-${index}`);
			const source = join(root, `source-${index}`);
			mkdirSync(source, { recursive: true });
			writeFileSync(join(source, "README.md"), "source\n", "utf-8");
			for (const args of [
				["init"],
				["add", "README.md"],
				["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
				["remote", "add", "origin", origin],
			]) {
				expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
			}
			scaffoldCompany(company);
			expect(() => integrateRepo(company, source, "Widget")).toThrow("cannot be persisted");
			expect(existsSync(join(company, "departments", "widget-development"))).toBe(false);
			expect(spawnSync("git", ["grep", "-F", origin], { cwd: company, stdio: "ignore" }).status).toBe(1);
		}
	});

	it("preserves a legitimate SSH username without persisting a password", () => {
		const company = join(root, "company");
		const source = join(root, "source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "README.md"), "source\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
			["remote", "add", "origin", "ssh://git@example.invalid/widget.git"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		expect(
			JSON.parse(
				readFileSync(join(company, ".qorpera", "product-integrations", "widget-development.json"), "utf-8"),
			),
		).toMatchObject({ portableSource: "ssh://git@example.invalid/widget.git" });
	});

	it("quarantines and retries an interrupted staging clone", () => {
		const company = join(root, "company");
		const source = join(root, "source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "README.md"), "source\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		const transactionPath = join(company, ".qorpera", "product-integrations", "widget-development.json");
		const transaction = JSON.parse(readFileSync(transactionPath, "utf-8")) as Record<string, unknown>;
		transaction.status = "pending";
		transaction.staging = "aaaaaaaaaaaa";
		delete transaction.sourceHead;
		writeFileSync(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`, "utf-8");
		rmSync(join(company, "departments", "widget-development", "repository"), { recursive: true });
		mkdirSync(join(company, "departments", "widget-development", "repository"));
		const attempts = join(company, ".git", "qorpera-product-integrations", "widget-development", "attempts");
		mkdirSync(join(attempts, "aaaaaaaaaaaa"), { recursive: true });
		writeFileSync(join(attempts, "aaaaaaaaaaaa", "partial"), "incomplete", "utf-8");

		expect(integrateRepo(company, source, "Widget")).toBe(true);
		const recovered = JSON.parse(readFileSync(transactionPath, "utf-8")) as {
			recoveries: Array<{ quarantined: string }>;
		};
		expect(recovered.recoveries).toHaveLength(1);
		expect(
			existsSync(
				join(
					company,
					".git",
					"qorpera-product-integrations",
					"widget-development",
					"quarantine",
					recovered.recoveries[0].quarantined,
				),
			),
		).toBe(true);
		expect(spawnSync("git", ["ls-files", ".qorpera/.p"], { cwd: company, encoding: "utf-8" }).stdout).toBe("");
	});

	it("reconciles a quarantine move journaled before a crash", () => {
		const company = join(root, "company");
		const source = join(root, "source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "README.md"), "source\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		const transactionPath = join(company, ".qorpera", "product-integrations", "widget-development.json");
		const transaction = JSON.parse(readFileSync(transactionPath, "utf-8")) as Record<string, unknown>;
		transaction.status = "pending";
		transaction.staging = "bbbbbbbbbbbb";
		delete transaction.sourceHead;
		transaction.recoveries = [
			{
				staging: "aaaaaaaaaaaa",
				quarantined: "aaaaaaaaaaaa.failed-cccccccccccc",
				startedAt: new Date().toISOString(),
				reason: "simulated crash before rename",
			},
		];
		writeFileSync(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`, "utf-8");
		rmSync(join(company, "departments", "widget-development", "repository"), { recursive: true });
		mkdirSync(join(company, "departments", "widget-development", "repository"));
		const storage = join(company, ".git", "qorpera-product-integrations", "widget-development");
		mkdirSync(join(storage, "attempts", "aaaaaaaaaaaa"), { recursive: true });
		writeFileSync(join(storage, "attempts", "aaaaaaaaaaaa", "partial"), "preserve", "utf-8");

		expect(integrateRepo(company, source, "Widget")).toBe(true);
		const reconciled = JSON.parse(readFileSync(transactionPath, "utf-8")) as {
			recoveries: Array<{ completedAt?: string; quarantined: string }>;
		};
		expect(reconciled.recoveries[0].completedAt).toEqual(expect.any(String));
		expect(existsSync(join(storage, "quarantine", reconciled.recoveries[0].quarantined, "partial"))).toBe(true);
	});

	it("reconciles a portable quarantine journal when machine-local clone bytes are unavailable", () => {
		const company = join(root, "company");
		const clone = join(root, "company-clone");
		const source = join(root, "source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "README.md"), "source\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		const transactionRelative = ".qorpera/product-integrations/widget-development.json";
		const transactionPath = join(company, transactionRelative);
		const transaction = JSON.parse(readFileSync(transactionPath, "utf-8")) as Record<string, unknown>;
		transaction.status = "pending";
		transaction.staging = "bbbbbbbbbbbb";
		delete transaction.sourceHead;
		transaction.recoveries = [
			{
				staging: "aaaaaaaaaaaa",
				quarantined: "aaaaaaaaaaaa.failed-cccccccccccc",
				startedAt: new Date().toISOString(),
				reason: "portable crash journal",
			},
		];
		writeFileSync(transactionPath, `${JSON.stringify(transaction, null, "\t")}\n`, "utf-8");
		for (const args of [
			["add", transactionRelative],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "journal"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		expect(spawnSync("git", ["clone", company, clone], { stdio: "ignore" }).status).toBe(0);
		materializeClonedProductStorage(clone);
		expect(integrateRepo(clone, source, "Widget")).toBe(true);
		const recovered = JSON.parse(readFileSync(join(clone, transactionRelative), "utf-8")) as {
			recoveries: Array<{ completedAt?: string; outcome?: string }>;
		};
		expect(recovered.recoveries[0]).toMatchObject({
			completedAt: expect.any(String),
			outcome: "source-storage-unavailable",
		});
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

	it("rejects a changed founder-reviewed worktree plan before creating a clone", () => {
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
		try {
			const plan = planProductWorktree(root, department, runtimeLock)!;
			expect(() =>
				createProductWorktree(root, department, runtimeLock, { ...plan, branch: "qorpera/bad..ref" }),
			).toThrow("changed after founder review");
		} finally {
			releaseCompanyRuntimeLock(runtimeLock);
		}
		expect(readdirSync(join(root, department.worktreesPath))).toEqual([".gitkeep"]);
	});

	it("restores active product commits from the company-carried recovery bundle", () => {
		const company = join(root, "company");
		const source = join(root, "source");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "product.ts"), "export const value = 1;\n", "utf-8");
		for (const args of [
			["init"],
			["add", "product.ts"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: source, stdio: "ignore" }).status).toBe(0);
		}
		scaffoldCompany(company);
		expect(integrateRepo(company, source, "Widget")).toBe(true);
		const department = listProductDepartments(company)[0];
		let worktree: NonNullable<ReturnType<typeof createProductWorktree>>;
		let runtimeLock = claimCompanyRuntimeLock(company);
		try {
			const plan = planProductWorktree(company, department, runtimeLock)!;
			worktree = createProductWorktree(company, department, runtimeLock, plan)!;
		} finally {
			releaseCompanyRuntimeLock(runtimeLock);
		}
		const worktreeRoot = join(company, worktree.path);
		writeFileSync(join(worktreeRoot, "product.ts"), "export const value = 2;\n", "utf-8");
		for (const args of [
			["add", "product.ts"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "worker change"],
		]) {
			expect(spawnSync("git", args, { cwd: worktreeRoot, stdio: "ignore" }).status).toBe(0);
		}
		const firstRecoveryHead = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: worktreeRoot,
			encoding: "utf-8",
		}).stdout.trim();
		const taskId = worktree.path.replace(/\\/g, "/").split("/").at(-1)!;
		mkdirSync(join(company, ".qorpera", "w"), { recursive: true });
		const storeBundle = (name: string, revisions: string[]): string => {
			const temporaryBundle = join(company, ".qorpera", "w", `${name}.tmp`);
			expect(
				spawnSync("git", ["bundle", "create", temporaryBundle, ...revisions], {
					cwd: worktreeRoot,
					stdio: "ignore",
				}).status,
			).toBe(0);
			const bundleId = spawnSync("git", ["hash-object", "--no-filters", temporaryBundle], {
				cwd: company,
				encoding: "utf-8",
			})
				.stdout.trim()
				.slice(0, 32);
			const path = `.qorpera/w/${bundleId}.bundle`;
			renameSync(temporaryBundle, join(company, path));
			return path;
		};
		const fullBundle = storeBundle("full", [worktree.branch]);
		writeFileSync(join(worktreeRoot, "product.ts"), "export const value = 3;\n", "utf-8");
		for (const args of [
			["add", "product.ts"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "second worker change"],
		]) {
			expect(spawnSync("git", args, { cwd: worktreeRoot, stdio: "ignore" }).status).toBe(0);
		}
		const recoveryHead = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: worktreeRoot,
			encoding: "utf-8",
		}).stdout.trim();
		const incrementalBundle = storeBundle("incremental", [`^${firstRecoveryHead}`, worktree.branch]);
		const assignmentRelative = `.qorpera/product-worktrees/${department.id}/${taskId}.json`;
		const assignmentPath = join(company, assignmentRelative);
		const assignment = JSON.parse(readFileSync(assignmentPath, "utf-8")) as Record<string, unknown>;
		assignment.recoveryHead = recoveryHead;
		assignment.recoveryBundles = [
			{ path: fullBundle, head: firstRecoveryHead },
			{ path: incrementalBundle, head: recoveryHead, baseHead: firstRecoveryHead },
		];
		assignment.recoveryUpdatedAt = new Date().toISOString();
		writeFileSync(assignmentPath, `${JSON.stringify(assignment, null, "\t")}\n`, "utf-8");
		for (const args of [
			["add", assignmentRelative, fullBundle, incrementalBundle],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "recovery"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		rmSync(worktreeRoot, { recursive: true });

		runtimeLock = claimCompanyRuntimeLock(company);
		try {
			const recovery = planProductWorktreeRecovery(company, department, worktree.path, runtimeLock)!;
			expect(recovery.recoveryHead).toBe(recoveryHead);
			expect(recoverProductWorktree(company, department, runtimeLock, recovery)?.recoveryHead).toBe(recoveryHead);
		} finally {
			releaseCompanyRuntimeLock(runtimeLock);
		}
		expect(readFileSync(join(worktreeRoot, "product.ts"), "utf-8")).toBe("export const value = 3;\n");
		expect(readProductWorktreeAssignment(company, department, worktree.path)?.recoveryHead).toBe(recoveryHead);
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

describe("environment export and import", () => {
	let exportDir: string;
	let importDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		exportDir = `${root}-export`;
		importDir = `${root}-import`;
		prevAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
		process.env.QORPERA_CODING_AGENT_DIR = `${root}-agent-home`;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
		else process.env.QORPERA_CODING_AGENT_DIR = prevAgentDir;
		for (const dir of [exportDir, importDir, `${root}-agent-home`]) {
			if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function scaffoldWithTrail(): void {
		scaffoldCompany(root);
		const sessionManager = SessionManager.create(root, join(root, "trail"), { id: "export-smoke" });
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello export" }],
			timestamp: Date.now(),
		} as never);
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
		const written = readdirSync(join(root, "trail")).filter((name) => name.endsWith(".jsonl"));
		expect(written.length, "trail session file exists before export").toBe(1);
	}

	it("round-trips: export is independently inspectable and import reproduces the environment", () => {
		scaffoldWithTrail();
		writeFileSync(join(root, "departments", "notes.md"), "# Agent-owned state\n", "utf-8");

		const exported = exportCompany(root, exportDir);
		expect(exported.manifest.schema).toBe("qorpera.export/v1");
		expect(exported.manifest.contractVersion).toBe(ENVIRONMENT_CONTRACT_VERSION);
		expect(exported.manifest.sourceHead).toMatch(/^[0-9a-f]{40}$/);

		// Independent inspection: plain fs reads against the export, no runtime.
		const company = join(exportDir, "company");
		expect(readFileSync(join(company, "company.md"), "utf-8")).toContain("company");
		expect(readFileSync(join(company, "authority.toml"), "utf-8")).toContain("[");
		expect(readFileSync(join(company, "departments", "notes.md"), "utf-8")).toContain("Agent-owned");
		const trailFiles = readdirSync(join(company, "trail")).filter((name) => name.endsWith(".jsonl"));
		expect(trailFiles.length).toBe(1);
		const trailLines = readFileSync(join(company, "trail", trailFiles[0]), "utf-8")
			.split("\n")
			.filter((line) => line.trim());
		expect(JSON.parse(trailLines[0]).type).toBe("session");
		expect(trailLines.some((line) => line.includes("hello export"))).toBe(true);
		// Machine-local runtime state never travels in an export.
		expect(existsSync(join(company, ".git", "qorpera-runtime-locks"))).toBe(false);

		const imported = importCompany(exportDir, importDir);
		expect(imported.head).toBe(exported.manifest.sourceHead);
		for (const entry of ["company.md", "authority.toml", "AGENTS.md", "trail", join("app", "projection.json")]) {
			expect(existsSync(join(importDir, entry)), entry).toBe(true);
		}
		expect(readFileSync(join(importDir, "departments", "notes.md"), "utf-8")).toContain("Agent-owned");
		const importedHead = spawnSync("git", ["-C", importDir, "rev-parse", "--verify", "HEAD"], {
			encoding: "utf-8",
		});
		expect(importedHead.stdout.trim()).toBe(exported.manifest.sourceHead);
		// Fresh environment identity: no runtime-lock state carried over.
		expect(existsSync(join(importDir, ".git", "qorpera-runtime-locks"))).toBe(false);
	});

	it("refuses to export a live environment", () => {
		scaffoldCompany(root);
		const lock = claimCompanyRuntimeLock(root);
		try {
			expect(() => exportCompany(root, exportDir)).toThrow(/already owned/);
		} finally {
			releaseCompanyRuntimeLock(lock);
		}
	});

	it("refuses a destination inside the company or a non-empty destination", () => {
		scaffoldCompany(root);
		expect(() => exportCompany(root, join(root, "backup"))).toThrow(/inside the company/);
		mkdirSync(exportDir, { recursive: true });
		writeFileSync(join(exportDir, "occupied.txt"), "x", "utf-8");
		expect(() => exportCompany(root, exportDir)).toThrow(/not empty/);
	});

	it("refuses an export that requires a newer environment contract", () => {
		scaffoldCompany(root);
		exportCompany(root, exportDir);
		const manifestPath = join(exportDir, EXPORT_MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		manifest.contractVersion = ENVIRONMENT_CONTRACT_VERSION + 1;
		writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
		expect(() => importCompany(exportDir, importDir)).toThrow(/requires environment contract/);
	});

	it("refuses an import whose history head does not match the manifest", () => {
		scaffoldCompany(root);
		exportCompany(root, exportDir);
		const manifestPath = join(exportDir, EXPORT_MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		manifest.sourceHead = "0".repeat(40);
		writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
		expect(() => importCompany(exportDir, importDir)).toThrow(/does not match/);
	});
});
