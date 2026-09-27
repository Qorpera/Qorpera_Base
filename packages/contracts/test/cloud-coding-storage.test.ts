import { describe, expect, it } from "vitest";
import {
	createCloudCodingStorageBinding,
	parseCloudCodingNasPolicy,
	parseCloudCodingStorageBinding,
} from "../src/cloud-coding-storage.ts";

const policy = {
	schema: "qorpera.coding-nas-policy/v1" as const,
	mountPoint: "/srv/coding",
	rootPath: "/srv/coding/executor",
	source: "192.168.1.40:/coding",
	serverAddress: "192.168.1.40",
};
const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const scope = {
	workerId: id(1),
	companyId: id(2),
	environmentId: id(3),
	machineIdSha256: "a".repeat(64),
	writerGeneration: 1,
};
describe("coding NAS identity contracts", () => {
	it("derives isolated stable volume paths from the immutable worker scope", () => {
		const binding = createCloudCodingStorageBinding(policy, scope);
		expect(binding.volumeId).toBe(scope.workerId);
		expect(binding.dataSource).toBe(`/srv/coding/executor/workers/${id(2)}/${id(3)}/${id(1)}/data`);
		expect(parseCloudCodingStorageBinding(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
		expect(Object.isFrozen(binding.policy)).toBe(true);
	});
	it.each([
		"/srv/coding/../other",
		"/srv/coding/",
		"/srv/coding//x",
		"/srv/coding/./x",
		"/srv/coding/a b",
		"/srv/coding/a\\b",
		"/srv/coding-sibling",
		"/",
	])("rejects unsafe root %s", (rootPath) => {
		expect(() => parseCloudCodingNasPolicy({ ...policy, rootPath })).toThrow();
	});
	it("rejects arbitrary host storage and noncanonical NAS addresses", () => {
		for (const update of [
			{ source: "/local" },
			{ source: "192.168.1.41:/coding" },
			{ serverAddress: "192.168.001.40" },
			{ serverAddress: "999.168.1.40" },
			{ credential: "secret" },
		])
			expect(() => parseCloudCodingNasPolicy({ ...policy, ...update })).toThrow();
	});
	it("rejects a changed worker, sibling source, mount target or authority field", () => {
		const binding = createCloudCodingStorageBinding(policy, scope);
		for (const update of [
			{ workerId: id(5) },
			{ volumeId: id(5) },
			{ dataSource: "/srv/coding/other" },
			{ dataTarget: "/" },
			{ custodySource: binding.dataSource },
			{ writerGeneration: 0 },
			{ machineIdSha256: "" },
			{ token: "secret" },
		])
			expect(() => parseCloudCodingStorageBinding({ ...binding, ...update })).toThrow();
	});
});
