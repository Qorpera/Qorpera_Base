import { randomUUID } from "node:crypto";
import type { CloudCompanyFolderUnit } from "@qorpera/runtime/cloud-company-folder-client";
import {
	type CloudRunLogFolder,
	CloudRunLogGone,
	type CloudRunLogOrigin,
	type CloudRunLogPlace,
	CloudRunLogUnavailable,
} from "@qorpera/runtime/cloud-run-log";
import { type CloudRunLogOpened, openCloudRunLog } from "@qorpera/runtime/cloud-run-log-open";
import type {
	CloudRunResumeContext,
	CloudRunResumePort,
	CloudRunResumeRequest,
} from "@qorpera/runtime/cloud-run-resume";
import { MemoryCompactLane } from "@qorpera/runtime/memory-tree/compact";
import { afterEach, describe, expect, it, vi } from "vitest";

const signal = new AbortController().signal;
const opened: CloudRunLogOpened[] = [];
afterEach(async () => {
	for (const result of opened.splice(0)) {
		await result.lines.finish(AbortSignal.abort()).catch(() => undefined);
		await result.log.close(AbortSignal.abort()).catch(() => undefined);
	}
});

type NewFolder = Extract<CloudCompanyFolderUnit, { op: "new_folder" }>;
type Write = Extract<CloudCompanyFolderUnit, { op: "write" }>;

function fixture() {
	const runId = randomUUID();
	const root = `QorperaOS/agents/scout/memory/thread/runs/${runId}`;
	const place: { -readonly [K in keyof CloudRunLogPlace]: CloudRunLogPlace[K] } = {
		path: root,
		exists: false,
		missing: ["QorperaOS/agents/scout/memory/thread/runs"],
		last: null,
		generation: 3,
		origin: { conversation: randomUUID(), parent: null, step: null, continues: null, narrow: false },
	};
	const commits: (readonly CloudCompanyFolderUnit[])[] = [];
	const folder: CloudRunLogFolder = {
		locate: vi.fn(async () => structuredClone(place)),
		read: vi.fn(async () => null),
		commit: vi.fn<CloudRunLogFolder["commit"]>(async (_key, units) => {
			commits.push(units);
			return {
				commitId: randomUUID(),
				seq: commits.length,
				replay: false,
				units: units.map((unit, index) => ({
					unit: index,
					op: unit.op,
					path: unit.op === "move" || unit.op === "copy" ? unit.from : unit.path,
					to: null,
					version: randomUUID(),
					outcome: "saved" as const,
					reason: null,
					problems: [],
				})),
			};
		}),
	};
	let context: CloudRunResumeContext | null = null;
	const resume = {
		runId,
		context: vi.fn(async () => context),
		record: vi.fn(async (request: CloudRunResumeRequest) => ({
			why: context!.why,
			stepsRead: request.stepsRead,
			unknownCalls: [],
		})),
	} satisfies CloudRunResumePort;
	const options = {
		resume,
		folder,
		log: {
			runId,
			signal,
			protection: {
				narrow: vi.fn(async () => ({ log: false, narrow: false })),
				hashes: vi.fn(async (_run: string, digests: readonly string[]) => digests),
			},
		},
		lines: {
			lane: new MemoryCompactLane(),
			call: vi.fn(async () => {
				throw new Error("Unexpected model call");
			}),
		},
	};
	const open = async () => {
		const value = await openCloudRunLog(options);
		if (value) opened.push(value);
		return value;
	};
	return {
		runId,
		root,
		place,
		commits,
		folder,
		resume,
		options,
		open,
		set context(value: CloudRunResumeContext | null) {
			context = value;
		},
	};
}

function step(result: CloudRunLogOpened): number {
	return result.log.step({ call: randomUUID(), tool: "company_read", argumentsText: "{}", argumentSha256: null });
}

describe("opening a run's work log", () => {
	it.each<[string, Partial<CloudRunLogOrigin>]>([
		["a worker", { parent: randomUUID(), step: 4 }],
		["a narrow continuation", { continues: randomUUID(), narrow: true }],
	])("starts %s's log at step 0 under the platform's origin, as an original attempt", async (_, patch) => {
		const f = fixture();
		const origin = { ...f.place.origin!, ...patch };
		f.place.origin = origin;
		const result = (await f.open())!;
		expect(f.resume.context).toHaveBeenCalledTimes(1);
		expect(f.resume.record).not.toHaveBeenCalled();
		expect(f.folder.commit).not.toHaveBeenCalled();
		expect(f.options.lines.call).not.toHaveBeenCalled();
		const j = step(result);
		expect(j).toBe(0);
		result.log.finish(j, JSON.stringify({ status: "ok", content: { text: "answer" } }), []);
		await result.log.flush(signal);
		const units = f.commits[0]!;
		const made = units.find((unit): unit is NewFolder => unit.op === "new_folder")!;
		expect(made.path).toBe(f.root);
		const text = [
			"format = 1",
			`run = "${f.runId}"`,
			`conversation = "${origin.conversation}"`,
			...(origin.parent ? [`parent = "${origin.parent}"`, `step = ${origin.step}`] : []),
			...(origin.continues ? [`continues = "${origin.continues}"`] : []),
			...(origin.narrow ? ["narrow = true"] : []),
			"",
		].join("\n");
		expect(made.contents.find((entry) => entry.path === "run.toml")).toMatchObject({
			kind: "file",
			content: { text },
		});
		const block = units.find((unit): unit is Write => unit.op === "write")!;
		expect(block.path).toBe(`${f.root}/log/00000000.jsonl`);
		expect(JSON.parse((block.content as { text: string }).text)).toMatchObject({
			j: 0,
			tool: "company_read",
			...(origin.narrow ? { narrow: true } : {}),
		});
	});

	it("keeps no log for a run in Agent notebooks or without a conversation tree, and asks nothing more", async () => {
		const f = fixture();
		vi.mocked(f.folder.locate).mockRejectedValue(new CloudRunLogUnavailable("off"));
		expect(await f.open()).toBeNull();
		expect(f.resume.context).not.toHaveBeenCalled();
		expect(f.folder.commit).not.toHaveBeenCalled();
	});

	it("ends a run whose log was made once and is no longer there, rather than go on unlogged past its steps", async () => {
		const f = fixture();
		f.context = { why: "restart", unknownReceipts: [] };
		vi.mocked(f.folder.locate).mockRejectedValue(new CloudRunLogGone());
		await expect(f.open()).rejects.toBeInstanceOf(CloudRunLogGone);
		expect(f.resume.context).not.toHaveBeenCalled();
		expect(f.folder.commit).not.toHaveBeenCalled();
	});

	it("lets a resumed attempt whose earlier attempts kept no log go on without one", async () => {
		const f = fixture();
		f.context = { why: "restart", unknownReceipts: [] };
		expect(await f.open()).toBeNull();
		expect(f.resume.record).not.toHaveBeenCalled();
		expect(f.folder.commit).not.toHaveBeenCalled();
	});

	it("continues an existing log only for a resumed attempt", async () => {
		const f = fixture();
		f.place.exists = true;
		f.place.missing = [];
		f.context = { why: "limit_reset", unknownReceipts: [] };
		const result = (await f.open())!;
		expect(f.resume.record).toHaveBeenCalledWith({ stepsRead: 0, unknownCalls: [] }, signal);
		expect(step(result)).toBe(0);

		// An original attempt would number its steps from 0 again, over the log's.
		const original = fixture();
		original.place.exists = true;
		original.place.missing = [];
		await expect(original.open()).rejects.toMatchObject({ reason: "log_exists" });
		expect(original.resume.record).not.toHaveBeenCalled();
		expect(original.folder.commit).not.toHaveBeenCalled();
	});

	it("refuses a new log without the platform's origin, another run's resume port, or a failed place", async () => {
		const f = fixture();
		f.place.origin = undefined;
		await expect(f.open()).rejects.toMatchObject({ reason: "origin_unavailable" });

		const other = fixture();
		other.options.resume = { ...other.resume, runId: randomUUID() };
		await expect(other.open()).rejects.toMatchObject({ reason: "resume_run_mismatch" });
		expect(other.folder.locate).not.toHaveBeenCalled();

		const failed = fixture();
		vi.mocked(failed.folder.locate).mockRejectedValue(new CloudRunLogUnavailable("folder_response_invalid"));
		await expect(failed.open()).rejects.toMatchObject({ reason: "folder_response_invalid" });
		expect(failed.resume.context).not.toHaveBeenCalled();

		const stopped = fixture();
		const options = { ...stopped.options, log: { ...stopped.options.log, signal: AbortSignal.abort() } };
		await expect(openCloudRunLog(options)).rejects.toBeDefined();
		expect(stopped.folder.locate).not.toHaveBeenCalled();
		for (const g of [f, other, failed, stopped]) expect(g.folder.commit).not.toHaveBeenCalled();
	});
});
