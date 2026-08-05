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
	findGateRecords,
	readAuthorityConfig,
	requestHash,
} from "../src/core/authority.ts";
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

	it("allows the agent to author inbox messages (msg-*.md) but never gates", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		expect(
			evaluateToolCall(
				authority,
				"write",
				{ path: join(root, "inbox", "msg-pricing-question.md"), content: "?" },
				root,
			).kind,
		).toBe("allow");
		// Gate files, non-msg names, and nested paths stay protected.
		for (const path of [
			join(root, "inbox", "gate-abc.md"),
			join(root, "inbox", "notices.md"),
			join(root, "inbox", "sub", "msg-x.md"),
		]) {
			expect(evaluateToolCall(authority, "write", { path, content: "x" }, root).kind).toBe("block");
		}
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

describe("products zone", () => {
	it("gates modification of product paths but leaves reading and study free", () => {
		writeAuthorityToml(`[products]\nmode = "gate"\npaths = ["work/my-product"]\n\n[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		const productFile = join(root, "work", "my-product", "src", "main.ts");

		// Mutating tools gate as products.
		const write = evaluateToolCall(authority, "write", { path: productFile, content: "x" }, root);
		expect(write.kind).toBe("block");
		expect((write as { effectClass: string }).effectClass).toBe("products");
		expect(evaluateToolCall(authority, "edit", { path: productFile }, root).kind).toBe("block");
		expect(evaluateToolCall(authority, "apply_patch", { path: productFile }, root).kind).toBe("block");

		// Reading is free — study is the whole point.
		expect(evaluateToolCall(authority, "read", { path: productFile }, root).kind).toBe("allow");
		expect(evaluateToolCall(authority, "grep", { path: join(root, "work", "my-product") }, root).kind).toBe("allow");

		// Bash: study allowed, mutation gated (path or basename mention).
		expect(evaluateToolCall(authority, "bash", { command: "grep -r foo work/my-product" }, root).kind).toBe("allow");
		expect(
			evaluateToolCall(authority, "bash", { command: "sed -i s/a/b/ work/my-product/src/main.ts" }, root).kind,
		).toBe("block");
		expect(evaluateToolCall(authority, "bash", { command: "cd work/my-product && git commit -m x" }, root).kind).toBe(
			"block",
		);
	});

	it("does not gate study commands with harmless redirects (live conception regressions)", () => {
		writeAuthorityToml(`[products]\nmode = "gate"\npaths = ["work/my-product"]\n`);
		const authority = discoverAuthority(root)!;
		// The exact shapes that false-positived in the 2026-08-04 conception:
		for (const command of [
			`ls -la "work/my-product" && cat company.md 2>/dev/null; ls app inbox 2>/dev/null`,
			`cd "work/my-product" && ls docs 2>/dev/null | head -50; git log --oneline -10 2>/dev/null | head`,
			`cat authority.toml 2>/dev/null; ls trail 2>/dev/null`,
			`git -C work/my-product status 2>&1`,
		]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("allow");
		}
		// Real writes still gate — including through a null-redirect decoy.
		expect(evaluateToolCall(authority, "bash", { command: `echo x > authority.toml 2>/dev/null` }, root).kind).toBe(
			"block",
		);
		expect(
			evaluateToolCall(authority, "bash", { command: `cd work/my-product && git commit -m x 2>/dev/null` }, root)
				.kind,
		).toBe("block");
	});

	it("does not gate inbox READS via bash — writes there still gate (live remodel regressions)", () => {
		writeAuthorityToml(`[irreversible]\nmode = "auto"\n`);
		const authority = discoverAuthority(root)!;
		// The exact shapes that false-positived in the 2026-08-04 remodels:
		for (const command of [
			`cd C:/Companies/penthouse-poker; wc -l userland/index.html userland/renderer.js; cat inbox/README.md; ls inbox`,
			`cd C:/Companies/penthouse-poker; wc -l userland/index.html userland/renderer.js; head -50 inbox/README.md; cat authority.toml`,
			`cd C:/Companies/penthouse-poker; cat inbox/README.md`,
			`cat inbox/gate-36f00442.md`,
			`grep -l pending inbox/gate-abc.md`,
		]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("allow");
		}
		// Any write-ish touch of inbox/ stays gated — self-approval and
		// message-authoring alike (bash has no msg-*.md carve-out).
		for (const command of [
			`sed -i "s/pending/approved/" inbox/gate-abc.md`,
			`echo done >> inbox/msg-update.md`,
			`cp /tmp/gate.md inbox/gate-abc.md`,
			`rm inbox/gate-abc.md`,
			`cat inbox/gate-abc.md && touch inbox/gate-abc.md`,
		]) {
			expect(evaluateToolCall(authority, "bash", { command }, root).kind, command).toBe("block");
		}
	});

	it("zone checks rank above [tools] opt-outs", () => {
		writeAuthorityToml(
			`[products]\nmode = "gate"\npaths = ["work/my-product"]\n\n[tools]\nbash = "none"\nwrite = "none"\n`,
		);
		const authority = discoverAuthority(root)!;
		expect(
			evaluateToolCall(authority, "write", { path: join(root, "work", "my-product", "a.ts"), content: "x" }, root)
				.kind,
		).toBe("block");
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf work/my-product/dist" }, root).kind).toBe("block");
		// The opt-out still works outside the zone.
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf scratch" }, root).kind).toBe("allow");
	});

	it("notify mode on products proceeds with a notice", () => {
		writeAuthorityToml(`[products]\nmode = "notify"\npaths = ["work/my-product"]\n`);
		const authority = discoverAuthority(root)!;
		const decision = evaluateToolCall(
			authority,
			"write",
			{ path: join(root, "work", "my-product", "a.ts"), content: "x" },
			root,
		);
		expect(decision.kind).toBe("allow");
		expect(readFileSync(join(root, "inbox", "notices.md"), "utf-8")).toContain("[products]");
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

describe("the signature rule (behavior signatures, EVOLUTION.md §3)", () => {
	function writeBehaviorFile(content = "export default () => {};"): string {
		mkdirSync(join(root, "app", "tools"), { recursive: true });
		const path = join(root, "app", "tools", "mailer.ts");
		writeFileSync(path, content, "utf-8");
		return path;
	}

	it("gates unattended outward effects from unsigned code; a signature is durable for that exact content", () => {
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

		// Signed: durable — repeated calls and DIFFERENT actions from the same
		// content all pass (class mode auto governs from here).
		approveGate(gateId);
		const third = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect(third.kind).toBe("allow");
		expect(third.behavior?.signed).toBe(true);
		expect(evaluateToolCall(authority, "send_update", { to: "other" }, root, context).kind).toBe("allow");

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

	it("signature is necessary, not sufficient — per-action class gates still apply to signed code", () => {
		writeAuthorityToml(`[identity]\nmode = "gate"\n\n[tools]\nsend_update = "identity"\n`);
		const authority = discoverAuthority(root)!;
		const context = { attended: false, behaviorPath: writeBehaviorFile() };

		// Signature is checked first.
		const first = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect((first as { reason: string }).reason).toContain("Signature rule");
		approveGate((first as { gateId: string }).gateId);

		// Signed code still hits the per-action identity gate.
		const second = evaluateToolCall(authority, "send_update", { to: "list" }, root, context);
		expect(second.kind).toBe("block");
		expect((second as { reason: string }).reason).toContain("Authority gate [identity]");
	});

	it("inward classes do not require signatures", () => {
		writeAuthorityToml(`[products]\nmode = "notify"\npaths = ["work/my-product"]\n`);
		const authority = discoverAuthority(root)!;
		const context = { attended: false, behaviorPath: writeBehaviorFile() };
		const decision = evaluateToolCall(
			authority,
			"write",
			{ path: join(root, "work", "my-product", "a.ts"), content: "x" },
			root,
			context,
		);
		expect(decision.kind).toBe("allow");
		expect(readdirSync(join(root, "inbox")).every((name) => !name.startsWith("gate-"))).toBe(true);
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
		writeAuthorityToml(`[tools]\ndanger = "irreversible"\n\n[irreversible]\nmode = "gate"\n`);
		const agentDir = join(root, "agent-home");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.create(root, agentDir);
		const sessionManager = SessionManager.inMemory();
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

			const gateId = blocked!.reason!.match(/gate-[a-f0-9-]+/)![0];
			approveGate(gateId);
			const allowed = await hook!(fakeContext);
			expect(allowed?.block).not.toBe(true);
		} finally {
			session.dispose();
		}
	});
});

describe("project extension gating", () => {
	it("blocks unapproved project extensions, loads them after durable approval, re-gates on content change", () => {
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
		const first = filterExtensionPaths(authority, [extensionPath, userExtension], agentDir);
		expect(first.allowed).toEqual([userExtension]);
		expect(first.blocked.length).toBe(1);
		const gateId = first.blocked[0].gateId;

		// Pending: still blocked, no duplicate request.
		const second = filterExtensionPaths(authority, [extensionPath], agentDir);
		expect(second.blocked[0].gateId).toBe(gateId);

		// Approval is durable per content hash: allowed repeatedly.
		approveGate(gateId);
		expect(filterExtensionPaths(authority, [extensionPath], agentDir).allowed).toEqual([extensionPath]);
		expect(filterExtensionPaths(authority, [extensionPath], agentDir).allowed).toEqual([extensionPath]);

		// Changed content = new hash = new gate.
		writeFileSync(extensionPath, "export default () => { console.log('changed'); };", "utf-8");
		const afterChange = filterExtensionPaths(authority, [extensionPath], agentDir);
		expect(afterChange.blocked.length).toBe(1);
		expect(afterChange.blocked[0].gateId).not.toBe(gateId);
	});
});
