import assert from "node:assert/strict";
import test from "node:test";
import { classifyCodingStorageProbe, parseCodingStorageProbeArguments } from "./coding-storage-probe-contract.mjs";

test("keeps root-squashed default and requires explicit bounded positive-control policy", () => {
  assert.deepEqual(parseCodingStorageProbeArguments(["--out", "/tmp/probe"]), {
    out: "/tmp/probe", exportPolicy: "root-squashed", squashOption: "root_squash",
  });
  assert.deepEqual(parseCodingStorageProbeArguments(["--out", "/tmp/probe", "--export-policy", "identity-preserving"]), {
    out: "/tmp/probe", exportPolicy: "identity-preserving", squashOption: "no_root_squash",
  });
  for (const args of [[], ["--out", ""], ["--out", "/tmp/probe", "--export-policy"],
    ["--out", "/tmp/probe", "--export-policy", "no_root_squash,all_squash"],
    ["--out", "/tmp/probe", "--server", "identity-preserving"]])
    assert.throws(() => parseCodingStorageProbeArguments(args));
});

function report() {
  const workerId = "11111111-1111-4111-8111-111111111111", data = `/workspace/${workerId}`, custody = `/var/lib/qorpera-coding/${workerId}`;
  const ownership = { [data]: { uid: 1100, gid: 1100, mode: 0o755 }, [custody]: { uid: 1100, gid: 1100, mode: 0o755 } };
  for (const name of ["repository", "home", "cache"]) ownership[`${data}/${name}`] = { uid: 200000, gid: 200000, mode: 0o700 };
  for (const name of ["inbox", "git", "commands", "logs"]) ownership[`${custody}/${name}`] = { uid: 0, gid: 0, mode: 0o755 };
  return { schema: "qorpera.coding-storage-guest-probe/v1", workerId, uid: 0, sessionUid: 200000, ownership,
    mountInfo: `1 0 0:1 / ${data} rw - virtiofs data rw\n2 0 0:2 / ${custody} rw - virtiofs custody rw`, observations: {
      initialize: { status: 1, stderr: "CODING_GUEST_STORAGE_REFUSED ERRNO:EACCES" },
      gitPrepare: { status: 1, stderr: "CODING_GIT_GUEST_REFUSED" },
      rootCustodyCreate: { succeeded: false, code: "EACCES" }, sessionWrite: { status: 0, stdout: "session-write-ok" },
    } };
}
test("classifies root-only refusal only alongside actual session write and exact protected ownership", () => {
  assert.deepEqual(classifyCodingStorageProbe(report()), { observed: true, compatible: false, code: "ROOT_CODING_CUSTODY_UNWRITABLE" });
});
test("does not turn unrelated helper or mount failures into a proven storage diagnosis", () => {
  for (const mutate of [
    (r) => { r.observations.initialize.stderr = "CODING_GUEST_STORAGE_REFUSED RUNNER_IMAGE_SELF_UPDATE_ENABLED"; },
    (r) => { r.observations.gitPrepare.status = null; },
    (r) => { r.observations.rootCustodyCreate.code = "EIO"; },
    (r) => { r.observations.sessionWrite.status = 1; },
    (r) => { r.mountInfo = r.mountInfo.replaceAll("virtiofs", "9p"); },
    (r) => { r.ownership[`/var/lib/qorpera-coding/${r.workerId}/git`].mode = 0o777; },
  ]) { const value = report(); mutate(value); assert.throws(() => classifyCodingStorageProbe(value)); }
});
test("accepts compatibility only when both unchanged helpers and root-owned creation succeed", () => {
  const value = report(); value.observations.initialize.status = 0; value.observations.gitPrepare.status = 0;
  value.observations.rootCustodyCreate = { succeeded: true, uid: 0 };
  assert.equal(classifyCodingStorageProbe(value).compatible, true);
  value.observations.rootCustodyCreate.uid = 65534;
  assert.throws(() => classifyCodingStorageProbe(value));
});
