/** The native host's side of the run box proof (scripts/test-run-box-systemd.mjs), bundled into one file and run in
 * the disposable systemd container as the slot's native host account: this repository's exec_command and write_stdin
 * against the real box and its read log, with the folder core's release replaced by a recorder. Prints what the tools
 * answered and what they released, as JSON. */
import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyFolderClient, CloudCompanyFolderRelease } from "../../packages/runtime/src/cloud-company-folder-client.ts";
import type { CloudToolContext } from "../../packages/runtime/src/cloud-native-tool-boundary.ts";
import { CloudRunBox, cloudRunBoxTools } from "../../packages/runtime/src/cloud-run-box-tools.ts";

const RUN = "80200000-0000-4000-8000-000000000001";
const releases: { id: string; paths: string[]; revisions: number[]; sha: string }[] = [];
const folder = {
	async release(id: string, reads: readonly CloudCompanyFolderRelease[], sha: string) {
		releases.push({
			id,
			paths: reads.map((read) => read.path),
			revisions: reads.map((read) => read.authority.resourceRevision),
			sha,
		});
		return { releaseId: id, reads: reads.length, replay: false };
	},
} as unknown as CloudCompanyFolderClient;
const [exec, write] = cloudRunBoxTools({
	box: new CloudRunBox({ socket: "/run/qorpera-shared-box/0.sock", reads: "/run/qorpera-shared-box/0.reads" }),
	folder,
	runId: RUN,
});
if (!exec || !write) throw new Error("The run box tools are missing");
let call = 0;
const context = (): CloudToolContext => ({
	companyId: "80200000-0000-4000-8000-000000000002",
	runId: RUN,
	callId: `e2e-${++call}`,
	argumentSha256: "a".repeat(64),
	signal: new AbortController().signal,
});
const run = async (tool: typeof exec, args: JsonValue) => {
	const content = await tool.execute(tool.parseArguments(args), context());
	return { text: content.value as string, companyReadId: content.companyReadId ?? null };
};

const read = await run(exec, { cmd: "cat docs/plan.md; ls docs" });
const started = await run(exec, { cmd: "sleep 2; echo late", yield_time_ms: 300 });
const session = Number(/session ID (\d+)/.exec(started.text)?.[1]);
const finished = await run(write, { session_id: session, yield_time_ms: 10_000 });
const long = await run(exec, { cmd: "seq 1 100000" });
// The box connection stays open for the run's next call; this check is done.
process.stdout.write(`${JSON.stringify({ read, started, finished, long, releases })}\n`, () => process.exit(0));
