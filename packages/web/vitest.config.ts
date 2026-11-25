import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
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

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		// Preserve styles used by DOM regressions instead of returning empty CSS mocks.
		css: { include: [/\.css\?raw$/] },
		sequence: { sequencer: TimedSequencer },
	},
});
