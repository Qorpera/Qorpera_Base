/**
 * Release-lane coordination for shell releases (publish-shell-release.mjs).
 *
 * The footgun this exists for: parallel agent sessions each cutting a release
 * race each other. On 2026-08-12, 0.18.4 and 0.18.5 shipped 48 minutes apart
 * from two sessions that didn't know about each other — the freshly installed
 * 0.18.4 auto-updated away seconds later, and only luck ordered the versions
 * correctly. Three guards serialize the lane:
 *
 *   1. Freshness — the packed build must come from a clean checkout sitting
 *      exactly at origin/master. A stale worktree cannot publish.
 *   2. Claim — before the release exists, a `shell-v<version>` tag is pushed
 *      to the SOURCE repo at the release commit. Tag creation on the remote
 *      is atomic: exactly one session wins a version; the loser is told to
 *      rebase, take the next version, and rebuild. The tag doubles as
 *      permanent provenance (which commit produced which installer).
 *   3. Monotonic + spaced — the version must be strictly newer than the
 *      latest published release, and a release younger than the cooling
 *      window blocks a new cut (batch with it instead) unless --allow-rapid.
 *
 * This module holds the pure decision logic so it can be tested without git,
 * gh, or a network; publish-shell-release.mjs wires it to the real world.
 */

export const RELEASE_COOLING_MINUTES = 30;

/** Numeric dotted-version compare: -1, 0, 1. Tolerates a leading "v". */
export function compareVersions(a, b) {
	const parse = (value) => String(value).replace(/^v/, "").split(".").map(Number);
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const l = left[i] ?? 0;
		const r = right[i] ?? 0;
		if (Number.isNaN(l) || Number.isNaN(r)) throw new Error(`unparseable version: ${a} vs ${b}`);
		if (l !== r) return l < r ? -1 : 1;
	}
	return 0;
}

/**
 * Guard 1 — the build must be publishable source: clean tree, exactly at
 * origin/master. `allowUnsynced` is the loud emergency escape hatch.
 */
export function checkSourceSynced({ head, originMaster, dirty, allowUnsynced }) {
	if (allowUnsynced) {
		return { ok: true, warning: "--allow-unsynced: publishing without the origin/master freshness guard" };
	}
	if (dirty) {
		return {
			ok: false,
			reason:
				"the source tree has uncommitted changes — the packed installer may not match any commit. Commit or stash, rebuild with pack:shell, then publish (or pass --allow-unsynced in an emergency).",
		};
	}
	if (head !== originMaster) {
		return {
			ok: false,
			reason:
				"HEAD is not origin/master — another session may have landed work (or a release) since this build. Fetch, rebase or fast-forward onto origin/master, rebuild with pack:shell, then publish (or pass --allow-unsynced in an emergency).",
		};
	}
	return { ok: true };
}

/**
 * Guard 3a — versions only move forward relative to the releases repo.
 * `latestTag` is undefined when no release exists yet.
 */
export function checkVersionMonotonic(version, latestTag) {
	if (latestTag === undefined) return { ok: true };
	if (compareVersions(version, latestTag) > 0) return { ok: true };
	return {
		ok: false,
		reason: `version ${version} is not newer than the latest published release (${latestTag}) — another session likely released while you built. Fetch master, bump past ${latestTag}, rebuild, retry.`,
	};
}

/**
 * Guard 3b — a release younger than the cooling window blocks a new cut so
 * back-to-back updates get batched instead of leapfrogging the user's
 * auto-updater. `publishedAtIso` is undefined when no release exists yet.
 */
export function checkReleaseSpacing({ publishedAtIso, nowMs, allowRapid, coolingMinutes = RELEASE_COOLING_MINUTES }) {
	if (publishedAtIso === undefined || allowRapid) return { ok: true };
	const publishedMs = Date.parse(publishedAtIso);
	if (Number.isNaN(publishedMs)) return { ok: true };
	const ageMinutes = (nowMs - publishedMs) / 60_000;
	if (ageMinutes >= coolingMinutes) return { ok: true };
	return {
		ok: false,
		reason: `the latest release shipped ${Math.max(0, Math.round(ageMinutes))} minutes ago (cooling window: ${coolingMinutes}m) — fold this into the next batch, or pass --allow-rapid if this must ship now (hotfix for a broken release).`,
	};
}

/**
 * Guard 2 — decide what to do about the claim tag. `remoteSha` is the sha the
 * remote `shell-v<version>` tag points at (undefined if unclaimed).
 * Returns "claim" (push it), "ours" (our earlier attempt at this exact
 * commit — a retry, proceed without pushing), or "conflict".
 */
export function claimDecision({ remoteSha, head }) {
	if (remoteSha === undefined) return { action: "claim" };
	if (remoteSha === head) return { action: "ours" };
	return {
		action: "conflict",
		reason: `already claimed at ${remoteSha.slice(0, 9)} by another session — fetch master, bump the version on top, rebuild, retry.`,
	};
}
