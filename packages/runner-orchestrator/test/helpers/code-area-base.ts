import type { CloudCodingRepository } from "@qorpera/contracts";
import { type CodeHostJob, withJob } from "../../src/code-host-jobs.ts";

export async function readCodeAreaBase(job: CodeHostJob, repository: CloudCodingRepository): Promise<string | null> {
	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (!area.seeded || area.main !== "present") return null;
		const base = await run.ref(`refs/heads/${repository.baseBranch}`);
		return base && (await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${base}\n`))
			? base
			: null;
	});
}
