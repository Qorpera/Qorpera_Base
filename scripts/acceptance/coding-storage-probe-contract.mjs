import assert from "node:assert/strict";

export function parseCodingStorageProbeArguments(args) {
  assert(args.length === 2 || args.length === 4, "Expected --out PATH [--export-policy root-squashed|identity-preserving]");
  assert.equal(args[0], "--out");
  assert.equal(typeof args[1], "string");
  assert(args[1].length > 0);
  const exportPolicy = args.length === 4 ? args[3] : "root-squashed";
  if (args.length === 4) assert.equal(args[2], "--export-policy");
  assert(["root-squashed", "identity-preserving"].includes(exportPolicy), "Unsupported diagnostic export policy");
  return { out: args[1], exportPolicy, squashOption: exportPolicy === "root-squashed" ? "root_squash" : "no_root_squash" };
}

/** No infrastructure failure is classified as proof of root-squash behavior. */
export function classifyCodingStorageProbe(report) {
  assert.equal(report.schema, "qorpera.coding-storage-guest-probe/v1");
  assert.equal(report.uid, 0);
  assert.equal(report.sessionUid, 200000);
  const data = `/workspace/${report.workerId}`, custody = `/var/lib/qorpera-coding/${report.workerId}`;
  for (const root of [data, custody]) {
    assert.deepEqual(report.ownership[root], { uid: 1100, gid: 1100, mode: 0o755 });
    assert(report.mountInfo.split("\n").some((line) => line.includes(` ${root} `) && line.includes(" - virtiofs ")));
  }
  for (const name of ["repository", "home", "cache"])
    assert.deepEqual(report.ownership[`${data}/${name}`], { uid: 200000, gid: 200000, mode: 0o700 });
  for (const name of ["inbox", "git", "commands", "logs"])
    assert.deepEqual(report.ownership[`${custody}/${name}`], { uid: 0, gid: 0, mode: 0o755 });
  assert.equal(report.observations.sessionWrite.status, 0, "Session data write must prove a usable writable mount");
  assert.equal(report.observations.sessionWrite.stdout, "session-write-ok");
  const { rootCustodyCreate, initialize, gitPrepare } = report.observations;
  if (rootCustodyCreate.succeeded === false && ["EACCES", "EPERM"].includes(rootCustodyCreate.code) &&
    initialize.status === 1 && /^CODING_GUEST_STORAGE_REFUSED ERRNO:(EACCES|EPERM)$/.test(initialize.stderr) &&
    gitPrepare.status === 1 && gitPrepare.stderr === "CODING_GIT_GUEST_REFUSED") {
    return { observed: true, compatible: false, code: "ROOT_CODING_CUSTODY_UNWRITABLE" };
  }
  if (rootCustodyCreate.succeeded === true && rootCustodyCreate.uid === 0 && initialize.status === 0 && gitPrepare.status === 0)
    return { observed: true, compatible: true, code: "PRODUCTION_HELPERS_ACCEPTED" };
  throw new Error("CODING_STORAGE_PROBE_INCONCLUSIVE");
}
