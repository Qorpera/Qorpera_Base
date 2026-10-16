import { setTimeout as delay } from "node:timers/promises";
import { type CloudCodingRepository, isUuid, parseCloudCodingRepository } from "@qorpera/contracts";
import type { CodeHostLease, LxdCodeHosts } from "./code-host.ts";
import {
	type CodeHostCommandResult,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	type CodeHostLayout,
	type CodeHostShell,
	exportCodeBranch,
} from "./code-host-jobs.ts";
import { attachCodeSession, type CodeAreaBroker, type CodeSessionAttached } from "./code-host-seed.ts";
import type { LxdInstanceExecPipeClient } from "./lxd-client.ts";

/** The code host's views (5e-3b, RUNTIME-FOLDER-CODING-MACHINES.md "The code host"). Every job gets its own `code_host`
 * view of the company folder, which the pinned folder program mounts at `/company` in the company's code host. What a
 * job writes stays pending on the node until the job ends well and its view publishes it; a job that fails publishes
 * nothing, so the code area never holds half a job's git. The view's pass reaches the code host over exec stdin only,
 * into /run. Worktrees name their admin directories by absolute path (`worktree.useRelativePaths` is off), and coding
 * machines see them at `/company` too: so a code host mounts one view at a time, and a company's jobs run one after
 * another. */

export const CODE_HOST_RPCS = [
	"qorpera_folder_view_open",
	"qorpera_folder_view_close",
	"qorpera_folder_git_gc_begin",
	"qorpera_folder_git_gc_end",
] as const;

export interface CodeHostControl {
	call(method: (typeof CODE_HOST_RPCS)[number], args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** Where a job finds the company folder, its scratch and git in the code host image (deploy/code-host). */
export const CODE_HOST_LAYOUT: Readonly<CodeHostLayout> = Object.freeze({
	companyRoot: "/company",
	scratchRoot: "/var/lib/qorpera-code-host",
	git: "/usr/local/bin/git",
});

/** The job's view file and the mount's state, on the code host's tmpfs: gone at its next boot at the latest. */
const RUN = "/run/qorpera-code-host";
const UNIT = "qorpera-code-host-folder.service";
const FOLDER = "/opt/qorpera-folder/qorpera-folder";
const CONNECT = "vsock:2:5250";
const ENV = Object.freeze({ PATH: "/usr/sbin:/usr/bin" });
/** The core's view passes (C1b-3a `qorpera_folder_view_new_pass`). */
const PASS = /^[A-Za-z0-9_-]{43}$/;
const STDERR_TAIL_BYTES = 64 * 1024;
/** A publish reports every path it carried: a seed's checkout may be tens of thousands. */
const PUBLISH_OUTPUT_BYTES = 64 * 1024 ** 2;

/** What a lost job may have left: its mount program, the mount, and the view file. The view file goes only once
 * nothing is mounted at /company. */
export const CODE_HOST_FOLDER_CLEAN = `set -u
u=${UNIT}
if [ "$(systemctl show --property=LoadState --value -- "$u")" != not-found ]; then
	systemctl stop -- "$u" || exit 1
	systemctl reset-failed -- "$u" 2>/dev/null || true
fi
n=0
while mountpoint -q /company; do
	n=$((n + 1))
	[ "$n" -le 8 ] || exit 1
	umount -l /company || exit 1
done
rm -rf --one-file-system ${RUN}`;
/** The view file from stdin, root's alone. Its directory must be new: a clean ran first. */
export const CODE_HOST_VIEW_WRITE = `umask 077 && mkdir -m 0700 -- ${RUN} && cat > ${RUN}/view.json`;
export const CODE_HOST_FOLDER_STATE = `printf 'Mount=%s\\n' "$(findmnt -rn -o FSTYPE,SOURCE --mountpoint /company | tail -n 1)"
systemctl show --property=ActiveState,Result,ExecMainCode,ExecMainStatus -- ${UNIT}`;
export const CODE_HOST_FOLDER_START: readonly string[] = Object.freeze([
	"/usr/bin/systemd-run",
	`--unit=${UNIT}`,
	"--quiet",
	"--property=Type=exec",
	"--property=KillMode=mixed",
	"--property=TimeoutStopSec=20s",
	"--",
	FOLDER,
	"mount",
	"--view-file",
	`${RUN}/view.json`,
	"--mountpoint",
	"/company",
	"--state-dir",
	`${RUN}/state`,
	"--connect",
	CONNECT,
]);
export const CODE_HOST_FOLDER_PUBLISH: readonly string[] = Object.freeze([
	FOLDER,
	"publish",
	"--view-file",
	`${RUN}/view.json`,
	"--state-dir",
	`${RUN}/state`,
	"--json",
	"--connect",
	CONNECT,
]);

export type CodeHostViewEvent = {
	event: "code-host-view-error";
	step: "clean" | "close";
	project: string;
	error: unknown;
};

export interface CodeHostJobsOptions {
	hosts: Pick<LxdCodeHosts, "use">;
	client: LxdInstanceExecPipeClient;
	control: CodeHostControl;
	log?: (event: CodeHostViewEvent) => void;
	/** How long the folder program may take to mount the view. Default 40 s. */
	mountWaitMs?: number;
	/** How long a publish is asked again while it gets no answer. Default 60 s. */
	publishWaitMs?: number;
	/** How long a clean, and each core call, may take. Default 60 s and 10 s. */
	cleanMs?: number;
	callMs?: number;
	/** How often the mount is looked at while it comes up; a publish without an answer is asked again after 5 times
	 * this. Default 200 ms. */
	pollMs?: number;
}

interface View {
	readonly environmentId: string;
	readonly viewId: string;
	readonly pass: string;
}

export type CodeHostPublishAnswer =
	| { answer: "saved" }
	| { answer: "refused"; detail: string }
	| { answer: "closed" | "unanswered" };

/** The exec a job runs in its company's code host. */
export function lxdCodeHostShell(
	client: LxdInstanceExecPipeClient,
	host: Pick<CodeHostLease, "project" | "name">,
): CodeHostShell {
	return {
		async run(command, signal): Promise<CodeHostCommandResult> {
			const result = await client.execInstancePipe(
				host.project,
				host.name,
				{
					command: command.argv,
					environment: command.env,
					cwd: command.cwd,
					...(command.stdin === undefined ? {} : { stdin: command.stdin }),
					maxStdoutBytes: command.maximumOutputBytes,
					stderrTailBytes: STDERR_TAIL_BYTES,
				},
				signal,
			);
			return { status: result.exitCode, stdout: result.stdout, stderr: result.stderrTail.toString("utf8") };
		},
	};
}

/** A coding session's place on its company's code host (5e-4). */
export interface CodeHostSession {
	companyId: string;
	environmentId: string;
	repository: CloudCodingRepository;
	workerId: string;
	/** The base branch's commit the session started from (`resolveCloudCodingBase`). */
	baseSha: string;
}

/** The jobs of the executor's code hosts: `run` gives a job its company's code host, with the company folder mounted
 * through a view of its own, and the core's gc block on that view. What a job that ends well wrote is published (all
 * saved, or the job fails) before it answers; a job that fails or is cancelled publishes nothing. The mount and view
 * are taken down on every path, on their own deadlines; a clean that fails is tried again before the next job. */
export class CodeHostJobs {
	readonly #hosts: CodeHostJobsOptions["hosts"];
	readonly #client: LxdInstanceExecPipeClient;
	readonly #control: CodeHostControl;
	readonly #log: (event: CodeHostViewEvent) => void;
	readonly #mountWaitMs: number;
	readonly #publishWaitMs: number;
	readonly #cleanMs: number;
	readonly #callMs: number;
	readonly #pollMs: number;
	/** Each company's last job in line. */
	readonly #tails = new Map<string, Promise<void>>();

	constructor(options: CodeHostJobsOptions) {
		this.#hosts = options.hosts;
		this.#client = options.client;
		this.#control = options.control;
		this.#log = options.log ?? (() => undefined);
		this.#mountWaitMs = options.mountWaitMs ?? 40_000;
		this.#publishWaitMs = options.publishWaitMs ?? 60_000;
		this.#cleanMs = options.cleanMs ?? 60_000;
		this.#callMs = options.callMs ?? 10_000;
		this.#pollMs = options.pollMs ?? 200;
		if (
			![this.#mountWaitMs, this.#publishWaitMs, this.#cleanMs, this.#callMs, this.#pollMs].every(
				(ms) => Number.isSafeInteger(ms) && ms >= 1 && ms <= 3_600_000,
			)
		)
			throw new Error("INVALID_CODE_HOST_JOBS");
	}

	async run<T>(
		companyId: string,
		environmentId: string,
		signal: AbortSignal,
		job: (job: CodeHostJob, gc: CodeHostGcBlock) => Promise<T>,
	): Promise<T> {
		if (!isUuid(companyId) || !isUuid(environmentId)) throw new Error("INVALID_CODE_HOST_JOB");
		const done = await this.#turn(companyId, signal);
		try {
			return await this.#hosts.use(companyId, signal, (host) => this.#run(host, environmentId, signal, job));
		} finally {
			done();
		}
	}

	/** A coding session's worktree on the code area, seeded first when needed, in one job (5e-4, `attachCodeSession`). */
	async attach(value: CodeHostSession, broker: CodeAreaBroker, signal: AbortSignal): Promise<CodeSessionAttached> {
		const { companyId, environmentId, repository, workerId, baseSha } = sessionOf(value);
		return await this.run(companyId, environmentId, signal, (job) =>
			attachCodeSession(job, { repository, workerId, baseSha }, broker),
		);
	}

	/** The session's submitted commit as a bundle for the broker's push, or none when it has nothing beyond the
	 * session's base (`exportCodeBranch`). */
	async export(
		value: CodeHostSession & { headSha: string },
		options: { maximumBytes: number },
		signal: AbortSignal,
	): Promise<{ headSha: string; bundle: Buffer | null }> {
		const { companyId, environmentId, repository, workerId, baseSha, headSha } = sessionOf(value, ["headSha"]);
		return await this.run(companyId, environmentId, signal, (job) =>
			exportCodeBranch(job, { repository, workerId, baseSha, headSha }, options),
		);
	}

	/** A company's jobs, one at a time, in the order they came. One that stops waiting leaves its place. */
	async #turn(companyId: string, signal: AbortSignal): Promise<() => void> {
		const before = this.#tails.get(companyId) ?? Promise.resolve();
		let done!: () => void;
		const mine = new Promise<void>((resolve) => {
			done = resolve;
		});
		const tail = before.then(() => mine);
		this.#tails.set(companyId, tail);
		void tail.then(() => {
			if (this.#tails.get(companyId) === tail) this.#tails.delete(companyId);
		});
		try {
			await waitFor(before, signal);
		} catch (error) {
			done();
			throw error;
		}
		return done;
	}

	async #run<T>(
		host: CodeHostLease,
		environmentId: string,
		signal: AbortSignal,
		job: (job: CodeHostJob, gc: CodeHostGcBlock) => Promise<T>,
	): Promise<T> {
		const shell = lxdCodeHostShell(this.#client, host);
		await this.#clean(shell, AbortSignal.any([signal, AbortSignal.timeout(this.#cleanMs)])).catch(
			(error: unknown) => {
				signal.throwIfAborted();
				throw error;
			},
		);
		const view = await this.#open(environmentId, signal);
		let failure: { error: unknown } | undefined, result: T | undefined;
		try {
			await this.#ok(
				shell,
				["/usr/bin/sh", "-c", CODE_HOST_VIEW_WRITE],
				signal,
				Buffer.from(JSON.stringify({ environmentId: view.environmentId, viewId: view.viewId, pass: view.pass })),
			);
			await this.#ok(shell, CODE_HOST_FOLDER_START, signal);
			await this.#mounted(shell, signal);
			result = await job({ shell, layout: CODE_HOST_LAYOUT, signal }, this.#gcBlock(view));
			const published = await this.#publish(shell, signal);
			if (published.answer === "closed") throw new CodeHostJobFailure("CODE_HOST_VIEW_CLOSED", "the view closed");
			if (published.answer === "refused")
				throw new CodeHostJobFailure("CODE_HOST_PUBLISH_REFUSED", published.detail);
			if (published.answer === "unanswered")
				throw new CodeHostJobFailure("CODE_HOST_PUBLISH_UNANSWERED", "the node did not answer the publish");
		} catch (error) {
			failure = { error };
		}
		await this.#clean(shell, AbortSignal.timeout(this.#cleanMs)).catch((error: unknown) =>
			this.#log({ event: "code-host-view-error", step: "clean", project: host.project, error }),
		);
		// Best effort: a view no folder program renews also ends with its lease.
		await this.#control
			.call(
				"qorpera_folder_view_close",
				{ p_view_id: view.viewId, p_pass: view.pass },
				AbortSignal.timeout(this.#callMs),
			)
			.catch((error: unknown) =>
				this.#log({ event: "code-host-view-error", step: "close", project: host.project, error }),
			);
		if (failure) throw failure.error;
		return result as T;
	}

	async #open(environmentId: string, signal: AbortSignal): Promise<View> {
		let answer: unknown;
		try {
			answer = await this.#call(
				"qorpera_folder_view_open",
				{ p_environment_id: environmentId, p_opener: { kind: "platform" }, p_kind: "code_host", p_anchor: {} },
				signal,
			);
		} catch (error) {
			signal.throwIfAborted();
			throw new CodeHostJobFailure("CODE_HOST_VIEW_UNAVAILABLE", error instanceof Error ? error.message : "");
		}
		const { schema, viewId, pass } = isRecord(answer) ? answer : {};
		if (schema !== "qorpera.folder-view/v1" || !isUuid(viewId) || typeof pass !== "string" || !PASS.test(pass))
			throw new CodeHostJobFailure("CODE_HOST_VIEW_UNAVAILABLE", "the core's answer is not a view");
		return { environmentId, viewId, pass };
	}

	#gcBlock(view: View): CodeHostGcBlock {
		const args = (repository: string) => ({
			p_environment_id: view.environmentId,
			p_actor: { kind: "view", viewId: view.viewId, pass: view.pass },
			p_repository: repository,
		});
		return {
			begin: async (repository, signal) => {
				const answer = await this.#call("qorpera_folder_git_gc_begin", args(repository), signal);
				if (isRecord(answer) && answer.schema === "qorpera.folder-git-gc/v1") {
					if (answer.state === "busy") return { state: "busy" };
					if (answer.state === "blocking" && Number.isSafeInteger(answer.held) && (answer.held as number) >= 0)
						return { state: "blocking", held: answer.held as number };
				}
				throw new CodeHostJobFailure("CODE_HOST_GC_UNANSWERED", "the core's answer is not a gc block");
			},
			end: async (repository, signal) => {
				const answer = await this.#call("qorpera_folder_git_gc_end", args(repository), signal);
				if (!isRecord(answer) || answer.schema !== "qorpera.folder-git-gc/v1" || answer.state !== "ended")
					throw new CodeHostJobFailure("CODE_HOST_GC_UNANSWERED", "the core's answer is not a gc end");
			},
		};
	}

	/** Until the folder program has the view mounted, or says the node closed or refused it. */
	async #mounted(shell: CodeHostShell, signal: AbortSignal): Promise<void> {
		const until = Date.now() + this.#mountWaitMs;
		for (;;) {
			const state = await this.#ok(shell, ["/usr/bin/sh", "-c", CODE_HOST_FOLDER_STATE], signal);
			const fields = new Map(
				state.stdout
					.toString("utf8")
					.split("\n")
					.filter((line) => line.includes("="))
					.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
			);
			const active = fields.get("ActiveState");
			if (
				active === "active" &&
				["fuse qorpera-company", "fuse.qorpera qorpera-company"].includes(fields.get("Mount") ?? "")
			)
				return;
			if (
				active === "failed" &&
				fields.get("Result") === "exit-code" &&
				fields.get("ExecMainCode") === "1" &&
				fields.get("ExecMainStatus") === "3"
			)
				throw new CodeHostJobFailure("CODE_HOST_VIEW_CLOSED", "the node closed or refused the view");
			if (active === "failed" || active === "inactive")
				throw new CodeHostJobFailure("CODE_HOST_FOLDER_FAILED", "the folder program stopped before it mounted");
			if (Date.now() >= until)
				throw new CodeHostJobFailure("CODE_HOST_FOLDER_UNAVAILABLE", "the folder program did not mount the view");
			await delay(this.#pollMs, undefined, { signal });
		}
	}

	/** The view's pending changes, published until an answer or `publishWaitMs` (see `codeHostPublishAnswer`). */
	async #publish(shell: CodeHostShell, signal: AbortSignal): Promise<CodeHostPublishAnswer> {
		const until = Date.now() + this.#publishWaitMs;
		for (;;) {
			let answer: CodeHostPublishAnswer = { answer: "unanswered" };
			try {
				const result = await shell.run(
					{ argv: CODE_HOST_FOLDER_PUBLISH, env: ENV, cwd: "/", maximumOutputBytes: PUBLISH_OUTPUT_BYTES },
					AbortSignal.any([signal, AbortSignal.timeout(Math.max(until - Date.now(), 1))]),
				);
				answer = codeHostPublishAnswer(result.status, result.stdout);
			} catch {
				// A lost or oversized publish: asked again.
			}
			signal.throwIfAborted();
			if (answer.answer !== "unanswered" || Date.now() + this.#pollMs * 5 >= until) return answer;
			await delay(this.#pollMs * 5, undefined, { signal });
		}
	}

	async #clean(shell: CodeHostShell, signal: AbortSignal): Promise<void> {
		let result: CodeHostCommandResult;
		try {
			result = await shell.run(
				{ argv: ["/usr/bin/sh", "-c", CODE_HOST_FOLDER_CLEAN], env: ENV, cwd: "/", maximumOutputBytes: 64 * 1024 },
				signal,
			);
		} catch (error) {
			throw new CodeHostJobFailure("CODE_HOST_FOLDER_UNCLEAN", error instanceof Error ? error.message : "");
		}
		if (result.status !== 0) throw new CodeHostJobFailure("CODE_HOST_FOLDER_UNCLEAN", result.stderr.slice(-2000));
	}

	async #ok(
		shell: CodeHostShell,
		argv: readonly string[],
		signal: AbortSignal,
		stdin?: Uint8Array,
	): Promise<CodeHostCommandResult> {
		const result = await shell.run(
			{ argv, env: ENV, cwd: "/", ...(stdin ? { stdin } : {}), maximumOutputBytes: 64 * 1024 },
			signal,
		);
		if (result.status !== 0) throw new CodeHostJobFailure("CODE_HOST_FOLDER_FAILED", result.stderr.slice(-2000));
		return result;
	}

	#call(
		method: (typeof CODE_HOST_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(this.#callMs)]));
	}
}

/** `qorpera-folder publish --json`: 0 every path saved, 4 a path not saved or the boundary refused, 3 the view closed,
 * anything else no answer. Exit 1 can still print the node's answered report (its release check failed after it):
 * one with a path that will not be saved is refused, since publishing again would find nothing pending and exit 0.
 * A report that contradicts its exit code is no answer. */
export function codeHostPublishAnswer(status: number, stdout: Buffer): CodeHostPublishAnswer {
	if (status === 3) return { answer: "closed" };
	let report: unknown;
	try {
		const text = new TextDecoder("utf8", { fatal: true }).decode(stdout);
		report = /^[^\n]+\n?$/.test(text) ? JSON.parse(text) : undefined;
	} catch {
		return { answer: "unanswered" };
	}
	if (
		!isRecord(report) ||
		!Array.isArray(report.paths) ||
		!report.paths.every(
			(entry) => isRecord(entry) && typeof entry.path === "string" && typeof entry.outcome === "string",
		)
	)
		return { answer: "unanswered" };
	const refused = report.refused === undefined || report.refused === null ? undefined : String(report.refused);
	const unsaved = (report.paths as { path: string; outcome: string }[]).filter((entry) => entry.outcome !== "saved");
	const detail = () =>
		[
			...(refused === undefined ? [] : [`refused: ${refused.slice(0, 200)}`]),
			...unsaved.slice(0, 20).map((entry) => `${entry.path}: ${entry.outcome}`),
			...(unsaved.length > 20 ? [`and ${unsaved.length - 20} more`] : []),
		].join(", ");
	if (status === 0 && refused === undefined && unsaved.length === 0) return { answer: "saved" };
	if (status === 4 && (refused !== undefined || unsaved.length > 0)) return { answer: "refused", detail: detail() };
	// `waiting` is the only outcome a later publish can still turn into saved.
	if (status === 1 && (refused !== undefined || unsaved.some((entry) => entry.outcome !== "waiting")))
		return { answer: "refused", detail: detail() };
	return { answer: "unanswered" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SESSION_KEYS = ["baseSha", "companyId", "environmentId", "repository", "workerId"];

/** A session's fields and no others; `run` and the jobs check each one. */
function sessionOf<T extends CodeHostSession>(value: T, extra: readonly string[] = []): T {
	if (!isRecord(value) || Object.keys(value).sort().join() !== [...SESSION_KEYS, ...extra].sort().join())
		throw new Error("INVALID_CODE_HOST_JOB");
	return { ...value, repository: parseCloudCodingRepository(value.repository) } as T;
}

function waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		});
	});
}
