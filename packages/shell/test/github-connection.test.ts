import { describe, expect, it, vi } from "vitest";
import {
	connectGitHubCli,
	type GitHubCommandResult,
	parseGitHubAuthStatus,
	readGitHubCliStatus,
} from "../src/github-connection.ts";

function result(overrides: Partial<GitHubCommandResult> = {}): GitHubCommandResult {
	return {
		code: 0,
		stdout: "",
		stderr: "",
		unavailable: false,
		cancelled: false,
		...overrides,
	};
}

const CONNECTED_STATUS = JSON.stringify({
	hosts: {
		"github.com": [
			{
				state: "success",
				active: true,
				host: "github.com",
				login: "Qorpera",
				scopes: "gist, read:org, repo",
			},
		],
	},
});

describe("GitHub connection", () => {
	it("parses only the active successful github.com account", () => {
		expect(parseGitHubAuthStatus(CONNECTED_STATUS)).toEqual({
			available: true,
			connected: true,
			accountName: "Qorpera",
			scopes: ["gist", "read:org", "repo"],
		});
		expect(parseGitHubAuthStatus('{"hosts":{"github.com":[]}}')).toMatchObject({ connected: false });
		expect(parseGitHubAuthStatus("not-json")).toMatchObject({ connected: false });
	});

	it("reports GitHub CLI availability without leaking command errors", async () => {
		const unavailable = vi.fn(async () => result({ code: null, unavailable: true, stderr: "spawn ENOENT" }));
		await expect(readGitHubCliStatus(unavailable)).resolves.toEqual({
			available: false,
			connected: false,
			accountName: "",
			scopes: [],
		});
	});

	it("uses an existing account and returns its credential only to the kernel caller", async () => {
		const run = vi.fn(async (args: readonly string[]) => {
			if (args[1] === "status") return result({ stdout: CONNECTED_STATUS });
			if (args[1] === "token") return result({ stdout: "gho_kernel_only\n" });
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		});
		const report = vi.fn();
		await expect(connectGitHubCli({ report, run })).resolves.toEqual({
			accountName: "Qorpera",
			scopes: ["gist", "read:org", "repo"],
			token: "gho_kernel_only",
		});
		expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(["login"]), undefined);
		expect(report).toHaveBeenCalledWith("Connecting Qorpera…");
	});

	it("runs the browser login before reading a newly connected credential", async () => {
		let statusReads = 0;
		const run = vi.fn(async (args: readonly string[]) => {
			if (args[1] === "status") {
				statusReads += 1;
				return result({ stdout: statusReads === 1 ? '{"hosts":{"github.com":[]}}' : CONNECTED_STATUS });
			}
			if (args[1] === "login") return result();
			if (args[1] === "token") return result({ stdout: "github-token" });
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		});
		const report = vi.fn();
		await expect(connectGitHubCli({ report, run })).resolves.toMatchObject({ accountName: "Qorpera" });
		expect(run).toHaveBeenCalledWith(
			expect.arrayContaining(["login", "--web", "--clipboard", "--scopes", "repo,read:org,gist"]),
			undefined,
		);
		expect(report).toHaveBeenCalledWith("GitHub sign-in opened. The one-time code was copied to your clipboard.");
	});
});
