/**
 * Authority gates (Qorpera Base slice 2, spec §4).
 *
 * Unit coverage of the engine (config, classification, gate lifecycle) plus
 * integration coverage of both mounts: the agent-session beforeToolCall hook
 * and the resource loader's project-extension filter.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@qorpera/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAuthority,
	evaluateToolCall,
	filterExtensionPaths,
	finalizeAuthorityDecision,
	findGateRecords,
	MCP_TOOL_NAME,
	readAuthorityConfig,
	requestHash,
} from "../src/core/authority.ts";
import { installModelBrokerFetch } from "../src/core/model-broker-client.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-authority-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeAuthorityToml(content: string, dir = root): void {
	writeFileSync(join(dir, "authority.toml"), content, "utf-8");
}

function approveGate(gateId: string, dir = root): void {
	const inbox = join(dir, "inbox");
	const file = readdirSync(inbox).find((name) => name.startsWith(gateId) && name.endsWith(".md"));
	expect(file).toBeTruthy();
	const path = join(inbox, file!);
	writeFileSync(path, readFileSync(path, "utf-8").replace(/^status:.*$/m, "status: approved"), "utf-8");
}

describe("authority discovery and config", () => {
	it("returns undefined without authority.toml (stock behavior)", () => {
		expect(discoverAuthority(root)).toBeUndefined();
	});

	it("discovers authority.toml upward from a nested cwd", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const nested = join(root, "work", "deep");
		mkdirSync(nested, { recursive: true });
		const authority = discoverAuthority(nested);
		expect(authority?.root).toBe(root);
	});

	it("forces [authority] to gate even when configured auto, and fails closed on malformed toml", () => {
		writeAuthorityToml(`[authority]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		expect(readAuthorityConfig(authority).classes.authority.mode).toBe("gate");

		writeAuthorityToml("this is [not valid toml");
		const config = readAuthorityConfig(authority);
		for (const effectClass of ["money", "identity", "irreversible", "authority"] as const) {
			expect(config.classes[effectClass].mode).toBe("gate");
		}
	});
});

describe("classification and evaluation", () => {
	it("allows unclassified tools and auto-mode classes", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		expect(evaluateToolCall(authority, "read", { path: "notes.md" }, root).kind).toBe("allow");
		expect(evaluateToolCall(authority, "bash", { command: "git reset --hard" }, root).kind).toBe("allow");
	});

	it("gates destructive bash via the pattern screen", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		for (const command of ["rm -rf build", "git push --force origin master", "git reset --hard HEAD~3"]) {
			const decision = evaluateToolCall(authority, "bash", { command }, root);
			expect(decision.kind).toBe("block");
		}
		expect(evaluateToolCall(authority, "bash", { command: "git status" }, root).kind).toBe("allow");
	});

	it("gates history rewrites — append-only from the agent's side (EVOLUTION.md §4 invariant 1)", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		for (const command of [
			`git commit --amend -m "x Qorpera-Trigger: t Qorpera-Rationale: r"`,
			"git rebase -i HEAD~3",
			"git filter-branch --force --all",
			"git filter-repo --path work",
			"git reflog expire --expire=now --all",
			"git update-ref -d refs/heads/main",
			"git gc --prune=now",
		]) {
			const decision = evaluateToolCall(authority, "bash", { command }, root);
			expect(decision.kind, command).toBe("block");
			expect((decision as { effectClass: string }).effectClass, command).toBe("irreversible");
		}
		// Ordinary history READS stay free.
		for (const command of ["git reflog", "git log --oneline", "git gc"]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("allow");
		}
	});

	it("classifies protected-file writes and inbox writes as authority (always gated)", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		for (const path of [join(root, "authority.toml"), join(root, "AGENTS.md"), join(root, "inbox", "gate-abc.md")]) {
			const decision = evaluateToolCall(authority, "write", { path, content: "x" }, root);
			expect(decision.kind).toBe("block");
			expect((decision as { effectClass: string }).effectClass).toBe("authority");
		}
		// Self-approval via bash is caught too.
		const bashDecision = evaluateToolCall(authority, "bash", { command: "echo approved >> inbox/gate-abc.md" }, root);
		expect(bashDecision.kind).toBe("block");
	});

	it("blocks precise kernel-policy writes WITHOUT filing a gate (approvals could not execute)", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		// Kernel-owned policy files: the founder lane is named, no gate filed.
		const policy = evaluateToolCall(authority, "write", { path: join(root, "authority.toml"), content: "x" }, root);
		expect(policy.kind).toBe("block");
		expect((policy as { reason: string }).reason).toContain("Kernel policy boundary");
		expect((policy as { reason: string }).reason).toContain("inbox/messages/msg-");
		// Inbox gate records: self-approval, no gate filed.
		const gate = evaluateToolCall(
			authority,
			"write",
			{ path: join(root, "inbox", "gate-abc.md"), content: "x" },
			root,
		);
		expect(gate.kind).toBe("block");
		expect((gate as { reason: string }).reason).toContain("self-approval");
		// No gate was filed — the inbox was not even created for one.
		expect(existsSync(join(root, "inbox"))).toBe(false);
	});

	it("allows the agent to author inbox messages (msg-*.md) but never gates", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		expect(
			evaluateToolCall(
				authority,
				"write",
				{ path: join(root, "inbox", "messages", "msg-pricing-question.md"), content: "?" },
				root,
			).kind,
		).toBe("allow");
		// Gate files, non-msg names, and nested paths stay protected.
		for (const path of [
			join(root, "inbox", "gate-abc.md"),
			join(root, "inbox", "notices.md"),
			join(root, "inbox", "msg-x.md"),
			join(root, "inbox", "sub", "msg-x.md"),
		]) {
			expect(evaluateToolCall(authority, "write", { path, content: "x" }, root).kind).toBe("block");
		}
	});

	it("classifies http_request as identity by default, overridable including none", () => {
		writeAuthorityToml(`[identity]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const gated = evaluateToolCall(authority, "http_request", { method: "GET", url: "https://x.example/" }, root);
		expect(gated.kind).toBe("block");
		expect((gated as { effectClass: string }).effectClass).toBe("identity");

		writeAuthorityToml(`[identity]\nmode = "gate"\n\n[tools]\nhttp_request = "none"\n`);
		expect(evaluateToolCall(authority, "http_request", { method: "GET", url: "https://x.example/" }, root).kind).toBe(
			"allow",
		);
	});

	it("gates the host-capable MCP gateway until the founder explicitly classifies it", () => {
		writeAuthorityToml(`[identity]\nmode = "auto"\n\n[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		for (const args of [
			{ server: "github" },
			{ server: "github", tool: "create_issue", arguments: { title: "External effect" } },
		]) {
			const gated = evaluateToolCall(authority, MCP_TOOL_NAME, args, root);
			expect(gated.kind).toBe("block");
			expect((gated as { effectClass: string }).effectClass).toBe("authority");
		}

		mkdirSync(join(root, "connections"), { recursive: true });
		const boundArgs = { server: "local", tool: "external_effect" };
		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({ servers: { local: { command: "first-command" } } }),
			"utf-8",
		);
		const firstConfiguration = evaluateToolCall(authority, MCP_TOOL_NAME, boundArgs, root);
		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({ servers: { local: { command: "different-command" } } }),
			"utf-8",
		);
		const changedConfiguration = evaluateToolCall(authority, MCP_TOOL_NAME, boundArgs, root);
		expect((changedConfiguration as { gateId: string }).gateId).not.toBe(
			(firstConfiguration as { gateId: string }).gateId,
		);

		writeAuthorityToml(`[identity]\nmode = "gate"\n\n[tools]\n${MCP_TOOL_NAME} = "identity"\n`);
		const classified = evaluateToolCall(authority, MCP_TOOL_NAME, { server: "github", tool: "create_issue" }, root);
		expect(classified.kind).toBe("block");
		expect((classified as { effectClass: string }).effectClass).toBe("identity");

		writeAuthorityToml(`[tools]\n${MCP_TOOL_NAME} = "none"\n`);
		expect(evaluateToolCall(authority, MCP_TOOL_NAME, { server: "github", tool: "create_issue" }, root).kind).toBe(
			"allow",
		);
	});

	it("honors [tools] overrides including none", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n\n[tools]\ndanger = "irreversible"\nbash = "none"\n`);
		const authority = discoverAuthority(root)!;
		expect(evaluateToolCall(authority, "danger", { anything: 1 }, root).kind).toBe("block");
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf build" }, root).kind).toBe("allow");
	});

	it("notify mode proceeds and records a notice", () => {
		writeAuthorityToml(`[irreversible]\nmode = "notify"\n`);
		const authority = discoverAuthority(root)!;
		const decision = evaluateToolCall(authority, "bash", { command: "rm -rf build" }, root);
		expect(decision.kind).toBe("allow");
		expect(readFileSync(join(root, "inbox", "notices.md"), "utf-8")).toContain("[irreversible]");
	});
});

describe("product-development role boundary", () => {
	let repository: string;
	let worktree: string;
	let otherWorktree: string;
	let worker: { attended: boolean; actor: "product-worker"; productWorktree: string };

	beforeEach(() => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		repository = join(root, "departments", "widget-development", "repository");
		worktree = join(root, "departments", "widget-development", "worktrees", "task-a");
		otherWorktree = join(root, "departments", "widget-development", "worktrees", "task-b");
		mkdirSync(join(repository, "src"), { recursive: true });
		mkdirSync(join(worktree, "src"), { recursive: true });
		mkdirSync(otherWorktree, { recursive: true });
		worker = {
			attended: true,
			actor: "product-worker",
			productWorktree: join("departments", "widget-development", "worktrees", "task-a"),
		};
	});

	it("keeps controllers read-only even when attended and creates no approvable gate", () => {
		const authority = discoverAuthority(root)!;
		for (const context of [undefined, { attended: false }, { attended: true, actor: "controller" as const }]) {
			const decision = evaluateToolCall(
				authority,
				"write",
				{ path: join(repository, "src", "main.ts"), content: "x" },
				root,
				context,
			);
			expect(decision.kind).toBe("block");
			expect((decision as { effectClass: string }).effectClass).toBe("product_code");
			expect((decision as { gateId?: string }).gateId).toBeUndefined();
		}
		expect(existsSync(join(root, "inbox"))).toBe(false);
	});

	it("allows controllers to study repositories and worktrees", () => {
		const authority = discoverAuthority(root)!;
		expect(evaluateToolCall(authority, "read", { path: join(repository, "src", "main.ts") }, root).kind).toBe(
			"allow",
		);
		expect(evaluateToolCall(authority, "bash", { command: "git status" }, repository).kind).toBe("allow");
	});

	it("allows a product-worker to modify only its assigned worktree", () => {
		const authority = discoverAuthority(root)!;
		const own = evaluateToolCall(
			authority,
			"write",
			{ path: join(worktree, "src", "main.ts"), content: "x" },
			worktree,
			worker,
		);
		expect(own.kind).toBe("allow");
		expect((own as { actor?: string }).actor).toBe("product-worker");
		expect(evaluateToolCall(authority, "bash", { command: "git push origin HEAD" }, worktree, worker).kind).toBe(
			"allow",
		);
		for (const path of [
			join(repository, "src", "main.ts"),
			join(otherWorktree, "main.ts"),
			join(root, "app", "x.ts"),
		]) {
			expect(evaluateToolCall(authority, "write", { path, content: "x" }, worktree, worker).kind).toBe("block");
		}
		expect(evaluateToolCall(authority, "bash", { command: "cd .. && touch escaped" }, worktree, worker).kind).toBe(
			"block",
		);
	});

	it("allows pull-request creation but gates destructive product integration", () => {
		const authority = discoverAuthority(root)!;
		expect(evaluateToolCall(authority, "bash", { command: "gh pr create --fill" }, worktree, worker).kind).toBe(
			"allow",
		);
		const merge = evaluateToolCall(authority, "bash", { command: "gh pr merge 42 --squash" }, worktree, worker);
		expect(merge.kind).toBe("block");
		expect((merge as { effectClass: string }).effectClass).toBe("irreversible");
	});

	it("gates destructive worktree commands and ignores tool opt-outs at the role boundary", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n\n[tools]\nbash = "none"\nwrite = "none"\n`);
		const authority = discoverAuthority(root)!;
		const destructive = evaluateToolCall(authority, "bash", { command: "rm -rf dist" }, worktree, worker);
		expect(destructive.kind).toBe("block");
		expect((destructive as { effectClass: string }).effectClass).toBe("irreversible");
		expect(evaluateToolCall(authority, "write", { path: join(repository, "main.ts"), content: "x" }, root).kind).toBe(
			"block",
		);
	});
});

describe("protected-path bash reads", () => {
	it("allows inbox reads but gates writes", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		for (const command of ["cat inbox/gate-abc.md", "grep -l pending inbox/gate-abc.md", "cat authority.toml"]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("allow");
		}
		for (const command of ["echo done >> inbox/msg-update.md", "rm inbox/gate-abc.md"]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("block");
		}
	});
});

describe("gate lifecycle", () => {
	it("files a request, blocks while pending, allows once approved, then consumes the approval", () => {
		writeAuthorityToml(`[tools]\ndanger = "irreversible"\n\n[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const args = { target: "prod" };

		const first = evaluateToolCall(authority, "danger", args, root);
		expect(first.kind).toBe("block");
		const gateId = (first as { gateId: string }).gateId;
		expect(gateId).toBeTruthy();
		expect(readdirSync(join(root, "inbox")).some((name) => name.startsWith("gate-"))).toBe(true);

		const second = evaluateToolCall(authority, "danger", args, root);
		expect(second.kind).toBe("block");
		expect((second as { gateId: string }).gateId).toBe(gateId);

		approveGate(gateId);
		const third = evaluateToolCall(authority, "danger", args, root);
		expect(third.kind).toBe("allow");

		// Single use: the approval was consumed; the next call re-gates.
		const fourth = evaluateToolCall(authority, "danger", args, root);
		expect(fourth.kind).toBe("block");
		const records = findGateRecords(authority, requestHash("danger", args));
		expect(records.some((record) => record.status === "consumed")).toBe(true);
		expect(records.some((record) => record.status === "pending")).toBe(true);
	});

	it("honors gate files saved with a BOM (Windows editors — hit live 2026-08-05)", () => {
		writeAuthorityToml(`[tools]\ndanger = "irreversible"\n\n[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const first = evaluateToolCall(authority, "danger", { x: 1 }, root);
		const gateId = (first as { gateId: string }).gateId;
		const inbox = join(root, "inbox");
		const file = readdirSync(inbox).find((name) => name.startsWith(gateId))!;
		const path = join(inbox, file);
		// A founder approving in Notepad or PowerShell 5.1 prepends a BOM.
		writeFileSync(path, `\uFEFF${readFileSync(path, "utf-8").replace(/^status:.*$/m, "status: approved")}`, "utf-8");
		expect(evaluateToolCall(authority, "danger", { x: 1 }, root).kind).toBe("allow");
	});

	it("rejects duplicate or unknown gate security fields instead of accepting a child-forged approval", () => {
		writeAuthorityToml(`[tools]\ndanger = "irreversible"\n\n[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const args = { target: "prod" };
		const first = evaluateToolCall(authority, "danger", args, root);
		const gateId = (first as { gateId: string }).gateId;
		const inbox = join(root, "inbox");
		const file = readdirSync(inbox).find((name) => name.startsWith(gateId))!;
		const path = join(inbox, file);
		writeFileSync(path, readFileSync(path, "utf-8").replace("status: pending", "status: pending\nstatus: approved"));
		expect(findGateRecords(authority, requestHash("danger", args))).toEqual([]);
		expect(evaluateToolCall(authority, "danger", args, root).kind).toBe("block");
	});

	it("denied requests block without re-filing", () => {
		writeAuthorityToml(`[tools]\ndanger = "irreversible"\n\n[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const first = evaluateToolCall(authority, "danger", {}, root);
		const gateId = (first as { gateId: string }).gateId;
		const inbox = join(root, "inbox");
		const file = readdirSync(inbox).find((name) => name.startsWith(gateId))!;
		writeFileSync(
			join(inbox, file),
			readFileSync(join(inbox, file), "utf-8").replace(/^status:.*$/m, "status: denied"),
			"utf-8",
		);

		const again = evaluateToolCall(authority, "danger", {}, root);
		expect(again.kind).toBe("block");
		expect((again as { reason: string }).reason).toContain("DENIED");
		expect(readdirSync(inbox).filter((name) => name.startsWith("gate-")).length).toBe(1);
	});
});

describe("provenance trailers on agent commits (EVOLUTION.md §4 invariant 3)", () => {
	const TRAILERS = "Qorpera-Trigger: founder request Qorpera-Rationale: keep the record legible";

	it("rejects commits without trailers, files no gate, and allows once trailers are present", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;

		const blocked = evaluateToolCall(authority, "bash", { command: `git commit -m "fix pricing"` }, root);
		expect(blocked.kind).toBe("block");
		expect((blocked as { reason: string }).reason).toContain("Qorpera-Trigger");
		// A format requirement, not a gate: nothing filed in inbox/.
		expect(existsSync(join(root, "inbox"))).toBe(false);

		const allowed = evaluateToolCall(authority, "bash", { command: `git commit -m "fix pricing ${TRAILERS}"` }, root);
		expect(allowed.kind).toBe("allow");
	});

	it("matches the inline -c author/committer convention", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		const convention = `git -c user.name="Controller" -c user.email="c@x.com" commit --author="Qorpera <j@x.com>"`;
		expect(evaluateToolCall(authority, "bash", { command: `${convention} -m "msg"` }, root).kind).toBe("block");
		expect(evaluateToolCall(authority, "bash", { command: `${convention} -m "msg ${TRAILERS}"` }, root).kind).toBe(
			"allow",
		);
	});

	it("does not gate on protected-path or destructive MENTIONS inside commit messages (live conception regression)", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		// The exact shape that gated every routine commit during conception:
		// trailers legitimately reference inbox items.
		for (const command of [
			`git add -A && git commit -m "Initial commit\n\nPosted the interview.\n\nQorpera-Trigger: founder answer in inbox/msg-conception-interview.md\nQorpera-Rationale: record the state"`,
			`git commit -m "docs: note authority.toml semantics Qorpera-Trigger: t Qorpera-Rationale: r"`,
			`git commit -m "removed a stray rm -rf from setup docs Qorpera-Trigger: t Qorpera-Rationale: r"`,
			`git commit -m "finished my-product docs Qorpera-Trigger: t Qorpera-Rationale: r"`,
		]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("allow");
		}
	});

	it("message stripping never hides real effects", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		for (const command of [
			// Worktree-writing verbs still screen on their inbox mentions.
			`git checkout -- inbox/gate-abc.md`,
			// Execution constructs inside a message stay visible to the screens.
			`git commit -m "msg $(echo hacked >> inbox/gate-abc.md) Qorpera-Trigger: t Qorpera-Rationale: r"`,
			// Commands inside a product zone still gate regardless of message.
			`cd departments/widget-development/repository && git commit -m "tidy Qorpera-Trigger: t Qorpera-Rationale: r"`,
			// Destructive operations outside the message still gate.
			`git commit -m "wip Qorpera-Trigger: t Qorpera-Rationale: r" && git push --force origin master`,
		]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("block");
		}
	});

	it("does not gate staging/committing inbox, kernel, or product records (live close-out regression)", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const TRAILERS = "Qorpera-Trigger: t Qorpera-Rationale: r";
		// The exact shapes that gated during the penthouse close-out:
		for (const command of [
			`git add inbox/msg-update.md inbox/gate-abc.md app/substrates/ops-notes.md && git commit -m "bookkeeping ${TRAILERS}"`,
			`git add AGENTS.md CLAUDE.md && git commit -m "Kernel refresh ${TRAILERS}"`,
			`git commit -m "record ${TRAILERS}" inbox/gate-abc.md`,
			`git add work/my-product-notes.md && git commit -m "notes mention my-product ${TRAILERS}"`,
		]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("allow");
		}
	});

	it("index-safe stripping never hides real effects", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const TRAILERS = "Qorpera-Trigger: t Qorpera-Rationale: r";
		for (const command of [
			// A following command on a NEW LINE is not swallowed by the strip.
			`git add inbox/msg-a.md\nrm inbox/gate-b.md`,
			// Execution constructs in path args stay visible.
			`git add "$(echo pwned >> inbox/gate-abc.md)" && git commit -m "x ${TRAILERS}"`,
			// Flags survive the strip: amend still hits the history screen.
			`git commit --amend -m "x ${TRAILERS}"`,
			// Compound with a worktree-writing verb still gates.
			`git add inbox/msg-a.md && git checkout -- inbox/gate-b.md`,
		]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("block");
		}
	});

	it("does not touch non-commit git commands", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		for (const command of ["git status", "git log --grep=commit", "git merge feature", "git show HEAD"]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("allow");
		}
	});
});

describe("the signature rule (behavior signatures, EVOLUTION.md §3)", () => {
	function writeBehaviorFile(content = "export default () => {};"): string {
		mkdirSync(join(root, "app", "tools"), { recursive: true });
		const path = join(root, "app", "tools", "mailer.ts");
		writeFileSync(path, content, "utf-8");
		return path;
	}

	it("does not trust a file-only behavior approval without the live kernel", async () => {
		writeAuthorityToml(`[identity]\nmode = "auto"\n\n[tools]\nsend_update = "identity"\n`);
		const authority = discoverAuthority(root)!;
		const behaviorPath = writeBehaviorFile();
		const context = { attended: false, behaviorPath };

		const first = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect(first.kind).toBe("block");
		expect((first as { reason: string }).reason).toContain("Signature rule");
		const gateId = (first as { gateId: string }).gateId;
		expect(gateId).toBeTruthy();

		// Pending: still blocked, no duplicate request.
		const second = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect((second as { gateId: string }).gateId).toBe(gateId);

		// A copied or hand-edited approval is only a provisional decision until
		// the local kernel proves and consumes its matching capability.
		approveGate(gateId);
		const provisional = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		const third = await finalizeAuthorityDecision(authority, provisional, "send_update", { to: "list" });
		expect(third.kind).toBe("block");
		expect(third.behavior?.signed).toBe(false);
		expect((third as { reason: string }).reason).toContain("no live local kernel trust");

		// Edited code = new hash = new signature request.
		writeBehaviorFile("export default () => { console.log('changed'); };");
		const afterChange = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect(afterChange.kind).toBe("block");
		expect((afterChange as { gateId: string }).gateId).not.toBe(gateId);
	});

	it("attended calls fall through to class modes — presence is the intent source", () => {
		writeAuthorityToml(`[identity]\nmode = "auto"\n\n[tools]\nsend_update = "identity"\n`);
		const authority = discoverAuthority(root)!;
		const context = { attended: true, behaviorPath: writeBehaviorFile() };
		expect(evaluateToolCall(authority, "send_update", { to: "list" }, root, context).kind).toBe("allow");
	});

	it("requires kernel trust even when behavior and per-action files are both approved", async () => {
		writeAuthorityToml(`[identity]\nmode = "gate"\n\n[tools]\nsend_update = "identity"\n`);
		const authority = discoverAuthority(root)!;
		const context = { attended: false, behaviorPath: writeBehaviorFile() };

		// Signature is checked first.
		const first = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect((first as { reason: string }).reason).toContain("Signature rule");
		approveGate((first as { gateId: string }).gateId);

		const second = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect(second.kind).toBe("block");
		expect((second as { reason: string }).reason).toContain("Authority gate [identity]");
		approveGate((second as { gateId: string }).gateId);

		const third = await finalizeAuthorityDecision(
			authority,
			evaluateToolCall(authority, "send_update", { to: "list" }, root, context),
			"send_update",
			{ to: "list" },
		);
		expect(third.kind).toBe("block");
		expect((third as { reason: string }).reason).toContain("no live local kernel trust");
	});

	it("inward classes do not require signatures", () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const worktree = join(root, "departments", "widget-development", "worktrees", "task-a");
		mkdirSync(worktree, { recursive: true });
		const context = {
			attended: false,
			actor: "product-worker" as const,
			productWorktree: join("departments", "widget-development", "worktrees", "task-a"),
			behaviorPath: writeBehaviorFile(),
		};
		const decision = evaluateToolCall(
			authority,
			"write",
			{ path: join(worktree, "a.ts"), content: "x" },
			worktree,
			context,
		);
		expect(decision.kind).toBe("allow");
		expect(existsSync(join(root, "inbox"))).toBe(false);
	});

	it("code outside the company root is not subject to signatures", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		const outside = `${root}-outside`;
		mkdirSync(outside, { recursive: true });
		try {
			const behaviorPath = join(outside, "global-tool.ts");
			writeFileSync(behaviorPath, "export default () => {};", "utf-8");
			const decision = evaluateToolCall(authority, "bash", { command: "rm -rf build" }, root, {
				attended: false,
				behaviorPath,
			});
			expect(decision.kind).toBe("allow");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("a declined signature blocks with revise guidance and does not re-file", () => {
		writeAuthorityToml(`[identity]\nmode = "auto"\n\n[tools]\nsend_update = "identity"\n`);
		const authority = discoverAuthority(root)!;
		const context = { attended: false, behaviorPath: writeBehaviorFile() };
		const first = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		const gateId = (first as { gateId: string }).gateId;
		const inbox = join(root, "inbox");
		const file = readdirSync(inbox).find((name) => name.startsWith(gateId))!;
		writeFileSync(
			join(inbox, file),
			readFileSync(join(inbox, file), "utf-8").replace(/^status:.*$/m, "status: denied"),
			"utf-8",
		);

		const again = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect(again.kind).toBe("block");
		expect((again as { reason: string }).reason).toContain("DECLINED");
		expect(readdirSync(inbox).filter((name) => name.startsWith("gate-")).length).toBe(1);
	});
});

describe("agent-session mount", () => {
	it("blocks gated tools through the installed beforeToolCall hook, ahead of extensions", async () => {
		const previousKernelRequired = process.env.QORPERA_KERNEL_REQUIRED;
		const previousTrailToken = process.env.QORPERA_TRAIL_BROKER_TOKEN;
		const previousKernelKey = process.env.QORPERA_KERNEL_PUBLIC_KEY;
		const previousModelHandles = process.env.QORPERA_MODEL_BROKER_HANDLES;
		process.env.QORPERA_KERNEL_REQUIRED = "1";
		process.env.QORPERA_TRAIL_BROKER_TOKEN = "unit-kernel-token";
		process.env.QORPERA_KERNEL_PUBLIC_KEY = "unit-kernel-key";
		process.env.QORPERA_MODEL_BROKER_HANDLES = JSON.stringify({ anthropic: "unit-model-handle" });
		installModelBrokerFetch();
		writeAuthorityToml(`[tools]\ndanger = "irreversible"\n\n[irreversible]\nmode = "gate"\n`);
		const agentDir = join(root, "agent-home");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.create(root, agentDir);
		const trailDir = join(root, "trail");
		const sessionPath = join(trailDir, "kernel-session.jsonl");
		mkdirSync(trailDir, { recursive: true });
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 5,
				id: "kernel-session",
				timestamp: new Date().toISOString(),
				cwd: root,
				qorpera: { actor: "controller", attended: true },
			})}\n`,
			"utf-8",
		);
		const sessionManager = SessionManager.open(sessionPath, trailDir, root);
		const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager });
		await resourceLoader.reload();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			const hook = session.agent.beforeToolCall;
			expect(hook).toBeTruthy();
			const fakeContext = {
				assistantMessage: {} as never,
				toolCall: { type: "toolCall", id: "t1", name: "danger", arguments: { x: 1 } } as never,
				args: { x: 1 },
				context: {} as never,
			};
			const blocked = await hook!(fakeContext);
			expect(blocked?.block).toBe(true);
			expect(blocked?.reason).toContain("Authority gate");

			// Classified effects are stamped into the trail (EVOLUTION.md §9.1).
			const stamped = sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "qorpera_effect");
			expect(stamped.length).toBe(1);
			const stampData = (stamped[0] as { data: { effectClass: string; decision: string } }).data;
			expect(stampData.effectClass).toBe("irreversible");
			expect(stampData.decision).toBe("block");

			// The child can request a gate but cannot materialize or approve it.
			// Both actions are brokered by the desktop kernel.
			const gateId = blocked!.reason!.match(/gate-[a-f0-9-]+/)![0];
			expect(readdirSync(join(root, "inbox")).some((name) => name.startsWith(gateId))).toBe(false);
		} finally {
			session.dispose();
			if (previousKernelRequired === undefined) delete process.env.QORPERA_KERNEL_REQUIRED;
			else process.env.QORPERA_KERNEL_REQUIRED = previousKernelRequired;
			if (previousTrailToken === undefined) delete process.env.QORPERA_TRAIL_BROKER_TOKEN;
			else process.env.QORPERA_TRAIL_BROKER_TOKEN = previousTrailToken;
			if (previousKernelKey === undefined) delete process.env.QORPERA_KERNEL_PUBLIC_KEY;
			else process.env.QORPERA_KERNEL_PUBLIC_KEY = previousKernelKey;
			if (previousModelHandles === undefined) delete process.env.QORPERA_MODEL_BROKER_HANDLES;
			else process.env.QORPERA_MODEL_BROKER_HANDLES = previousModelHandles;
		}
	});
});

describe("project extension gating", () => {
	it("blocks project extensions until approval is proven by the live kernel", async () => {
		writeAuthorityToml(`[irreversible]\nmode = "gate"\n`);
		const authority = discoverAuthority(root)!;
		const agentDir = join(root, "agent-home");
		const extensionDir = join(root, ".qorpera", "extensions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(extensionDir, { recursive: true });
		const extensionPath = join(extensionDir, "hello.ts");
		writeFileSync(extensionPath, "export default () => {};", "utf-8");
		const userExtension = join(agentDir, "extensions", "global.ts");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(userExtension, "export default () => {};", "utf-8");

		// User-global extensions pass; project-local ones gate.
		const first = await filterExtensionPaths(authority, [extensionPath, userExtension], agentDir);
		expect(first.allowed).toEqual([userExtension]);
		expect(first.blocked.length).toBe(1);
		const gateId = first.blocked[0].gateId;

		// Pending: still blocked, no duplicate request.
		const second = await filterExtensionPaths(authority, [extensionPath], agentDir);
		expect(second.blocked[0].gateId).toBe(gateId);

		// File-only approval remains blocked without a signed kernel response.
		approveGate(gateId);
		expect((await filterExtensionPaths(authority, [extensionPath], agentDir)).blocked[0].gateId).toBe(gateId);

		// Changed content = new hash = new gate.
		writeFileSync(extensionPath, "export default () => { console.log('changed'); };", "utf-8");
		const afterChange = await filterExtensionPaths(authority, [extensionPath], agentDir);
		expect(afterChange.blocked.length).toBe(1);
		expect(afterChange.blocked[0].gateId).not.toBe(gateId);
	});
});
