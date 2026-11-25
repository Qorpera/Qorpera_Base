import { mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import base from "../../vitest.base.ts";
import { slowestSpecsFirst, timedSpecs } from "./test/helpers/timed-shards.ts";

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
