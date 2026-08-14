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
			QORPERA_AUTONOMOUS: "1",
			Qorpera_Autonomous: "1",
			Electron_Run_As_Node: "0",
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
			PATH: environment.PATH,
			HOME: environment.HOME,
			USERPROFILE: environment.USERPROFILE,
			APPDATA: environment.APPDATA,
			GH_TOKEN: environment.GH_TOKEN,
			AWS_PROFILE: environment.AWS_PROFILE,
			CUSTOM_HOST_CAPABILITY: environment.CUSTOM_HOST_CAPABILITY,
			ELECTRON_RUN_AS_NODE: "1",
		});
		expect(invocation.env.QORPERA_AUTONOMOUS).toBeUndefined();
		expect(Object.keys(invocation.env).some((name) => name.toLowerCase() === "qorpera_autonomous")).toBe(false);
		expect(Object.keys(invocation.env).filter((name) => name.toLowerCase() === "electron_run_as_node")).toEqual([
			"ELECTRON_RUN_AS_NODE",
		]);
		expect(invocation.env).not.toBe(environment);
	});
});
