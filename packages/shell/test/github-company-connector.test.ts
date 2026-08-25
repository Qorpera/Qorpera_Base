import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { readCompanyConnectorManifests } from "@qorpera/pi-coding-agent/company-connectors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILT_IN_GITHUB_CONNECTOR_ID,
	builtInGitHubNativeGrantMatches,
	ensureBuiltInGitHubConnector,
	GITHUB_CONNECTION_DESTINATIONS,
} from "../src/github-company-connector.ts";

const OWNER_AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("built-in GitHub company connector", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "qorpera-github-connector-"));
		scaffoldCompany(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("materializes one portable read operation without a credential value", () => {
		const installed = ensureBuiltInGitHubConnector(root, OWNER_AGENT_ID);

		expect(installed.created).toBe(true);
		expect(installed.connector).toMatchObject({
			id: BUILT_IN_GITHUB_CONNECTOR_ID,
			displayName: "GitHub",
			ownerAgentId: OWNER_AGENT_ID,
			authentication: { kind: "api-key", secretName: "github" },
			operations: [{ id: "api.get", access: "read" }],
			implementation: { kind: "company-tool", entry: "index.js" },
		});
		const source = readFileSync(join(root, "connectors", BUILT_IN_GITHUB_CONNECTOR_ID, "index.js"), "utf-8");
		expect(source).toContain("secret://github");
		expect(source).toContain('require("node:crypto")');
		expect(source).toContain("process.exit(0)");
		expect(source).not.toMatch(/gho_[a-z0-9]/iu);
		expect(readCompanyConnectorManifests(root)).toHaveLength(1);
		expect(ensureBuiltInGitHubConnector(root, OWNER_AGENT_ID).created).toBe(false);
	});

	it("exits after returning one broker response even when stdin remains open", async () => {
		ensureBuiltInGitHubConnector(root, OWNER_AGENT_ID);
		const program = join(root, "connectors", BUILT_IN_GITHUB_CONNECTOR_ID, "index.js");
		const child = spawn(
			process.execPath,
			[program, "api.get", JSON.stringify({ path: "/repos/Qorpera/Qorpera_Base" })],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const request = await new Promise<{ requestId: string }>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Connector did not emit an HTTP request")), 2_000);
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				const lineEnd = stdout.indexOf("\n");
				if (lineEnd < 0) return;
				clearTimeout(timeout);
				try {
					const parsed = JSON.parse(stdout.slice(0, lineEnd)) as { requestId?: unknown };
					if (typeof parsed.requestId !== "string") throw new Error("Request id is missing");
					resolve({ requestId: parsed.requestId });
				} catch (error) {
					reject(error);
				}
			});
			child.once("error", reject);
		});
		const responseBody = JSON.stringify({ full_name: "Qorpera/Qorpera_Base" });
		child.stdin.write(
			`${JSON.stringify({
				type: "qorpera_program_http_response",
				requestId: request.requestId,
				status: 200,
				body: responseBody,
			})}\n`,
		);

		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill();
				reject(new Error("Connector did not exit after returning its response"));
			}, 2_000);
			child.once("close", (code, signal) => {
				clearTimeout(timeout);
				resolve({ code, signal });
			});
		});

		expect(result).toEqual({ code: 0, signal: null });
		expect(stderr).toBe("");
		expect(stdout.slice(stdout.indexOf("\n") + 1)).toBe(responseBody);
	});

	it("recognizes only the exact native GitHub connection grant", () => {
		const { connector } = ensureBuiltInGitHubConnector(root, OWNER_AGENT_ID);
		const request = {
			status: "connected",
			grantId: "github-native",
			recipeId: "github",
			displayName: "GitHub",
			destinations: GITHUB_CONNECTION_DESTINATIONS.map(([host]) => ({ host })),
			secretNames: ["github"],
		};

		expect(builtInGitHubNativeGrantMatches(connector, request)).toBe(true);
		expect(builtInGitHubNativeGrantMatches(connector, { ...request, grantId: "other" })).toBe(false);
		expect(
			builtInGitHubNativeGrantMatches(connector, {
				...request,
				destinations: [{ host: "api.github.com" }],
			}),
		).toBe(false);
	});
});
