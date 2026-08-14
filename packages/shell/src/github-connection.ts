import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface GitHubCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	unavailable: boolean;
	cancelled: boolean;
}

export type GitHubCommandRunner = (args: readonly string[], signal?: AbortSignal) => Promise<GitHubCommandResult>;

export interface GitHubCliStatus {
	available: boolean;
	connected: boolean;
	accountName: string;
	scopes: string[];
}

function appendOutput(parts: Buffer[], bytes: number, chunk: Buffer): number {
	const remaining = MAX_COMMAND_OUTPUT_BYTES - bytes;
	if (remaining <= 0) return bytes;
	parts.push(chunk.subarray(0, remaining));
	return bytes + Math.min(chunk.length, remaining);
}

export function runGitHubCommand(args: readonly string[], signal?: AbortSignal): Promise<GitHubCommandResult> {
	return new Promise((resolveResult) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		const finish = (result: GitHubCommandResult): void => {
			if (settled) return;
			settled = true;
			resolveResult(result);
		};
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn("gh", [...args], { signal, windowsHide: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			finish({
				code: null,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				unavailable: code === "ENOENT",
				cancelled: signal?.aborted ?? false,
			});
			return;
		}
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes = appendOutput(stdout, stdoutBytes, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes = appendOutput(stderr, stderrBytes, chunk);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish({
				code: null,
				stdout: Buffer.concat(stdout).toString("utf-8"),
				stderr: error.message,
				unavailable: error.code === "ENOENT",
				cancelled: signal?.aborted ?? error.name === "AbortError",
			});
		});
		child.on("close", (code) => {
			finish({
				code,
				stdout: Buffer.concat(stdout).toString("utf-8"),
				stderr: Buffer.concat(stderr).toString("utf-8"),
				unavailable: false,
				cancelled: signal?.aborted ?? false,
			});
		});
	});
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parseGitHubAuthStatus(raw: string): GitHubCliStatus {
	try {
		const parsed = recordValue(JSON.parse(raw));
		const hosts = recordValue(parsed?.hosts);
		const accounts = hosts?.["github.com"];
		if (!Array.isArray(accounts)) return { available: true, connected: false, accountName: "", scopes: [] };
		for (const candidate of accounts) {
			const account = recordValue(candidate);
			if (!account || account.state !== "success" || account.active !== true) continue;
			const login = typeof account.login === "string" ? account.login.trim() : "";
			const scopes =
				typeof account.scopes === "string"
					? account.scopes
							.split(",")
							.map((scope) => scope.trim())
							.filter(Boolean)
					: [];
			return { available: true, connected: true, accountName: login || "GitHub account", scopes };
		}
	} catch {
		// A malformed status response is treated as disconnected, never surfaced raw.
	}
	return { available: true, connected: false, accountName: "", scopes: [] };
}

export async function readGitHubCliStatus(
	run: GitHubCommandRunner = runGitHubCommand,
	signal?: AbortSignal,
): Promise<GitHubCliStatus> {
	const result = await run(["auth", "status", "--hostname", "github.com", "--json", "hosts"], signal);
	if (result.unavailable) return { available: false, connected: false, accountName: "", scopes: [] };
	if (!result.stdout.trim()) return { available: true, connected: false, accountName: "", scopes: [] };
	return parseGitHubAuthStatus(result.stdout);
}

function commandFailure(action: string, result: GitHubCommandResult): Error {
	if (result.cancelled) return new Error("GitHub connection cancelled");
	if (result.unavailable)
		return new Error("GitHub CLI is not installed. Install it from cli.github.com and try again.");
	const detail = result.stderr
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	return new Error(`${action} failed${detail ? `: ${detail.slice(0, 200)}` : ""}`);
}

export async function connectGitHubCli(options: {
	signal?: AbortSignal;
	report(message: string): void;
	run?: GitHubCommandRunner;
}): Promise<{ accountName: string; scopes: string[]; token: string }> {
	const run = options.run ?? runGitHubCommand;
	let status = await readGitHubCliStatus(run, options.signal);
	if (!status.available) throw commandFailure("GitHub connection", await run(["--version"], options.signal));
	if (!status.connected) {
		options.report("GitHub sign-in opened. The one-time code was copied to your clipboard.");
		const login = await run(
			[
				"auth",
				"login",
				"--hostname",
				"github.com",
				"--git-protocol",
				"https",
				"--web",
				"--clipboard",
				"--scopes",
				"repo,read:org,gist",
			],
			options.signal,
		);
		if (login.code !== 0) throw commandFailure("GitHub sign-in", login);
		status = await readGitHubCliStatus(run, options.signal);
		if (!status.connected) throw new Error("GitHub sign-in finished without an active github.com account");
	}
	options.report(`Connecting ${status.accountName}…`);
	const tokenResult = await run(["auth", "token", "--hostname", "github.com"], options.signal);
	if (tokenResult.code !== 0) throw commandFailure("Reading the GitHub credential", tokenResult);
	const token = tokenResult.stdout.trim();
	if (!token || /\s/u.test(token) || Buffer.byteLength(token, "utf-8") > 4096) {
		throw new Error("GitHub CLI returned an invalid credential");
	}
	return { accountName: status.accountName, scopes: status.scopes, token };
}
