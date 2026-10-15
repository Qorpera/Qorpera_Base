//! Git on the mount (deploy/first-node/RUNTIME-COMPANY-FOLDER.md §6 "Git on the mount" and "The per-session cache";
//! RUNTIME-FOLDER-CODING-MACHINES.md "Code areas and git"): what a path in a code area `code/<owner>/<name>/` is to
//! git, and so what the program does with it.
//!
//! The node's folder service and the core hold the rules that decide (the leases on shared files, the version check at
//! the rename, the refusals). The program keeps the session's own git settings and hooks, and its caches, on the
//! machine's disk (`local.rs`), refuses what git must not do on the mount, and keeps git's view of the shared files
//! current: a lock git takes is answered only after the node refreshed the file it locks, and the kernel keeps none of
//! the shared files' names or pages.

use crate::proto::split;

/// The folder names a worktree's cache list starts from (§6 "The per-session cache").
pub const CACHE_NAMES: [&str; 14] = [
	"node_modules",
	".venv",
	"venv",
	"target",
	"dist",
	"build",
	".next",
	".nuxt",
	"__pycache__",
	".gradle",
	".cache",
	".turbo",
	".pytest_cache",
	"coverage",
];

/// Where a path is in a code area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place<'a> {
	/// Not in a code area's `repo.git/` or `worktrees/<worker>/`.
	Other,
	/// In the shared git directory. `area` is `code/<owner>/<name>`; `rest` is the path below `repo.git/` ("" for
	/// `repo.git` itself).
	Git { area: &'a str, rest: &'a str },
	/// In a worker's worktree. `rest` is the path below `worktrees/<worker>/` ("" for the worktree itself).
	Worktree { area: &'a str, worker: &'a str, rest: &'a str },
}

/// Where `path` is in a code area.
pub fn place(path: &str) -> Place<'_> {
	let Some(below) = path.strip_prefix("code/") else { return Place::Other };
	let mut parts = below.splitn(4, '/');
	let (Some(owner), Some(name), Some(kind)) = (parts.next(), parts.next(), parts.next()) else { return Place::Other };
	let area = &path[..5 + owner.len() + 1 + name.len()];
	let rest = parts.next();
	match kind {
		"repo.git" => Place::Git { area, rest: rest.unwrap_or("") },
		"worktrees" => {
			let Some(rest) = rest else { return Place::Other };
			let (worker, rest) = rest.split_once('/').unwrap_or((rest, ""));
			Place::Worktree { area, worker, rest }
		}
		_ => Place::Other,
	}
}

/// A git file each session keeps its own copy of on the machine's disk, never published (`rest` is below `repo.git/`):
/// the repository's `config`, `hooks/**` and `info/**`, and a worktree's `config.worktree`, with the locks git writes
/// them through. Git runs what they say, so a copy published by one session would run in every other.
pub fn session_local(rest: &str) -> bool {
	let first = rest.split('/').next().unwrap_or("");
	if matches!(rest, "config" | "config.lock") || matches!(first, "hooks" | "info") {
		return true;
	}
	let mut parts = rest.split('/');
	matches!(
		(parts.next(), parts.next(), parts.next(), parts.next()),
		(Some("worktrees"), Some(_), Some("config.worktree" | "config.worktree.lock"), None)
	)
}

/// Under `repo.git/objects` (`rest` is below `repo.git/`).
pub fn object(rest: &str) -> bool {
	rest == "objects" || rest.starts_with("objects/")
}

/// A file that would make git read objects from elsewhere: every write refused (EPERM).
pub fn alternates(rest: &str) -> bool {
	matches!(rest, "objects/info/alternates" | "objects/info/http-alternates")
}

/// A shared file other sessions change (`rest` is below `repo.git/`): everything in the git directory but objects
/// (named by their content, so never changed), the workers' own files and the session-local ones. The kernel keeps none
/// of their names, attributes or pages, so git reads what the node shows now.
pub fn shared(rest: &str) -> bool {
	!rest.is_empty() && !object(rest) && rest != "worktrees" && !rest.starts_with("worktrees/") && !session_local(rest)
}

/// The shared file a lock stands for (`rest` is below `repo.git/`): `X` for `X.lock`, where `X` is a ref (`refs/**`),
/// `packed-refs` or `shallow`. Its exclusive create takes the lease on `X`. The core leases nothing else (5b).
pub fn locked(rest: &str) -> Option<&str> {
	let target = rest.strip_suffix(".lock")?;
	let ok = matches!(target, "packed-refs" | "shallow") || target.starts_with("refs/");
	ok.then_some(target)
}

/// The paths git reads under a lock it took on `area`'s `target` (below `repo.git/`): the file, its reflog and
/// `packed-refs`, which the node refreshed before the lock's create returned.
pub fn refreshed(area: &str, target: &str) -> [String; 3] {
	[
		format!("{area}/repo.git/{target}"),
		format!("{area}/repo.git/logs/{target}"),
		format!("{area}/repo.git/packed-refs"),
	]
}

/// A worktree's path (`code/<owner>/<name>/worktrees/<worker>`) and its index's
/// (`code/<owner>/<name>/repo.git/worktrees/<worker>/index`).
pub fn worktree(area: &str, worker: &str) -> (String, String) {
	(format!("{area}/worktrees/{worker}"), format!("{area}/repo.git/worktrees/{worker}/index"))
}

/// The worktree whose index `path` is, if it is one.
pub fn index_of(path: &str) -> Option<String> {
	let Place::Git { area, rest } = place(path) else { return None };
	let (dir, name) = split(rest);
	let worker = dir.strip_prefix("worktrees/").filter(|w| !w.is_empty() && !w.contains('/'))?;
	(name == "index").then(|| worktree(area, worker).0)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn places() {
		assert_eq!(place("docs/a"), Place::Other);
		assert_eq!(place("code/o/n"), Place::Other);
		assert_eq!(place("code/o/n/main/a"), Place::Other);
		assert_eq!(place("code/o/n/repo.git"), Place::Git { area: "code/o/n", rest: "" });
		assert_eq!(place("code/o/n/repo.git/refs/heads/x"), Place::Git { area: "code/o/n", rest: "refs/heads/x" });
		assert_eq!(place("code/o/n/worktrees"), Place::Other);
		assert_eq!(place("code/o/n/worktrees/w"), Place::Worktree { area: "code/o/n", worker: "w", rest: "" });
		assert_eq!(
			place("code/o/n/worktrees/w/a/node_modules/x"),
			Place::Worktree { area: "code/o/n", worker: "w", rest: "a/node_modules/x" }
		);
	}

	#[test]
	fn classes() {
		for rest in ["config", "config.lock", "hooks", "hooks/pre-commit", "info/exclude", "worktrees/w/config.worktree"] {
			assert!(session_local(rest), "{rest}");
			assert!(!shared(rest), "{rest}");
		}
		for rest in ["configs", "worktrees/w/config", "worktrees/w/index", "objects/info/x"] {
			assert!(!session_local(rest), "{rest}");
		}
		for rest in ["refs/heads/x", "packed-refs", "HEAD", "logs/refs/heads/x", "shallow", "FETCH_HEAD"] {
			assert!(shared(rest), "{rest}");
		}
		for rest in ["", "objects", "objects/ab/cd", "worktrees", "worktrees/w/HEAD"] {
			assert!(!shared(rest), "{rest}");
		}
		assert!(alternates("objects/info/alternates") && alternates("objects/info/http-alternates"));
		assert!(!alternates("objects/info/packs"));
		assert_eq!(locked("refs/heads/x.lock"), Some("refs/heads/x"));
		assert_eq!(locked("packed-refs.lock"), Some("packed-refs"));
		assert_eq!(locked("HEAD.lock"), None);
		assert_eq!(locked("worktrees/w/index.lock"), None);
		assert_eq!(locked("config.lock"), None);
		assert_eq!(locked("refs/heads/x"), None);
	}

	#[test]
	fn indexes() {
		assert_eq!(index_of("code/o/n/repo.git/worktrees/w/index"), Some("code/o/n/worktrees/w".to_string()));
		assert_eq!(index_of("code/o/n/repo.git/worktrees/w/index.lock"), None);
		assert_eq!(index_of("code/o/n/repo.git/index"), None);
		assert_eq!(index_of("code/o/n/repo.git/worktrees/w/x/index"), None);
		assert_eq!(worktree("code/o/n", "w").1, "code/o/n/repo.git/worktrees/w/index");
	}
}
