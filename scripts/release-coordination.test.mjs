import assert from "node:assert/strict";
import test from "node:test";
import {
	checkReleaseSpacing,
	checkSourceSynced,
	checkVersionMonotonic,
	claimDecision,
	compareVersions,
} from "./release-coordination.mjs";

test("compareVersions orders dotted versions numerically and tolerates a v prefix", () => {
	assert.equal(compareVersions("0.18.4", "0.18.5"), -1);
	assert.equal(compareVersions("v0.18.5", "0.18.4"), 1);
	assert.equal(compareVersions("0.18.5", "v0.18.5"), 0);
	assert.equal(compareVersions("0.18.10", "0.18.9"), 1); // numeric, not lexicographic
	assert.equal(compareVersions("0.19.0", "0.18.99"), 1);
	assert.equal(compareVersions("0.18", "0.18.0"), 0);
	assert.throws(() => compareVersions("abc", "0.1.0"));
});

test("checkSourceSynced blocks stale checkouts and dirty trees, allows exact origin/master", () => {
	const head = "a".repeat(40);
	const moved = "b".repeat(40);
	assert.equal(checkSourceSynced({ head, originMaster: head, dirty: false, allowUnsynced: false }).ok, true);

	const stale = checkSourceSynced({ head, originMaster: moved, dirty: false, allowUnsynced: false });
	assert.equal(stale.ok, false);
	assert.match(stale.reason, /origin\/master/);

	const dirty = checkSourceSynced({ head, originMaster: head, dirty: true, allowUnsynced: false });
	assert.equal(dirty.ok, false);
	assert.match(dirty.reason, /uncommitted/);

	const escape = checkSourceSynced({ head, originMaster: moved, dirty: true, allowUnsynced: true });
	assert.equal(escape.ok, true);
	assert.match(escape.warning, /--allow-unsynced/);
});

test("checkVersionMonotonic requires strictly newer versions than the published latest", () => {
	assert.equal(checkVersionMonotonic("0.18.6", "v0.18.5").ok, true);
	assert.equal(checkVersionMonotonic("0.18.6", undefined).ok, true); // first release ever

	// The 2026-08-12 race, replayed: cutting 0.18.4 after 0.18.5 exists.
	const stale = checkVersionMonotonic("0.18.4", "v0.18.5");
	assert.equal(stale.ok, false);
	assert.match(stale.reason, /not newer/);
	assert.equal(checkVersionMonotonic("0.18.5", "v0.18.5").ok, false); // duplicates too
});

test("checkReleaseSpacing enforces the cooling window unless --allow-rapid", () => {
	const now = Date.parse("2026-08-12T21:00:00Z");
	const fresh = { publishedAtIso: "2026-08-12T20:52:04Z", nowMs: now, allowRapid: false };
	const blocked = checkReleaseSpacing(fresh);
	assert.equal(blocked.ok, false);
	assert.match(blocked.reason, /cooling window/);

	assert.equal(checkReleaseSpacing({ ...fresh, allowRapid: true }).ok, true);
	assert.equal(
		checkReleaseSpacing({ publishedAtIso: "2026-08-12T20:00:00Z", nowMs: now, allowRapid: false }).ok,
		true, // an hour old — outside the window
	);
	assert.equal(checkReleaseSpacing({ publishedAtIso: undefined, nowMs: now, allowRapid: false }).ok, true);
	assert.equal(checkReleaseSpacing({ publishedAtIso: "garbage", nowMs: now, allowRapid: false }).ok, true);
});

test("claimDecision claims free versions, recognizes retries, and reports conflicts", () => {
	const head = "c".repeat(40);
	assert.equal(claimDecision({ remoteSha: undefined, head }).action, "claim");
	assert.equal(claimDecision({ remoteSha: head, head }).action, "ours");

	const conflict = claimDecision({ remoteSha: "d".repeat(40), head });
	assert.equal(conflict.action, "conflict");
	assert.match(conflict.reason, /another session/);
});
