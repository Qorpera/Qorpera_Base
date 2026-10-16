import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_HOST_INSTANCE, type CodeHostLease, codeHostProject } from "../src/code-host.ts";
import type { CodeHostGcBlock, CodeHostJob } from "../src/code-host-jobs.ts";
import {
	CODE_HOST_FOLDER_CLEAN,
	CODE_HOST_FOLDER_PUBLISH,
	CODE_HOST_FOLDER_START,
	CODE_HOST_FOLDER_STATE,
	CODE_HOST_LAYOUT,
	CODE_HOST_RPCS,
	CODE_HOST_VIEW_WRITE,
	type CodeHostControl,
	CodeHostJobs,
	type CodeHostJobsOptions,
	type CodeHostViewEvent,
	codeHostPublishAnswer,
	lxdCodeHostShell,
} from "../src/code-host-views.ts";
import type { LxdExecPipeRequest, LxdExecPipeResult, LxdInstanceExecPipeClient } from "../src/lxd-client.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const signal = () => new AbortController().signal;
const output = (exitCode: number, stdout = "", stderr = ""): LxdExecPipeResult => ({
	exitCode,
	stdout: Buffer.from(stdout),
	stderrTail: Buffer.from(stderr),
});
const report = (paths: { path: string; outcome: string }[], extra: Record<string, unknown> = {}) =>
	`${JSON.stringify({ commitId: randomUUID(), seq: 1, paths, ...extra })}\n`;
const saved = (path = "code/acme/app/repo.git/refs/heads/main") => report([{ path, outcome: "saved" }]);

type Unit = { active: string; result: string; code: number; status: number };
const ACTIVE: Unit = { active: "active", result: "success", code: 0, status: 0 };
const exited = (status: number): Unit => ({ active: "failed", result: "exit-code", code: 1, status });

/** One company's code host as its exec sees it: the folder program's unit, the mount at /company and the view file. */
class FakeHost {
	unit: Unit | undefined;
	mounted = false;
	view: string | undefined;
	/** What the folder program does once started: mount after `mountAfter` state reads, exit 3 (the node closed the
	 * view), exit 1, or run without mounting. */
	onStart: "mount" | "closed" | "failed" | "hang" = "mount";
	mountAfter = 1;
	mountSource = "fuse.qorpera qorpera-company";
	cleanStatus = 0;
	publishes: ({ status: number; stdout?: string } | "lost")[] = [];
	/** A job's own command. */
	job: (argv: readonly string[], signal: AbortSignal) => Promise<LxdExecPipeResult> = async () => output(0, "ok");
}

interface Exec {
	project: string;
	name: string;
	label: string;
	request: LxdExecPipeRequest;
	stdin?: string;
}

function labelOf(argv: readonly string[]): string {
	if (argv[0] === "/usr/bin/sh" && argv[1] === "-c" && argv.length === 3) {
		if (argv[2] === CODE_HOST_FOLDER_CLEAN) return "clean";
		if (argv[2] === CODE_HOST_VIEW_WRITE) return "view";
		if (argv[2] === CODE_HOST_FOLDER_STATE) return "state";
	}
	if (argv.join("\0") === CODE_HOST_FOLDER_START.join("\0")) return "start";
	if (argv.join("\0") === CODE_HOST_FOLDER_PUBLISH.join("\0")) return "publish";
	return argv.join(" ");
}

class FakeLxd implements LxdInstanceExecPipeClient {
	readonly hosts = new Map<string, FakeHost>();
	readonly execs: Exec[] = [];

	host(companyId: string): FakeHost {
		const project = codeHostProject(companyId);
		const host = this.hosts.get(project) ?? new FakeHost();
		this.hosts.set(project, host);
		return host;
	}

	labels(companyId = COMPANY): string[] {
		return this.execs.filter((exec) => exec.project === codeHostProject(companyId)).map((exec) => exec.label);
	}

	async execInstancePipe(
		project: string,
		name: string,
		request: LxdExecPipeRequest,
		signal: AbortSignal,
	): Promise<LxdExecPipeResult> {
		signal.throwIfAborted();
		const host = this.hosts.get(project);
		if (!host || name !== CODE_HOST_INSTANCE) throw new Error("LXD_INSTANCE_NOT_FOUND");
		const stdin = request.stdin instanceof Uint8Array ? Buffer.from(request.stdin).toString("utf8") : undefined;
		const label = labelOf(request.command);
		this.execs.push({ project, name, label, request, ...(stdin === undefined ? {} : { stdin }) });
		switch (label) {
			case "clean":
				if (host.cleanStatus !== 0) return output(host.cleanStatus, "", "umount: /company: target is busy");
				host.unit = undefined;
				host.mounted = false;
				host.view = undefined;
				return output(0);
			case "view":
				if (host.view !== undefined) return output(1, "", "mkdir: cannot create directory: File exists");
				host.view = stdin;
				return output(0);
			case "start":
				if (host.unit) return output(1, "", "Failed to start transient service unit: Unit already exists");
				host.unit = host.onStart === "closed" ? exited(3) : host.onStart === "failed" ? exited(1) : ACTIVE;
				return output(0);
			case "state": {
				if (host.unit?.active === "active" && host.onStart === "mount") {
					host.mountAfter -= 1;
					if (host.mountAfter <= 0) host.mounted = true;
				}
				const unit = host.unit ?? { active: "inactive", result: "success", code: 0, status: 0 };
				return output(
					0,
					`Mount=${host.mounted ? host.mountSource : ""}\nActiveState=${unit.active}\nResult=${unit.result}\n` +
						`ExecMainCode=${unit.code}\nExecMainStatus=${unit.status}\n`,
				);
			}
			case "publish": {
				const next = host.publishes.shift() ?? { status: 0, stdout: saved() };
				if (next === "lost") throw new Error("LXD_EXEC_LOST");
				return output(next.status, next.stdout ?? "");
			}
			default:
				return host.job(request.command, signal);
		}
	}
}

class FakeControl implements CodeHostControl {
	readonly calls: { method: string; args: Record<string, unknown> }[] = [];
	readonly views: { viewId: string; pass: string }[] = [];
	open: (() => unknown) | undefined;
	close: (() => unknown) | undefined;
	gcBegin: () => unknown = () => ({ schema: "qorpera.folder-git-gc/v1", state: "blocking", held: 0, until: "x" });
	gcEnd: () => unknown = () => ({ schema: "qorpera.folder-git-gc/v1", state: "ended" });

	async call(
		method: (typeof CODE_HOST_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		signal.throwIfAborted();
		this.calls.push({ method, args: structuredClone(args) });
		switch (method) {
			case "qorpera_folder_view_open": {
				if (this.open) return this.open();
				const view = { viewId: randomUUID(), pass: randomBytes(32).toString("base64url") };
				this.views.push(view);
				return { schema: "qorpera.folder-view/v1", ...view, leaseUntil: new Date(Date.now() + 120_000).toISOString() };
			}
			case "qorpera_folder_view_close":
				return this.close ? this.close() : { closed: true };
			case "qorpera_folder_git_gc_begin":
				return this.gcBegin();
			case "qorpera_folder_git_gc_end":
				return this.gcEnd();
		}
	}

	methods(): string[] {
		return this.calls.map((call) => call.method);
	}
}

/** The code hosts as `run` uses them: here every company's host is up at once. */
const hostsUp: CodeHostJobsOptions["hosts"] = {
	async use<T>(companyId: string, signal: AbortSignal, job: (host: CodeHostLease) => Promise<T>): Promise<T> {
		signal.throwIfAborted();
		return job({ companyId, project: codeHostProject(companyId), name: CODE_HOST_INSTANCE });
	},
};

function setup(options: Partial<CodeHostJobsOptions> = {}) {
	const lxd = new FakeLxd();
	lxd.host(COMPANY);
	lxd.host(OTHER);
	const control = new FakeControl();
	const events: CodeHostViewEvent[] = [];
	const jobs = new CodeHostJobs({
		hosts: hostsUp,
		client: lxd,
		control,
		log: (event) => events.push(event),
		mountWaitMs: 200,
		publishWaitMs: 200,
		pollMs: 2,
		...options,
	});
	return { lxd, control, events, jobs, host: lxd.host(COMPANY) };
}

/** A job that runs one command and answers its output. */
const oneCommand = async (job: CodeHostJob) => {
	const result = await job.shell.run(
		{ argv: ["/usr/local/bin/git", "--version"], env: {}, cwd: job.layout.scratchRoot, maximumOutputBytes: 1024 },
		job.signal,
	);
	return result.stdout.toString("utf8");
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function until(check: () => boolean) {
	for (let i = 0; i < 500 && !check(); i++) await delay(2);
	expect(check()).toBe(true);
}

describe("CodeHostJobs", () => {
	it("mounts a view of its own for the job, publishes what the job wrote, then takes the mount and the view down", async () => {
		const { lxd, control, jobs, host } = setup();
		host.mountAfter = 3;
		let seen: CodeHostJob | undefined;
		const answer = await jobs.run(COMPANY, ENVIRONMENT, signal(), async (job) => {
			seen = job;
			expect(host.mounted).toBe(true);
			return oneCommand(job);
		});
		expect(answer).toBe("ok");
		expect(lxd.labels()).toEqual([
			"clean",
			"view",
			"start",
			"state",
			"state",
			"state",
			"/usr/local/bin/git --version",
			"publish",
			"clean",
		]);
		expect(lxd.labels(OTHER)).toEqual([]);
		expect(seen?.layout).toEqual({
			companyRoot: "/company",
			scratchRoot: "/var/lib/qorpera-code-host",
			git: "/usr/local/bin/git",
		});
		expect(Object.isFrozen(CODE_HOST_LAYOUT)).toBe(true);

		const view = control.views[0];
		expect(control.calls).toEqual([
			{
				method: "qorpera_folder_view_open",
				args: { p_environment_id: ENVIRONMENT, p_opener: { kind: "platform" }, p_kind: "code_host", p_anchor: {} },
			},
			{ method: "qorpera_folder_view_close", args: { p_view_id: view?.viewId, p_pass: view?.pass } },
		]);
		// The view reaches the code host on stdin only, and only into the view file.
		const write = lxd.execs.find((exec) => exec.label === "view");
		expect(JSON.parse(write?.stdin ?? "")).toEqual({ environmentId: ENVIRONMENT, ...view });
		expect(Object.keys(JSON.parse(write?.stdin ?? "{}"))).toEqual(["environmentId", "viewId", "pass"]);
		for (const exec of lxd.execs) {
			expect(exec.project).toBe(codeHostProject(COMPANY));
			expect(exec.name).toBe("code-host");
			expect(JSON.stringify([exec.request.command, exec.request.environment, exec.request.cwd])).not.toContain(
				view?.pass,
			);
			if (exec.label !== "view") expect(exec.stdin ?? "").not.toContain(view?.pass);
		}
		for (const exec of lxd.execs.filter((exec) => exec.label !== "/usr/local/bin/git --version")) {
			expect(exec.request.environment).toEqual({ PATH: "/usr/sbin:/usr/bin" });
			expect(exec.request.cwd).toBe("/");
		}
		expect(CODE_HOST_FOLDER_START).toEqual([
			"/usr/bin/systemd-run",
			"--unit=qorpera-code-host-folder.service",
			"--quiet",
			"--property=Type=exec",
			"--property=KillMode=mixed",
			"--property=TimeoutStopSec=20s",
			"--",
			"/opt/qorpera-folder/qorpera-folder",
			"mount",
			"--view-file",
			"/run/qorpera-code-host/view.json",
			"--mountpoint",
			"/company",
			"--state-dir",
			"/run/qorpera-code-host/state",
			"--connect",
			"vsock:2:5250",
		]);
		expect(CODE_HOST_FOLDER_PUBLISH).toEqual([
			"/opt/qorpera-folder/qorpera-folder",
			"publish",
			"--view-file",
			"/run/qorpera-code-host/view.json",
			"--state-dir",
			"/run/qorpera-code-host/state",
			"--json",
			"--connect",
			"vsock:2:5250",
		]);
		expect(lxd.execs.find((exec) => exec.label === "publish")?.request.maxStdoutBytes).toBe(64 * 1024 ** 2);
		expect(host.unit).toBeUndefined();
		expect(host.mounted).toBe(false);
		expect(host.view).toBeUndefined();
	});

	it("publishes nothing for a job that fails, and still takes the mount and the view down; the job's error wins", async () => {
		const { lxd, control, jobs } = setup();
		const failure = new Error("the job broke");
		await expect(
			jobs.run(COMPANY, ENVIRONMENT, signal(), async (job) => {
				await oneCommand(job);
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(lxd.labels()).toEqual(["clean", "view", "start", "state", "/usr/local/bin/git --version", "clean"]);
		expect(control.methods()).toEqual(["qorpera_folder_view_open", "qorpera_folder_view_close"]);
	});

	it("publishes nothing for a cancelled job, and still takes the mount and the view down on their own deadlines", async () => {
		const { lxd, control, jobs, host } = setup();
		host.job = (_argv, signal) =>
			new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		const controller = new AbortController();
		const running = jobs.run(COMPANY, ENVIRONMENT, controller.signal, oneCommand);
		await until(() => lxd.labels().includes("/usr/local/bin/git --version"));
		const reason = new Error("the run stopped");
		controller.abort(reason);
		await expect(running).rejects.toBe(reason);
		expect(lxd.labels()).toEqual(["clean", "view", "start", "state", "/usr/local/bin/git --version", "clean"]);
		expect(control.methods()).toEqual(["qorpera_folder_view_open", "qorpera_folder_view_close"]);
	});

	it("fails the job when the node does not save every path, and asks again only when no answer came", async () => {
		const conflict = report([
			{ path: "code/acme/app/repo.git/packed-refs", outcome: "saved" },
			{ path: "code/acme/app/repo.git/refs/heads/main", outcome: "conflict" },
		]);
		const cases: { publishes: FakeHost["publishes"]; code?: string; detail?: string; count: number; waitMs?: number }[] = [
			{ publishes: [{ status: 4, stdout: conflict }], code: "CODE_HOST_PUBLISH_REFUSED", count: 1 },
			{
				publishes: [{ status: 4, stdout: report([], { refused: "UNPROVEN_READS" }) }],
				code: "CODE_HOST_PUBLISH_REFUSED",
				detail: "refused: UNPROVEN_READS",
				count: 1,
			},
			// Answered before its release check failed: publishing again would find nothing pending.
			{ publishes: [{ status: 1, stdout: conflict }, { status: 0, stdout: report([]) }], code: "CODE_HOST_PUBLISH_REFUSED", count: 1 },
			{ publishes: [{ status: 3 }], code: "CODE_HOST_VIEW_CLOSED", count: 1 },
			{ publishes: [{ status: 1 }, "lost", { status: 0, stdout: "not json\n" }, { status: 0, stdout: saved() }], count: 4 },
			{
				publishes: [{ status: 1, stdout: report([{ path: "code/acme/app/repo.git/HEAD", outcome: "waiting" }]) }],
				count: 2,
			},
			{
				publishes: Array.from({ length: 1000 }, () => ({ status: 1 })),
				code: "CODE_HOST_PUBLISH_UNANSWERED",
				count: -1,
				waitMs: 100,
			},
		];
		for (const test of cases) {
			const { lxd, control, jobs, host } = setup({ publishWaitMs: test.waitMs ?? 10_000 });
			host.publishes = [...test.publishes];
			const running = jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand);
			if (test.code) {
				const error = await running.catch((error: unknown) => error);
				expect(error).toMatchObject({ name: "CodeHostJobFailure", code: test.code });
				if (test.code === "CODE_HOST_PUBLISH_REFUSED")
					expect((error as { detail: string }).detail).toBe(
						test.detail ?? "code/acme/app/repo.git/refs/heads/main: conflict",
					);
			} else await expect(running).resolves.toBe("ok");
			const publishes = lxd.labels().filter((label) => label === "publish").length;
			if (test.count >= 0) expect(publishes).toBe(test.count);
			else expect(publishes).toBeGreaterThan(1);
			expect(lxd.labels().at(-1)).toBe("clean");
			expect(control.methods().at(-1)).toBe("qorpera_folder_view_close");
		}
	});

	it("stops at a mount the node closes, a folder program that fails, and one that never mounts; the job never runs", async () => {
		const cases: { onStart: FakeHost["onStart"]; source?: string; code: string }[] = [
			{ onStart: "closed", code: "CODE_HOST_VIEW_CLOSED" },
			{ onStart: "failed", code: "CODE_HOST_FOLDER_FAILED" },
			{ onStart: "hang", code: "CODE_HOST_FOLDER_UNAVAILABLE" },
			{ onStart: "mount", source: "fuse.qorpera something-else", code: "CODE_HOST_FOLDER_UNAVAILABLE" },
			{ onStart: "mount", source: "ext4 /dev/sda1", code: "CODE_HOST_FOLDER_UNAVAILABLE" },
		];
		for (const test of cases) {
			const { lxd, control, jobs, host } = setup({ mountWaitMs: 30 });
			host.onStart = test.onStart;
			if (test.source) host.mountSource = test.source;
			let ran = false;
			await expect(
				jobs.run(COMPANY, ENVIRONMENT, signal(), async () => {
					ran = true;
				}),
			).rejects.toMatchObject({ code: test.code });
			expect(ran).toBe(false);
			expect(lxd.labels()).not.toContain("publish");
			expect(lxd.labels().at(-1)).toBe("clean");
			expect(control.methods()).toEqual(["qorpera_folder_view_open", "qorpera_folder_view_close"]);
		}
		// A plain `fuse` mount of the company folder counts too.
		const { jobs, host } = setup();
		host.mountSource = "fuse qorpera-company";
		await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand)).resolves.toBe("ok");
	});

	it("opens no view on a code host it cannot clean", async () => {
		const { lxd, control, jobs, host } = setup();
		host.cleanStatus = 1;
		await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand)).rejects.toMatchObject({
			code: "CODE_HOST_FOLDER_UNCLEAN",
			detail: "umount: /company: target is busy",
		});
		expect(lxd.labels()).toEqual(["clean"]);
		expect(control.calls).toEqual([]);
	});

	it("takes only a view the core answers, and writes nothing otherwise", async () => {
		const good = () => ({ schema: "qorpera.folder-view/v1", viewId: randomUUID(), pass: "a".repeat(43) });
		const answers: (() => unknown)[] = [
			() => ({ ...good(), schema: "qorpera.folder-view/v2" }),
			() => ({ ...good(), viewId: "not-a-uuid" }),
			() => ({ ...good(), viewId: randomUUID().toUpperCase() }),
			() => ({ ...good(), pass: "a".repeat(42) }),
			() => ({ ...good(), pass: `${"a".repeat(42)}=` }),
			() => ({ ...good(), pass: 42 }),
			() => null,
			() => [good()],
			() => {
				throw new Error("CODING_CONTROL_UNCONFIRMED");
			},
		];
		for (const answer of answers) {
			const { lxd, control, jobs } = setup();
			control.open = answer;
			await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand)).rejects.toMatchObject({
				code: "CODE_HOST_VIEW_UNAVAILABLE",
			});
			expect(lxd.labels()).toEqual(["clean"]);
			expect(control.methods()).toEqual(["qorpera_folder_view_open"]);
		}
	});

	it("gives the job the core's gc block on its own view, and checks each answer", async () => {
		const { control, jobs } = setup();
		const repository = "code/acme/app";
		const answers: unknown[] = [];
		await jobs.run(COMPANY, ENVIRONMENT, signal(), async (job, gc: CodeHostGcBlock) => {
			control.gcBegin = () => ({ schema: "qorpera.folder-git-gc/v1", state: "blocking", held: 2, until: "t" });
			answers.push(await gc.begin(repository, job.signal));
			control.gcBegin = () => ({ schema: "qorpera.folder-git-gc/v1", state: "busy", until: "t" });
			answers.push(await gc.begin(repository, job.signal));
			answers.push(await gc.end(repository, job.signal));
		});
		expect(answers).toEqual([{ state: "blocking", held: 2 }, { state: "busy" }, undefined]);
		const view = control.views[0];
		const args = {
			p_environment_id: ENVIRONMENT,
			p_actor: { kind: "view", viewId: view?.viewId, pass: view?.pass },
			p_repository: repository,
		};
		expect(control.calls.slice(1, 4)).toEqual([
			{ method: "qorpera_folder_git_gc_begin", args },
			{ method: "qorpera_folder_git_gc_begin", args },
			{ method: "qorpera_folder_git_gc_end", args },
		]);

		const begins: unknown[] = [
			{ schema: "qorpera.folder-git-gc/v1", state: "blocking", held: -1 },
			{ schema: "qorpera.folder-git-gc/v1", state: "blocking", held: 1.5 },
			{ schema: "qorpera.folder-git-gc/v1", state: "blocking" },
			{ schema: "qorpera.folder-git-gc/v1", state: "ended" },
			{ schema: "qorpera.folder-git-gc/v2", state: "busy" },
			null,
		];
		for (const begin of begins) {
			const { lxd, control, jobs } = setup();
			control.gcBegin = () => begin;
			await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), (job, gc) => gc.begin(repository, job.signal))).rejects.toMatchObject({
				code: "CODE_HOST_GC_UNANSWERED",
			});
			expect(lxd.labels()).not.toContain("publish");
		}
		for (const end of [{ schema: "qorpera.folder-git-gc/v1", state: "blocking", held: 0 }, {}, null]) {
			const { control, jobs } = setup();
			control.gcEnd = () => end;
			await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), (job, gc) => gc.end(repository, job.signal))).rejects.toMatchObject({
				code: "CODE_HOST_GC_UNANSWERED",
			});
		}
	});

	it("runs a company's jobs one after another in the order they came, and other companies' jobs meanwhile", async () => {
		const { lxd, control, jobs } = setup();
		const order: string[] = [];
		const first = deferred();
		const a1 = jobs.run(COMPANY, ENVIRONMENT, signal(), async () => {
			order.push("a1");
			await first.promise;
			order.push("a1 done");
		});
		await until(() => order.includes("a1"));
		const a2 = jobs.run(COMPANY, ENVIRONMENT, signal(), async () => {
			order.push("a2");
		});
		const a3 = jobs.run(COMPANY, ENVIRONMENT, signal(), async () => {
			order.push("a3");
		});
		await jobs.run(OTHER, ENVIRONMENT, signal(), async () => {
			order.push("b1");
		});
		await delay(20);
		expect(order).toEqual(["a1", "b1"]);
		first.resolve();
		await Promise.all([a1, a2, a3]);
		expect(order).toEqual(["a1", "b1", "a1 done", "a2", "a3"]);
		// Each of the company's jobs found the code host clean, and its view closed before the next one opened.
		expect(lxd.labels().join(",")).toBe(
			Array.from({ length: 3 }, () => "clean,view,start,state,publish,clean").join(","),
		);
		// The other company's view opened and closed while the first job held its own.
		expect(control.methods()).toEqual([
			"qorpera_folder_view_open",
			"qorpera_folder_view_open",
			"qorpera_folder_view_close",
			"qorpera_folder_view_close",
			"qorpera_folder_view_open",
			"qorpera_folder_view_close",
			"qorpera_folder_view_open",
			"qorpera_folder_view_close",
		]);
	});

	it("lets a job cancelled while it waits leave its place, and the ones behind it keep theirs", async () => {
		const { control, jobs } = setup();
		const order: string[] = [];
		const first = deferred();
		const a1 = jobs.run(COMPANY, ENVIRONMENT, signal(), async () => {
			order.push("a1");
			await first.promise;
		});
		await until(() => order.includes("a1"));
		const controller = new AbortController();
		const a2 = jobs.run(COMPANY, ENVIRONMENT, controller.signal, async () => {
			order.push("a2");
		});
		const a3 = jobs.run(COMPANY, ENVIRONMENT, signal(), async () => {
			order.push("a3");
		});
		const reason = new Error("cancelled");
		controller.abort(reason);
		await expect(a2).rejects.toBe(reason);
		await delay(20);
		expect(order).toEqual(["a1"]);
		first.resolve();
		await Promise.all([a1, a3]);
		expect(order).toEqual(["a1", "a3"]);
		expect(control.views).toHaveLength(2);
		// An already cancelled job takes no place at all.
		const aborted = new AbortController();
		aborted.abort(reason);
		await expect(jobs.run(COMPANY, ENVIRONMENT, aborted.signal, oneCommand)).rejects.toBe(reason);
		await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand)).resolves.toBe("ok");
	});

	it("logs a clean or a close that fails after the job, without the pass, and keeps the job's answer", async () => {
		const { lxd, control, events, jobs, host } = setup();
		host.job = async () => {
			host.cleanStatus = 1;
			return output(0, "ok");
		};
		control.close = () => {
			throw new Error("CODING_CONTROL_UNCONFIRMED");
		};
		await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand)).resolves.toBe("ok");
		expect(events.map((event) => [event.event, event.step, event.project])).toEqual([
			["code-host-view-error", "clean", codeHostProject(COMPANY)],
			["code-host-view-error", "close", codeHostProject(COMPANY)],
		]);
		const pass = control.views[0]?.pass ?? "";
		expect(pass).toHaveLength(43);
		expect(JSON.stringify(events.map((event) => ({ ...event, error: String(event.error) })))).not.toContain(pass);
		// The next job cleans first, and stops there while the code host stays unclean.
		await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand)).rejects.toMatchObject({
			code: "CODE_HOST_FOLDER_UNCLEAN",
		});
		host.cleanStatus = 0;
		await expect(jobs.run(COMPANY, ENVIRONMENT, signal(), oneCommand)).resolves.toBe("ok");
		expect(lxd.labels().filter((label) => label === "view")).toHaveLength(2);
	});

	it("refuses bad ids and options", async () => {
		const { jobs } = setup();
		for (const [company, environment] of [
			["not-a-uuid", ENVIRONMENT],
			[COMPANY, "not-a-uuid"],
			[COMPANY.toUpperCase(), ENVIRONMENT],
		] as const)
			await expect(jobs.run(company, environment, signal(), oneCommand)).rejects.toThrow("INVALID_CODE_HOST_JOB");
		for (const option of ["mountWaitMs", "publishWaitMs", "cleanMs", "callMs", "pollMs"] as const)
			for (const value of [0, -1, 1.5, 3_600_001, Number.NaN]) {
				const options: Partial<CodeHostJobsOptions> = {};
				options[option] = value;
				expect(() => setup(options)).toThrow("INVALID_CODE_HOST_JOBS");
			}
		expect(() => setup({ mountWaitMs: 3_600_000, pollMs: 1 })).not.toThrow();
	});
});

describe("codeHostPublishAnswer", () => {
	it("takes saved only from exit 0 with every path saved, and refused from an answered report that says so", () => {
		const conflict = report([{ path: "code/a/b/repo.git/HEAD", outcome: "conflict" }]);
		const waiting = report([{ path: "code/a/b/repo.git/HEAD", outcome: "waiting" }]);
		const cases: [number, string, string][] = [
			[0, saved(), "saved"],
			[0, report([]), "saved"],
			[0, report([]).trimEnd(), "saved"],
			[0, conflict, "unanswered"],
			[0, report([], { refused: "X" }), "unanswered"],
			[4, saved(), "unanswered"],
			[4, conflict, "refused"],
			[4, report([], { refused: "UNPROVEN_READS" }), "refused"],
			[4, "", "unanswered"],
			[1, "", "unanswered"],
			[1, saved(), "unanswered"],
			[1, waiting, "unanswered"],
			[1, conflict, "refused"],
			[1, report([{ path: "x", outcome: "denied" }]), "refused"],
			[3, "", "closed"],
			[3, saved(), "closed"],
			[2, saved(), "unanswered"],
			[0, `${saved()}${saved()}`, "unanswered"],
			[0, "\n", "unanswered"],
			[0, "[]\n", "unanswered"],
			[0, '{"paths":[{"path":"x"}]}\n', "unanswered"],
			[0, '{"paths":{}}\n', "unanswered"],
		];
		for (const [status, stdout, answer] of cases)
			expect([status, stdout, codeHostPublishAnswer(status, Buffer.from(stdout)).answer]).toEqual([status, stdout, answer]);
		expect(codeHostPublishAnswer(0, Buffer.from([0xff, 0x0a])).answer).toBe("unanswered");
		const many = report(Array.from({ length: 25 }, (_, i) => ({ path: `p${i}`, outcome: "not_applied" })));
		expect(codeHostPublishAnswer(4, Buffer.from(many))).toEqual({
			answer: "refused",
			detail: `${Array.from({ length: 20 }, (_, i) => `p${i}: not_applied`).join(", ")}, and 5 more`,
		});
	});
});

describe("lxdCodeHostShell", () => {
	it("runs a job's command by exec in its company's code host, with the end of stderr", async () => {
		const requests: [string, string, LxdExecPipeRequest][] = [];
		const client: LxdInstanceExecPipeClient = {
			async execInstancePipe(project, name, request) {
				requests.push([project, name, request]);
				return output(2, "out", "err");
			},
		};
		const shell = lxdCodeHostShell(client, { project: codeHostProject(COMPANY), name: CODE_HOST_INSTANCE });
		const command = { argv: ["/usr/local/bin/git", "status"], env: { GIT_CONFIG_NOSYSTEM: "1" }, cwd: "/company" };
		await expect(shell.run({ ...command, maximumOutputBytes: 99 }, signal())).resolves.toEqual({
			status: 2,
			stdout: Buffer.from("out"),
			stderr: "err",
		});
		const stdin = Buffer.from("input");
		await shell.run({ ...command, stdin, maximumOutputBytes: 99 }, signal());
		expect(requests[0]).toEqual([
			codeHostProject(COMPANY),
			"code-host",
			{
				command: command.argv,
				environment: command.env,
				cwd: "/company",
				maxStdoutBytes: 99,
				stderrTailBytes: 64 * 1024,
			},
		]);
		expect("stdin" in (requests[0]?.[2] ?? {})).toBe(false);
		expect(requests[1]?.[2].stdin).toBe(stdin);
	});

	it("names the control's RPCs", () => {
		expect(CODE_HOST_RPCS).toEqual([
			"qorpera_folder_view_open",
			"qorpera_folder_view_close",
			"qorpera_folder_git_gc_begin",
			"qorpera_folder_git_gc_end",
		]);
	});
});

describe("the code host's scripts", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	/** Runs a script with stand-ins for systemd and the mount tools, which log their arguments. */
	async function script(text: string, env: Record<string, string>) {
		const dir = await mkdtemp(join(tmpdir(), "code-host-views-"));
		dirs.push(dir);
		const stubs: Record<string, string> = {
			systemctl: 'case "$1" in show) printf "%s\\n" "$SHOW" ;; stop) exit "${STOP:-0}" ;; esac',
			mountpoint: '[ "$(cat "$STATE/mounts")" -gt 0 ]',
			umount: '[ -n "${STUCK:-}" ] || echo $(($(cat "$STATE/mounts") - 1)) >"$STATE/mounts"',
			rm: ":",
			findmnt: 'printf "%b" "$FINDMNT"',
		};
		for (const [name, body] of Object.entries(stubs))
			await writeFile(join(dir, name), `#!/bin/sh\necho "${name} $*" >>"$STATE/log"\n${body}\n`, { mode: 0o755 });
		await writeFile(join(dir, "log"), "");
		await writeFile(join(dir, "mounts"), env.MOUNTS ?? "0");
		const run = spawnSync("/bin/sh", ["-c", text], {
			env: { PATH: `${dir}:/usr/bin:/bin`, STATE: dir, ...env },
			encoding: "utf8",
		});
		return { status: run.status, stdout: run.stdout, log: (await readFile(join(dir, "log"), "utf8")).split("\n").filter(Boolean) };
	}

	const unit = "qorpera-code-host-folder.service";
	const show = `systemctl show --property=LoadState --value -- ${unit}`;

	it("stops the mount's program, unmounts every layer at /company, and only then removes the view", async () => {
		await expect(script(CODE_HOST_FOLDER_CLEAN, { SHOW: "loaded", MOUNTS: "2" })).resolves.toMatchObject({
			status: 0,
			log: [
				show,
				`systemctl stop -- ${unit}`,
				`systemctl reset-failed -- ${unit}`,
				"mountpoint -q /company",
				"umount -l /company",
				"mountpoint -q /company",
				"umount -l /company",
				"mountpoint -q /company",
				"rm -rf --one-file-system /run/qorpera-code-host",
			],
		});
		await expect(script(CODE_HOST_FOLDER_CLEAN, { SHOW: "not-found" })).resolves.toMatchObject({
			status: 0,
			log: [show, "mountpoint -q /company", "rm -rf --one-file-system /run/qorpera-code-host"],
		});
	});

	it("fails without removing the view while the program does not stop or /company stays mounted", async () => {
		await expect(script(CODE_HOST_FOLDER_CLEAN, { SHOW: "loaded", STOP: "1", MOUNTS: "1" })).resolves.toMatchObject({
			status: 1,
			log: [show, `systemctl stop -- ${unit}`],
		});
		const stuck = await script(CODE_HOST_FOLDER_CLEAN, { SHOW: "not-found", MOUNTS: "1", STUCK: "1" });
		expect(stuck.status).toBe(1);
		expect(stuck.log.filter((line) => line.startsWith("umount"))).toHaveLength(8);
		expect(stuck.log.some((line) => line.startsWith("rm"))).toBe(false);
	});

	it("reads the top mount at /company and the program's unit", async () => {
		const state = "ActiveState=failed\nResult=exit-code\nExecMainCode=1\nExecMainStatus=3";
		await expect(
			script(CODE_HOST_FOLDER_STATE, {
				FINDMNT: "fuse.qorpera other\\nfuse.qorpera qorpera-company\\n",
				SHOW: state,
			}),
		).resolves.toMatchObject({
			status: 0,
			stdout: `Mount=fuse.qorpera qorpera-company\n${state}\n`,
			log: [
				"findmnt -rn -o FSTYPE,SOURCE --mountpoint /company",
				`systemctl show --property=ActiveState,Result,ExecMainCode,ExecMainStatus -- ${unit}`,
			],
		});
		await expect(script(CODE_HOST_FOLDER_STATE, { FINDMNT: "", SHOW: "ActiveState=inactive" })).resolves.toMatchObject({
			stdout: "Mount=\nActiveState=inactive\n",
		});
	});

	it("writes the view file root's alone into a new directory, and refuses one already there", async () => {
		const dir = await mkdtemp(join(tmpdir(), "code-host-views-run-"));
		dirs.push(dir);
		const text = CODE_HOST_VIEW_WRITE.replaceAll("/run/qorpera-code-host", `${dir}/run`);
		expect(text).not.toBe(CODE_HOST_VIEW_WRITE);
		const write = () => spawnSync("/bin/sh", ["-c", text], { input: '{"view":1}', encoding: "utf8" });
		expect(write().status).toBe(0);
		expect((await stat(`${dir}/run`)).mode & 0o777).toBe(0o700);
		expect((await stat(`${dir}/run/view.json`)).mode & 0o777).toBe(0o600);
		await expect(readFile(`${dir}/run/view.json`, "utf8")).resolves.toBe('{"view":1}');
		expect(write().status).not.toBe(0);
		await expect(readFile(`${dir}/run/view.json`, "utf8")).resolves.toBe('{"view":1}');
	});
});
