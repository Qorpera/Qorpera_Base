import assert from "node:assert/strict";
import test from "node:test";
import { foundingNativePreparation } from "./founding-native-prepare.mjs";

const config = {
	schema: "qorpera.founding-native-preparation/v1",
	disposableHost: true,
	account: "acceptance",
	uid: 1001,
	gid: 1001,
	workRoot: "/opt/qorpera-founding-test",
	out: "/tmp/founding-evidence",
	binDirectory: "/usr/lib/postgresql/17/bin",
	tools: "/opt/founding-tools",
	guestPackage: "/opt/current-guest-package",
	guestPackageSha256: "a".repeat(64),
	ubuntuImageFingerprint: "b".repeat(64),
	storagePool: "default",
};

test("joined preparation requires explicit current pinned artifacts and dedicated private staging", () => {
	assert.deepEqual(foundingNativePreparation(config), config);
	for (const override of [
		{ disposableHost: false },
		{ uid: 0 },
		{ account: "root; command" },
		{ guestPackageSha256: "latest" },
		{ ubuntuImageFingerprint: "ubuntu:26.04" },
		{ workRoot: "/opt/production" },
		{ out: "/opt/qorpera-founding-test/public" },
		{ guestPackage: "/tmp/../package" },
		{ billingKey: "secret" },
	])
		assert.throws(() => foundingNativePreparation({ ...config, ...override }));
	const detached = foundingNativePreparation(config);
	detached.uid = 0;
	assert.equal(config.uid, 1001);
});
