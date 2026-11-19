import { describe, expect, it } from "vitest";
import { CODING_SNAPSHOT_RPCS } from "../src/coding-snapshots.ts";

describe("coding snapshot records (5h-2)", () => {
	it("names the five RPCs the control lets through", () => {
		expect(CODING_SNAPSHOT_RPCS).toEqual([
			"qorpera_begin_coding_snapshot_build",
			"qorpera_renew_coding_snapshot_build",
			"qorpera_finish_coding_snapshot_build",
			"qorpera_list_coding_snapshots",
			"qorpera_record_coding_snapshot_removed",
		]);
	});
});
