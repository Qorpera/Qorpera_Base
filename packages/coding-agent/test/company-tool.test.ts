/**
 * The company-tool runner (Build 2): clean-environment execution of
 * company-authored programs with behavior identity, and its wiring into the
 * signature rule (EVOLUTION.md §3) via the authority layer.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPANY_TOOL_NAME, discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import { scaffoldCompany } from "../src/core/company.ts";
import { handleHttpBrokerFrame, setHttpBrokerWriter } from "../src/core/http-broker-client.ts";
import { createCompanyToolDefinition } from "../src/core/tools/company-tool.ts";

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-company-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	scaffoldCompany(root);
});

afterEach(() => {
	if (root && existsSync(root)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeProgram(relativePath: string, source: string): string {
	const target = join(root, relativePath);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, source, "utf-8");
	return target;
}

async function run(input: { path: string; args?: string[]; timeoutSeconds?: number }) {
	const definition = createCompanyToolDefinition(root);
	const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
	return (await execute("test-call", input)) as {
		content: Array<{ type: string; text?: string }>;
		details?: {
			behaviorPath: string;
			contentHash: string;
			exitCode: number | null;
			durationMs: number;
			timedOut?: true;
			truncated?: true;
		};
	};
}

describe("run_company_tool execution", () => {
	it("runs a company program with the company root as cwd and records code identity", async () => {
		const source = `import { writeFileSync } from "node:fs";\nwriteFileSync("departments/from-tool.txt", "made by tool\\n");\nconsole.log("hello from tool in", process.cwd());\n`;
		const absolute = writeProgram(join("app", "tools", "hello.mjs"), source);

		const result = await run({ path: "app/tools/hello.mjs" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("exit 0");
		expect(text).toContain("hello from tool in");
		// cwd is the company root, so the relative write landed inside it.
		expect(readFileSync(join(root, "departments", "from-tool.txt"), "utf-8")).toContain("made by tool");
		// Acting code identity: root-relative POSIX path + content sha256.
		expect(result.details?.behaviorPath).toBe("app/tools/hello.mjs");
		expect(result.details?.contentHash).toBe(createHash("sha256").update(readFileSync(absolute)).digest("hex"));
		expect(result.details?.exitCode).toBe(0);
	});

	it("starts programs with a clean environment: no ambient credentials or kernel state", async () => {
		process.env.FAKE_PROVIDER_API_KEY = "super-secret";
		process.env.QORPERA_TEST_KERNEL_STATE = "kernel-internal";
		try {
			writeProgram(join("app", "tools", "env.mjs"), "console.log(JSON.stringify(process.env));\n");
			const result = await run({ path: "app/tools/env.mjs" });
			const text = result.content[0]?.text ?? "";
			const jsonLine = text.split("\n").find((line) => line.startsWith("{"));
			expect(jsonLine).toBeDefined();
			const env = JSON.parse(jsonLine as string) as Record<string, string>;
			expect(env.FAKE_PROVIDER_API_KEY).toBeUndefined();
			expect(env.QORPERA_TEST_KERNEL_STATE).toBeUndefined();
			expect(Object.keys(env).some((name) => name.toUpperCase() === "PATH")).toBe(true);
		} finally {
			delete process.env.FAKE_PROVIDER_API_KEY;
			delete process.env.QORPERA_TEST_KERNEL_STATE;
		}
	});

	it("runs TypeScript programs through the bundled loader", async () => {
		writeProgram(join("app", "tools", "typed.ts"), `const x: number = 41;\nconsole.log("answer", x + 1);\n`);
		const result = await run({ path: "app/tools/typed.ts" });
		expect(result.content[0]?.text).toContain("answer 42");
		expect(result.details?.exitCode).toBe(0);
	});

	it("refuses programs outside the company folder", async () => {
		const outside = join(root, "..", `outside-${Date.now()}.mjs`);
		writeFileSync(outside, "console.log('outside');\n", "utf-8");
		try {
			await expect(run({ path: outside })).rejects.toThrow(/inside the company folder/);
		} finally {
			rmSync(outside, { force: true });
		}
	});

	it("refuses missing programs", async () => {
		await expect(run({ path: "app/tools/never-written.mjs" })).rejects.toThrow(/Program not found/);
	});

	it("terminates programs at the timeout and reports it", async () => {
		writeProgram(join("app", "tools", "hang.mjs"), "setInterval(() => {}, 1000);\nconsole.log('started');\n");
		const result = await run({ path: "app/tools/hang.mjs", timeoutSeconds: 1 });
		expect(result.details?.timedOut).toBe(true);
		expect(result.content[0]?.text).toContain("terminated after 1s timeout");
	}, 20000);
});

describe("run_company_tool authority wiring (signature rule)", () => {
	it("stamps behavior identity on auto-class runs", () => {
		const absolute = writeProgram(join("app", "tools", "report.mjs"), "console.log('report');\n");
		const authority = discoverAuthority(root);
		expect(authority).toBeDefined();
		const decision = evaluateToolCall(authority!, COMPANY_TOOL_NAME, { path: "app/tools/report.mjs" }, root, {
			attended: false,
		});
		expect(decision.kind).toBe("allow");
		expect(decision.kind === "allow" && decision.behavior?.path).toBe("app/tools/report.mjs");
		expect(decision.kind === "allow" && decision.behavior?.contentHash).toBe(
			createHash("sha256").update(readFileSync(absolute)).digest("hex"),
		);
	});

	it("unattended outward classification triggers the signature rule on the PROGRAM's content", () => {
		writeProgram(join("app", "tools", "outreach.mjs"), "console.log('send');\n");
		writeFileSync(
			join(root, "authority.toml"),
			`[identity]\nmode = "gate"\n\n[tools]\n${COMPANY_TOOL_NAME} = "identity"\n`,
			"utf-8",
		);
		const authority = discoverAuthority(root)!;
		const args = { path: "app/tools/outreach.mjs" };

		const blocked = evaluateToolCall(authority, COMPANY_TOOL_NAME, args, root, { attended: false });
		expect(blocked.kind).toBe("block");
		expect(blocked.kind === "block" && blocked.reason).toMatch(/Signature rule \[identity\]/);
		expect(blocked.kind === "block" && blocked.behavior?.path).toBe("app/tools/outreach.mjs");
		// A signature request was filed against the program's content hash.
		const gateFiles = readdirSync(join(root, "inbox")).filter((name) => name.startsWith("gate-"));
		expect(gateFiles.length).toBe(1);
		expect(readFileSync(join(root, "inbox", gateFiles[0]), "utf-8")).toContain("behavior_signature");

		// Founder signs the code: signature passes, but the per-action class
		// gate still applies — the signature is necessary, not sufficient.
		const gatePath = join(root, "inbox", gateFiles[0]);
		writeFileSync(gatePath, readFileSync(gatePath, "utf-8").replace(/^status:.*$/m, "status: approved"), "utf-8");
		const signed = evaluateToolCall(authority, COMPANY_TOOL_NAME, args, root, { attended: false });
		expect(signed.kind).toBe("block");
		expect(signed.kind === "block" && signed.reason).toMatch(/Authority gate \[identity\]/);

		// Editing the program invalidates the signature: new content, new request.
		writeProgram(join("app", "tools", "outreach.mjs"), "console.log('send v2');\n");
		const edited = evaluateToolCall(authority, COMPANY_TOOL_NAME, args, root, { attended: false });
		expect(edited.kind).toBe("block");
		expect(edited.kind === "block" && edited.reason).toMatch(/Signature rule \[identity\]/);
	});

	it("attended calls skip the signature rule and hit the ordinary class gate", () => {
		writeProgram(join("app", "tools", "outreach.mjs"), "console.log('send');\n");
		writeFileSync(
			join(root, "authority.toml"),
			`[identity]\nmode = "gate"\n\n[tools]\n${COMPANY_TOOL_NAME} = "identity"\n`,
			"utf-8",
		);
		const authority = discoverAuthority(root)!;
		const decision = evaluateToolCall(authority, COMPANY_TOOL_NAME, { path: "app/tools/outreach.mjs" }, root, {
			attended: true,
		});
		expect(decision.kind).toBe("block");
		expect(decision.kind === "block" && decision.reason).toMatch(/Authority gate \[identity\]/);
	});
});

const LANE_PROGRAM = `import { createInterface } from "node:readline";
process.stdout.write('{"type":"qorpera_program_http_request","requestId":"r1","method":"GET","url":"https://api.test.example/data"}' + String.fromCharCode(10));
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.error) console.log("LANE ERROR: " + message.error);
	else console.log("LANE OK " + message.status + " " + message.body);
	process.exit(0);
});
`;

describe("program-side http lane", () => {
	it("forwards program requests through the kernel lane with the program's identity attached", async () => {
		const absolute = writeProgram(join("app", "tools", "reporter.mjs"), LANE_PROGRAM);
		writeFileSync(join(root, "authority.toml"), `[tools]\nhttp_request = "none"\n`, "utf-8");
		const captured: Array<Record<string, unknown>> = [];
		setHttpBrokerWriter((frame) => {
			const record = frame as Record<string, unknown>;
			captured.push(record);
			// Fake kernel: answer the child->kernel frame immediately.
			handleHttpBrokerFrame({
				type: "qorpera_http_response",
				requestId: record.requestId,
				status: 200,
				headers: { "content-type": "text/plain" },
				body: "kernel-data",
				bodyBytes: 11,
			});
		});

		const result = await run({ path: "app/tools/reporter.mjs" });
		expect(result.content[0]?.text).toContain("LANE OK 200 kernel-data");
		expect(captured.length).toBe(1);
		const behavior = captured[0].behavior as { path: string; contentHash: string };
		expect(behavior.path).toBe("app/tools/reporter.mjs");
		expect(behavior.contentHash).toBe(createHash("sha256").update(readFileSync(absolute)).digest("hex"));
	});

	it("applies the signature rule to program requests: unsigned outward-classed code is refused with a filed request", async () => {
		writeProgram(join("app", "tools", "reporter.mjs"), LANE_PROGRAM);
		// notify mode: once the program is SIGNED this would auto-proceed with a
		// notice — the per-request block below is purely the missing signature.
		// (Completing the signed path needs the live desktop kernel's durable
		// trust; that half is kernel-integration territory.)
		writeFileSync(
			join(root, "authority.toml"),
			`[identity]\nmode = "notify"\n\n[tools]\nhttp_request = "identity"\n`,
			"utf-8",
		);
		const captured: Array<Record<string, unknown>> = [];
		setHttpBrokerWriter((frame) => captured.push(frame as Record<string, unknown>));

		const result = await run({ path: "app/tools/reporter.mjs" });
		expect(result.content[0]?.text).toContain("LANE ERROR");
		expect(result.content[0]?.text).toContain("Signature rule [identity]");
		expect(captured.length).toBe(0);
		const gateFiles = readdirSync(join(root, "inbox")).filter((name) => name.startsWith("gate-"));
		expect(gateFiles.length).toBe(1);
		expect(readFileSync(join(root, "inbox", gateFiles[0]), "utf-8")).toContain("behavior_signature");
	});
});
