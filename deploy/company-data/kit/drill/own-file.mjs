// A file the drill writes where someone else's could be (the kit's .env): made only if none is there, and removed only
// while it still holds exactly what this run wrote. Two drills, or a drill and a person, never remove each other's.
import { readFileSync, rmSync, writeFileSync } from "node:fs";

/** Writes `text` to `path` only if no file is there (it throws EEXIST otherwise, and nothing is written). Gives the
 * function that removes it, once, and only if it still holds `text`; that function says whether it removed it. */
export function claimFile(path, text) {
	writeFileSync(path, text, { flag: "wx", mode: 0o600 });
	let mine = true;
	return () => {
		if (!mine) return false;
		mine = false;
		let now;
		try {
			now = readFileSync(path, "utf8");
		} catch {
			return false;
		}
		if (now !== text) return false;
		rmSync(path);
		return true;
	};
}
