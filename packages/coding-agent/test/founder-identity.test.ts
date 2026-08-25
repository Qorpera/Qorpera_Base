/**
 * Cryptographic founder identity (manifesto §3.1, invariant 15): keypair
 * lifecycle, policy ratification and verification, public-only records,
 * and the authority layer's fail-closed enforcement.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import { scaffoldCompany } from "../src/core/company.ts";
import {
	FOUNDER_PUBLIC_FILE,
	founderPublicRecord,
	generateFounderIdentity,
	readFounderIdentity,
	signAuthorityPolicy,
	signGateApproval,
	verifyAuthorityPolicy,
} from "../src/core/founder-identity.ts";

let base: string;
let root: string;
let prevAgentDir: string | undefined;

function useAgentDir(name: string): void {
	process.env.QORPERA_CODING_AGENT_DIR = join(base, name);
}

beforeEach(() => {
	base = join(realpathSync(tmpdir()), `qorpera-founder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	root = join(base, "company");
	prevAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
	useAgentDir("agent-a");
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
	else process.env.QORPERA_CODING_AGENT_DIR = prevAgentDir;
	if (existsSync(base)) rmSync(base, { recursive: true, force: true });
});

describe("founder identity lifecycle", () => {
	it("generates once, reads back, and refuses a second identity", () => {
		expect(readFounderIdentity()).toBeUndefined();
		const identity = generateFounderIdentity("Jonas");
		expect(identity.publicKeyPem).toContain("PUBLIC KEY");
		expect(identity.privateKeyPem).toContain("PRIVATE KEY");
		expect(readFounderIdentity()?.name).toBe("Jonas");
		expect(() => generateFounderIdentity()).toThrow(/already exists/);
	});

	it("exposes the public key only", () => {
		generateFounderIdentity();
		const record = founderPublicRecord();
		expect(record).toBeDefined();
		expect(record).toContain("PUBLIC KEY");
		expect(record).not.toContain("PRIVATE KEY");
	});
});

describe("policy ratification and verification", () => {
	it("signs policy, verifies it, and detects tampering and un-ratified edits", () => {
		generateFounderIdentity();
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "gate"\n`, "utf-8");
		signAuthorityPolicy(root);
		expect(verifyAuthorityPolicy(root)).toBe("valid");

		// Any edit invalidates the ratification until the founder re-signs.
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "auto"\n`, "utf-8");
		expect(verifyAuthorityPolicy(root)).toBe("invalid");
		signAuthorityPolicy(root);
		expect(verifyAuthorityPolicy(root)).toBe("valid");

		// A missing sidecar is unsigned, not broken.
		rmSync(join(root, ".qorpera", "authority.sig.json"));
		expect(verifyAuthorityPolicy(root)).toBe("unsigned");
	});

	it("rejects policy signed by a DIFFERENT founder", () => {
		generateFounderIdentity();
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "gate"\n`, "utf-8");
		signAuthorityPolicy(root);
		expect(verifyAuthorityPolicy(root)).toBe("valid");
		// The company lands on a machine with another founder identity: the
		// old ratification carries no authority there.
		useAgentDir("agent-b");
		generateFounderIdentity("Someone Else");
		expect(verifyAuthorityPolicy(root)).toBe("invalid");
	});

	it("verifies with the public-only record (sandbox context)", () => {
		generateFounderIdentity();
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "gate"\n`, "utf-8");
		signAuthorityPolicy(root);
		const publicRecord = founderPublicRecord()!;
		useAgentDir("agent-sandbox");
		mkdirSync(join(base, "agent-sandbox"), { recursive: true });
		writeFileSync(join(base, "agent-sandbox", FOUNDER_PUBLIC_FILE), publicRecord, "utf-8");
		expect(readFounderIdentity()?.privateKeyPem).toBeUndefined();
		expect(verifyAuthorityPolicy(root)).toBe("valid");
		expect(() => signAuthorityPolicy(root)).toThrow(/requires the founder identity/);
	});

	it("reports no-identity on machines without a founder key (legacy semantics)", () => {
		scaffoldCompany(root);
		expect(verifyAuthorityPolicy(root)).toBe("no-identity");
	});

	it("a corrupt identity file keeps enforcement ON — never fails open to legacy", () => {
		generateFounderIdentity();
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "gate"\n`, "utf-8");
		signAuthorityPolicy(root);
		expect(verifyAuthorityPolicy(root)).toBe("valid");
		// The key file is damaged: verification must degrade to all-gate
		// ("invalid"), not to permissive no-identity semantics.
		writeFileSync(join(join(base, "agent-a"), "founder-identity.json"), "not json at all", "utf-8");
		expect(verifyAuthorityPolicy(root)).toBe("invalid");
		const authority = discoverAuthority(root)!;
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "auto"\n`, "utf-8");
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf build" }, root).kind).toBe("block");
	});
});

describe("authority enforcement", () => {
	it("unratified policy grants NO auto modes: everything gates until the founder ratifies", () => {
		generateFounderIdentity();
		scaffoldCompany(root);
		// An agent-style edit widens the policy without ratification…
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "auto"\n`, "utf-8");
		const authority = discoverAuthority(root)!;
		const widened = evaluateToolCall(authority, "bash", { command: "rm -rf build" }, root);
		// …and buys nothing: unverified policy is the all-gate fallback.
		expect(widened.kind).toBe("block");

		signAuthorityPolicy(root);
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf build" }, root).kind).toBe("allow");
	});

	it("keeps legacy behavior when no founder identity exists", () => {
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "auto"\n`, "utf-8");
		const authority = discoverAuthority(root)!;
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf build" }, root).kind).toBe("allow");
	});
});

describe("signed gate approvals", () => {
	function fileGateFor(command: string): { gateId: string; gatePath: string } {
		const authority = discoverAuthority(root)!;
		const blocked = evaluateToolCall(authority, "bash", { command }, root);
		expect(blocked.kind).toBe("block");
		const gateId = (blocked as { gateId: string }).gateId;
		return { gateId, gatePath: join(root, "inbox", `${gateId}.md`) };
	}

	it("with a founder identity, a bare status edit is data — only a signed approval is authority", () => {
		generateFounderIdentity();
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "gate"\n`, "utf-8");
		signAuthorityPolicy(root);
		const command = "rm -rf build";
		const { gateId, gatePath } = fileGateFor(command);
		const authority = discoverAuthority(root)!;

		// The legacy hand-edit: status flipped, no signature. Not authority.
		writeFileSync(gatePath, readFileSync(gatePath, "utf-8").replace(/^status:.*$/m, "status: approved"), "utf-8");
		expect(evaluateToolCall(authority, "bash", { command }, root).kind).toBe("block");

		// A garbage signature is not authority either.
		writeFileSync(
			gatePath,
			readFileSync(gatePath, "utf-8").replace(
				/^hash:.*$/m,
				(line) => `${line}\napproval: ${Buffer.from("forged").toString("base64")}`,
			),
			"utf-8",
		);
		expect(evaluateToolCall(authority, "bash", { command }, root).kind).toBe("block");

		// The founder's real signature over (id, hash) is.
		const content = readFileSync(gatePath, "utf-8").replace(/^approval:.*\r?\n?/m, "");
		const hash = content.match(/^hash:\s*([a-f0-9]{64})/m)![1];
		writeFileSync(
			gatePath,
			content.replace(/^hash:.*$/m, (line) => `${line}\napproval: ${signGateApproval(gateId, hash)}`),
			"utf-8",
		);
		expect(evaluateToolCall(authority, "bash", { command }, root).kind).toBe("allow");
	});

	it("without a founder identity, status-edit approvals keep working (legacy)", () => {
		scaffoldCompany(root);
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "gate"\n`, "utf-8");
		const command = "rm -rf build";
		const { gatePath } = fileGateFor(command);
		writeFileSync(gatePath, readFileSync(gatePath, "utf-8").replace(/^status:.*$/m, "status: approved"), "utf-8");
		expect(evaluateToolCall(discoverAuthority(root)!, "bash", { command }, root).kind).toBe("allow");
	});
});
