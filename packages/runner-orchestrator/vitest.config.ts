import { mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import base from "../../vitest.base.ts";
import { slowestSpecsFirst, timedSpecs } from "./test/helpers/timed-shards.ts";

/** `--shard=k/n` by time (timedSpecs), not vitest's by a hash of each path: `changed` runs this package as two steps,
 * --shard=1/2 and 2/2, and by hash one got 573 s of the rest's file time and the other 397 s (8 Nov, perf T10), so one
 * waited on the other. Within a run, the slowest files start first. */
class TimedSequencer extends BaseSequencer {
	async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
		const shard = this.ctx.config.shard;
		return shard ? timedSpecs(files, this.ctx.config.root, shard.index, shard.count) : files;
	}
	async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		return slowestSpecsFirst(await super.sort(files), this.ctx.config.root);
	}
}

export default mergeConfig(base, {
	test: {
		testTimeout: 30_000,
		sequence: { sequencer: TimedSequencer },
	},
});
