import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { assertLxdOfficeHostMount } from "../../packages/runner-orchestrator/src/lxd-office-physical-host.ts";

const [workbench, journal] = process.argv.slice(2);
assert.equal(workbench, "/srv/qorpera-office-acceptance/workbench");
assert.equal(journal, "/srv/qorpera-office-acceptance/journal");
const mounts = await readFile("/proc/self/mountinfo", "utf8");
const observations = [];
for (const path of [workbench, journal]) {
	const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const fdInfo = await readFile(`/proc/self/fdinfo/${file.fd}`, "utf8");
		const line = mounts.split("\n").find((entry) => entry.split(" ")[4] === path);
		assert(line, "Actual mount absent");
		const [filesystem, source] = line.split(" - ")[1].split(" ");
		const expected = { mountPoint: path, root: "/" as const, filesystem, source };
		if (path === workbench) {
			assert.equal(filesystem, "nfs4");
			assert.equal(source, "127.0.0.1:/");
		} else assert.equal(filesystem, "ext4");
		assertLxdOfficeHostMount(mounts, fdInfo, expected, path, path === workbench ? "127.0.0.1" : undefined);
		// A wrong source must fail even though the path still resolves successfully.
		assert.throws(() => assertLxdOfficeHostMount(mounts, fdInfo, { ...expected, source: "wrong:/" }, path));
		const info = await file.stat();
		assert.equal(info.mode & 0o7777, 0o700);
		if (path === workbench) { assert.equal(info.uid, 1100); assert.equal(info.gid, 1100); }
		observations.push({ ...expected, uid: info.uid, gid: info.gid, exactDescriptorValidated: true, wrongSourceRefused: true });
	} finally { await file.close(); }
}
console.log(JSON.stringify(observations));
