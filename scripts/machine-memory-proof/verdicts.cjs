// What scripts/machine-memory-proof/pages.cjs decides with, kept apart from the browser so it can be tested without
// one (scripts/prove-machine-memory.test.mjs): what an error on a tab means, and whether the tabs phase did what it
// is for.
//
// Past the edge of its memory a machine ends browser tabs: that is the guard's first choice, by design, and Chromium
// shows "Aw, Snap!" in each. A tab that was ended is therefore never a failure of the proof. The browser itself being
// gone is: with its main process every tab is gone.

/** What an error on one tab means:
 * - "browser": the browser no longer answers on its debugging port. The failure, whatever the error says.
 * - "tab": the guard ended this tab (its page crashed while the browser still answers). Expected past the edge.
 * - "other": the tab failed for another reason (a load that never came, no answer in time, the network). */
function whatEnded({ crashed, message, browserAnswers }) {
	if (!browserAnswers) return "browser";
	if (crashed || /\bcrash/i.test(String(message ?? ""))) return "tab";
	return "other";
}

/** Whether the tabs phase did what it is for: undefined when it did, else why not.
 * - No tab may fail for another reason than being ended.
 * - Past the edge (`past`), the phase is over once three tabs were ended (`stop` "ended"). Stopping for anything else
 *   (its limit of tabs, tabs failing in a row) means the edge was not reached.
 * - Before the edge, it is over at its limit of tabs ("limit") or when the machine is nearly full ("room"). A tab the
 *   guard ended on the way is said in the phase's numbers, never failed. */
function tabsVerdict({ past, stop, ended, failures }) {
	if (failures.length)
		return `${failures.length} tab(s) failed for another reason than being ended; the first: ${failures[0]}`;
	if (past && stop !== "ended")
		return `it stopped at "${stop}" with ${ended} tab(s) ended: past the edge three are to be ended`;
	if (!past && stop !== "limit" && stop !== "room") return `it stopped at "${stop}"`;
	return undefined;
}

module.exports = { tabsVerdict, whatEnded };
