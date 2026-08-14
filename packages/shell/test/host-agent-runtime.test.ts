import { describe, expect, it } from "vitest";
import { createHostAgentProcess } from "../src/host-agent-runtime.ts";

describe("host-capable agent runtime", () => {
	it("runs the RPC child in its company scope with the complete user environment", () => {
		const environment = {
			PATH: "C:\\tools",
			HOME: "C:\\Users\\founder",
			USERPROFILE: "C:\\Users\\founder",
			APPDATA: "C:\\Users\\founder\\AppData\\Roaming",
			GH_TOKEN: "github-credential",
			AWS_PROFILE: "production",
			CUSTOM_HOST_CAPABILITY: "available",
		};
		const invocation = createHostAgentProcess({
			nodeExecutable: "Qorpera Base.exe",
			rpcEntry: "rpc-entry.js",
			args: ["--mode", "rpc", "--session", "trail/session.jsonl"],
			cwd: "C:\\Companies\\Acme",
			environment,
		});

		expect(invocation).toMatchObject({
			command: "Qorpera Base.exe",
			args: ["rpc-entry.js", "--mode", "rpc", "--session", "trail/session.jsonl"],
			cwd: "C:\\Companies\\Acme",
		});
		expect(invocation.env).toMatchObject({
			...environment,
			ELECTRON_RUN_AS_NODE: "1",
		});
		expect(invocation.env).not.toBe(environment);
	});
});
