import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodeGitHttpServer,
	extractGitAuthToken,
	parseGitHttpRoute,
	parseReceivePackCommands,
} from "../src/code-git-http.ts";
import { type CodeHostJob, startCodeArea } from "../src/code-host-jobs.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const execFileAsync = promisify(execFile);

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ENV_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";
const WRITE_TOKEN = "qgit_write_token_0123456789abcdef";
const READ_TOKEN = "qgit_read_token_0123456789abcdef0";
const REPO = { host: "qorpera" as const, owner: "acme", name: "app", baseBranch: "main" };

async function resolveGitPath(): Promise<string> {
	const { stdout } = await execFileAsync("which", ["git"]);
	return stdout.trim();
}

describe("code-git-http helpers", () => {
	it("extracts bearer and basic git auth tokens", () => {
		expect(extractGitAuthToken(`Bearer ${WRITE_TOKEN}`)).toBe(WRITE_TOKEN);
		const basicPass = Buffer.from(`qorpera:${WRITE_TOKEN}`, "utf8").toString("base64");
		expect(extractGitAuthToken(`Basic ${basicPass}`)).toBe(WRITE_TOKEN);
		const basicUser = Buffer.from(`${READ_TOKEN}:`, "utf8").toString("base64");
		expect(extractGitAuthToken(`Basic ${basicUser}`)).toBe(READ_TOKEN);
		expect(extractGitAuthToken("Basic invalid")).toBeNull();
		expect(extractGitAuthToken(undefined)).toBeNull();
	});

	it("parses valid smart-git routes and rejects malformed paths", () => {
		expect(parseGitHttpRoute("GET", `/git/${COMPANY_ID}/acme/app.git/info/refs?service=git-upload-pack`)).toEqual({
			companyId: COMPANY_ID,
			owner: "acme",
			name: "app",
			endpoint: "info/refs",
			service: "git-upload-pack",
		});
		expect(parseGitHttpRoute("POST", `/git/${COMPANY_ID}/acme/app/git-receive-pack`)).toEqual({
			companyId: COMPANY_ID,
			owner: "acme",
			name: "app",
			endpoint: "git-receive-pack",
			service: "git-receive-pack",
		});
		expect(parseGitHttpRoute("GET", `/git/${COMPANY_ID}/acme/app.git/info/refs?service=bad`)).toBeNull();
		expect(parseGitHttpRoute("GET", "/git/not-uuid/acme/app.git/info/refs?service=git-upload-pack")).toBeNull();
	});

	it("parses receive-pack pkt-line commands", () => {
		const oldSha = "0".repeat(40);
		const newSha = "a".repeat(40);
		const cmd = `${oldSha} ${newSha} refs/heads/main\0report-status\n`;
		const len = (Buffer.byteLength(cmd) + 4).toString(16).padStart(4, "0");
		const buf = Buffer.from(`${len}${cmd}0000`, "utf8");
		expect(parseReceivePackCommands(buf)).toEqual([{ oldSha, newSha, refName: "refs/heads/main" }]);
	});
});

describe("CodeGitHttpServer end-to-end git clone and push", () => {
	const tempDirs: string[] = [];
	let server: CodeGitHttpServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.close();
			server = undefined;
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("serves git clone, blocks read-only push, allows write push, updates main worktree, and records push", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-git-http-")));
		tempDirs.push(root);
		const companyRoot = join(root, "company");
		const scratchRoot = join(root, "scratch");
		await mkdir(companyRoot, { recursive: true });
		await mkdir(scratchRoot, { recursive: true });
		const gitBin = await resolveGitPath();
		const shell = localShell([]);
		const layout = { companyRoot, scratchRoot, git: gitBin };

		const started = await startCodeArea(
			{ shell, layout, signal: new AbortController().signal },
			{ repository: REPO },
		);
		expect(started.state).toBe("started");

		const writeSha = createHash("sha256").update(WRITE_TOKEN).digest("hex");
		const readSha = createHash("sha256").update(READ_TOKEN).digest("hex");
		const recordedPushes: Record<string, unknown>[] = [];

		server = new CodeGitHttpServer({
			host: "127.0.0.1",
			port: 0,
			control: {
				async call(method, args) {
					if (method === "qorpera_verify_code_git_token") {
						const tokenHash = args.p_token_sha256;
						const op = args.p_operation;
						if (tokenHash === writeSha) {
							return {
								allowed: true,
								tokenId: TOKEN_ID,
								companyId: COMPANY_ID,
								environmentId: ENV_ID,
								owner: "acme",
								name: "app",
								defaultBranch: "main",
							};
						}
						if (tokenHash === readSha && op === "read") {
							return {
								allowed: true,
								tokenId: TOKEN_ID,
								companyId: COMPANY_ID,
								environmentId: ENV_ID,
								owner: "acme",
								name: "app",
								defaultBranch: "main",
							};
						}
						throw new Error("UNAUTHORIZED");
					}
					if (method === "qorpera_record_git_http_push") {
						recordedPushes.push(args);
						return { recorded: true, changeNumber: 1, mainAfter: args.p_main_after };
					}
					throw new Error(`Unexpected RPC ${method}`);
				},
			},
			hosts: {
				async run<T>(
					_companyId: string,
					_envId: string,
					signal: AbortSignal,
					fn: (job: CodeHostJob, gc: never) => Promise<T>,
				): Promise<T> {
					return await fn({ shell, layout, signal }, undefined as never);
				},
			},
		});

		const addr = await server.start();
		const readUrl = `http://qorpera:${READ_TOKEN}@127.0.0.1:${addr.port}/git/${COMPANY_ID}/acme/app.git`;
		const writeUrl = `http://qorpera:${WRITE_TOKEN}@127.0.0.1:${addr.port}/git/${COMPANY_ID}/acme/app.git`;
		const cloneDir = join(root, "clone");

		await execFileAsync(gitBin, ["clone", readUrl, cloneDir], {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});

		await writeFile(join(cloneDir, "hello.txt"), "from local git\n", "utf8");
		await execFileAsync(gitBin, ["-C", cloneDir, "config", "user.email", "dev@example.com"]);
		await execFileAsync(gitBin, ["-C", cloneDir, "config", "user.name", "Developer"]);
		await execFileAsync(gitBin, ["-C", cloneDir, "add", "hello.txt"]);
		await execFileAsync(gitBin, ["-C", cloneDir, "commit", "-m", "Add hello.txt"]);

		await expect(
			execFileAsync(gitBin, ["-C", cloneDir, "push", readUrl, "HEAD:refs/heads/main"], {
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			}),
		).rejects.toThrow();
		expect(recordedPushes).toHaveLength(0);

		await execFileAsync(gitBin, ["-C", cloneDir, "push", writeUrl, "HEAD:refs/heads/main"], {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		expect(recordedPushes).toHaveLength(1);
		expect(recordedPushes[0]).toMatchObject({
			p_environment_id: ENV_ID,
			p_owner: "acme",
			p_name: "app",
			p_token_id: TOKEN_ID,
			p_main_before: started.baseSha,
			p_pushed_refs: ["refs/heads/main"],
		});

		const mainFile = await readFile(join(companyRoot, "code/acme/app/main/hello.txt"), "utf8");
		expect(mainFile).toBe("from local git\n");

		await expect(
			execFileAsync(gitBin, ["-C", cloneDir, "push", writeUrl, "HEAD:refs/qorpera/hack"], {
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			}),
		).rejects.toThrow();

		await expect(
			execFileAsync(gitBin, ["-C", cloneDir, "push", writeUrl, ":refs/heads/main"], {
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			}),
		).rejects.toThrow();
	});
});
