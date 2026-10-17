//! Git's ignore rules, for the machine caches (deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md, rule 4): a new file
//! or folder in a git worktree is a machine cache when git ignores it. This parses a `.gitignore` or `info/exclude`
//! and decides a path as git 2.56 does: `Documentation/gitignore.adoc`, and where git's code says more, `dir.c`
//! (`add_patterns_from_buffer`, `trim_trailing_spaces`, `parse_path_pattern`, `match_basename`, `match_pathname`,
//! `prep_exclude`, `last_matching_pattern`) and `wildmatch.c`, ported as they are.
//!
//! The caller reads the files. Git opens a `.gitignore` without following a symlink, so a symlinked one counts as
//! none; `core.excludesFile` does not count here, and matching is case-sensitive (`core.ignoreCase` false).

/// Git leaves out an ignore file this large or larger (`PATTERN_MAX_FILE_SIZE`, with the newline git adds).
pub const MAX_FILE: usize = 100 * 1024 * 1024;

/// One ignore file's patterns (a `.gitignore`, or `info/exclude`), in its order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Patterns {
	patterns: Vec<Pattern>,
}

/// One pattern line, as git's `parse_path_pattern` leaves it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Pattern {
	/// The pattern without its `!` and its trailing `/`.
	text: Vec<u8>,
	/// How many bytes at its start hold no wildcard (`nowildcardlen`).
	literal: usize,
	/// A `!` pattern, which takes a path back.
	negative: bool,
	/// A trailing `/`: it matches folders only.
	folder_only: bool,
	/// No other `/`: it matches the path's last name, at any depth.
	name_only: bool,
	/// A `*` and then no wildcard: the last name only has to end with the rest.
	ends_with: bool,
}

impl Patterns {
	/// Parses the file's bytes (not UTF-8 checked: patterns and paths are bytes).
	pub fn parse(text: &[u8]) -> Patterns {
		if text.len() >= MAX_FILE {
			return Patterns::default();
		}
		let text = text.strip_prefix(b"\xef\xbb\xbf").unwrap_or(text);
		let patterns = text
			.split(|&byte| byte == b'\n')
			.filter(|line| !matches!(line.first(), None | Some(b'#')))
			.map(|line| {
				let line = line.strip_suffix(b"\r").unwrap_or(line);
				let line = line.split(|&byte| byte == 0).next().unwrap_or(line);
				Pattern::new(trim_trailing_spaces(line))
			})
			.collect();
		Patterns { patterns }
	}

	/// The last pattern in the file that matches `path`, a path relative to the file's folder (`/`-separated, no
	/// leading or trailing `/`), which is a folder when `folder`: Some(true) when it ignores it, Some(false) when it is
	/// a negated one (`!`) that takes it back, None when none matches.
	pub fn decide(&self, path: &str, folder: bool) -> Option<bool> {
		let path = path.as_bytes();
		if path.is_empty() {
			return None;
		}
		let name = path.rsplit(|&byte| byte == b'/').next().unwrap_or(path);
		self.patterns.iter().rev().find(|pattern| pattern.matches(path, name, folder)).map(|pattern| !pattern.negative)
	}
}

/// Whether git ignores `path` in a worktree (relative to its top, `/`-separated, no leading or trailing `/`), a
/// folder when `folder`. `gitignore(dir)` gives the `.gitignore` in the worktree's folder `dir` ("" for the top),
/// None when there is none (a reference to it, or a shared one); `exclude` is the repository's `info/exclude`.
///
/// Each folder on the way down is decided first, with the files above it: once one is ignored, so is everything
/// under it, and the `.gitignore` files inside it are not asked for (git's `prep_exclude`).
pub fn ignored<P: std::ops::Deref<Target = Patterns>>(
	path: &str,
	folder: bool,
	mut gitignore: impl FnMut(&str) -> Option<P>,
	exclude: Option<&Patterns>,
) -> bool {
	if path.is_empty() {
		return false;
	}
	let mut files = Vec::new();
	if let Some(file) = gitignore("") {
		files.push((0, file));
	}
	for (end, _) in path.match_indices('/') {
		let dir = &path[..end];
		if decided(dir, true, &files, exclude) == Some(true) {
			return true;
		}
		if let Some(file) = gitignore(dir) {
			files.push((end + 1, file));
		}
	}
	decided(path, folder, &files, exclude) == Some(true)
}

/// The first answer from the `.gitignore` files, deepest first (each with where its folder's part of `path` starts),
/// then from `info/exclude` (git's `last_matching_pattern_from_lists`).
fn decided<P: std::ops::Deref<Target = Patterns>>(
	path: &str,
	folder: bool,
	files: &[(usize, P)],
	exclude: Option<&Patterns>,
) -> Option<bool> {
	files
		.iter()
		.rev()
		.find_map(|(start, file)| file.decide(path.get(*start..)?, folder))
		.or_else(|| exclude?.decide(path, folder))
}

impl Pattern {
	/// Git's `parse_path_pattern` of one line, its comment and trailing spaces already gone.
	fn new(line: &[u8]) -> Pattern {
		let (negative, line) = match line.strip_prefix(b"!") {
			Some(rest) => (true, rest),
			None => (false, line),
		};
		let (folder_only, text) = match line.strip_suffix(b"/") {
			Some(text) => (true, text),
			None => (false, line),
		};
		let ends_with = match text.split_first() {
			Some((b'*', rest)) => simple_length(rest) == rest.len(),
			_ => false,
		};
		Pattern {
			literal: simple_length(text),
			name_only: !text.contains(&b'/'),
			ends_with,
			text: text.to_vec(),
			negative,
			folder_only,
		}
	}

	/// Whether it matches `path`, whose last name is `name` (git's `last_matching_pattern_from_list`, one pattern).
	fn matches(&self, path: &[u8], name: &[u8], folder: bool) -> bool {
		if self.folder_only && !folder {
			return false;
		}
		if self.name_only {
			self.matches_name(name)
		} else {
			self.matches_path(path)
		}
	}

	/// Git's `match_basename`.
	fn matches_name(&self, name: &[u8]) -> bool {
		if self.literal == self.text.len() {
			name == self.text.as_slice()
		} else if self.ends_with {
			self.text.get(1..).is_some_and(|rest| name.ends_with(rest))
		} else {
			wildmatch(&self.text, name, false)
		}
	}

	/// Git's `match_pathname`, for a path relative to the pattern's folder.
	fn matches_path(&self, path: &[u8]) -> bool {
		let (mut pattern, literal) = match self.text.strip_prefix(b"/") {
			Some(rest) => (rest, self.literal.saturating_sub(1)),
			None => (self.text.as_slice(), self.literal),
		};
		let mut path = path;
		if path.is_empty() {
			return false;
		}
		if literal > 0 {
			if literal > path.len() || pattern.get(..literal) != path.get(..literal) {
				return false;
			}
			if pattern.len() == literal && path.len() == literal {
				return true;
			}
			// Git keeps the literal start's last byte, so that wildmatch sees where a name starts.
			pattern = rest(pattern, literal - 1);
			path = rest(path, literal - 1);
		}
		wildmatch(pattern, path, true)
	}
}

/// Git's `trim_trailing_spaces`: drops the trailing spaces (not tabs) that no backslash quotes.
fn trim_trailing_spaces(line: &[u8]) -> &[u8] {
	let mut last_space = None;
	let mut at = 0;
	while at < line.len() {
		match line[at] {
			b' ' => {
				last_space = last_space.or(Some(at));
			}
			b'\\' => {
				at += 1;
				if at == line.len() {
					return line;
				}
				last_space = None;
			}
			_ => last_space = None,
		}
		at += 1;
	}
	match last_space {
		Some(end) => &line[..end],
		None => line,
	}
}

/// Git's `simple_length`: how many bytes come before the first wildcard.
fn simple_length(text: &[u8]) -> usize {
	text.iter().position(|&byte| is_glob_special(byte)).unwrap_or(text.len())
}

/// Git's `is_glob_special`.
fn is_glob_special(byte: u8) -> bool {
	matches!(byte, b'*' | b'?' | b'[' | b'\\')
}

/// The byte at `at`, or 0 past the end (where a C string ends).
fn byte(text: &[u8], at: usize) -> u8 {
	text.get(at).copied().unwrap_or(0)
}

/// The bytes from `at` on (none past the end).
fn rest(text: &[u8], at: usize) -> &[u8] {
	text.get(at..).unwrap_or_default()
}

/// How git's `dowild` ends: the two aborts end the `*` loops above it early.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wild {
	Match,
	NoMatch,
	AbortAll,
	AbortToStarStar,
}

/// Git's `wildmatch` without case folding; `pathname` is `WM_PATHNAME`.
fn wildmatch(pattern: &[u8], text: &[u8], pathname: bool) -> bool {
	dowild(pattern, text, pathname) == Wild::Match
}

/// Git's `dowild`. A call inside it starts its pattern where the C code passes `p`, as git's `**` check reads back
/// from there.
fn dowild(pattern: &[u8], text: &[u8], pathname: bool) -> Wild {
	let mut p = 0;
	let mut t = 0;
	while byte(pattern, p) != 0 {
		let p_ch = byte(pattern, p);
		let mut t_ch = byte(text, t);
		if t_ch == 0 && p_ch != b'*' {
			return Wild::AbortAll;
		}
		match p_ch {
			b'\\' => {
				p += 1;
				if t_ch != byte(pattern, p) {
					return Wild::NoMatch;
				}
			}
			b'?' => {
				if pathname && t_ch == b'/' {
					return Wild::NoMatch;
				}
			}
			b'*' => {
				p += 1;
				let match_slash = if byte(pattern, p) == b'*' {
					let prev_p = p;
					while byte(pattern, p) == b'*' {
						p += 1;
					}
					let after = byte(pattern, p);
					if !pathname {
						true
					} else if (prev_p < 2 || byte(pattern, prev_p - 2) == b'/')
						&& (after == 0 || after == b'/' || (after == b'\\' && byte(pattern, p + 1) == b'/'))
					{
						if after == b'/' && dowild(rest(pattern, p + 1), rest(text, t), pathname) == Wild::Match {
							return Wild::Match;
						}
						true
					} else {
						false
					}
				} else {
					!pathname
				};
				if byte(pattern, p) == 0 {
					if !match_slash && rest(text, t).contains(&b'/') {
						return Wild::AbortToStarStar;
					}
					return Wild::Match;
				}
				if !match_slash && byte(pattern, p) == b'/' {
					match rest(text, t).iter().position(|&c| c == b'/') {
						Some(slash) => t += slash,
						None => return Wild::AbortAll,
					}
				} else {
					while t_ch != 0 {
						if !is_glob_special(byte(pattern, p)) {
							let literal = byte(pattern, p);
							loop {
								t_ch = byte(text, t);
								if t_ch == 0 || (!match_slash && t_ch == b'/') || t_ch == literal {
									break;
								}
								t += 1;
							}
							if t_ch != literal {
								return if match_slash { Wild::AbortAll } else { Wild::AbortToStarStar };
							}
						}
						let matched = dowild(rest(pattern, p), rest(text, t), pathname);
						if matched != Wild::NoMatch {
							if !match_slash || matched != Wild::AbortToStarStar {
								return matched;
							}
						} else if !match_slash && t_ch == b'/' {
							return Wild::AbortToStarStar;
						}
						t += 1;
						t_ch = byte(text, t);
					}
					return Wild::AbortAll;
				}
			}
			b'[' => {
				p += 1;
				let mut p_ch = byte(pattern, p);
				if p_ch == b'^' {
					p_ch = b'!';
				}
				let negated = p_ch == b'!';
				if negated {
					p += 1;
					p_ch = byte(pattern, p);
				}
				let mut prev_ch = 0;
				let mut matched = false;
				loop {
					if p_ch == 0 {
						return Wild::AbortAll;
					}
					if p_ch == b'\\' {
						p += 1;
						p_ch = byte(pattern, p);
						if p_ch == 0 {
							return Wild::AbortAll;
						}
						matched |= t_ch == p_ch;
					} else if p_ch == b'-' && prev_ch != 0 && !matches!(byte(pattern, p + 1), 0 | b']') {
						p += 1;
						p_ch = byte(pattern, p);
						if p_ch == b'\\' {
							p += 1;
							p_ch = byte(pattern, p);
							if p_ch == 0 {
								return Wild::AbortAll;
							}
						}
						matched |= (prev_ch..=p_ch).contains(&t_ch);
						p_ch = 0;
					} else if p_ch == b'[' && byte(pattern, p + 1) == b':' {
						p += 2;
						let start = p;
						while byte(pattern, p) != 0 && byte(pattern, p) != b']' {
							p += 1;
						}
						if byte(pattern, p) == 0 {
							return Wild::AbortAll;
						}
						if p == start || byte(pattern, p - 1) != b':' {
							// No `:]`: the `[` is a member like any other.
							p = start - 2;
							p_ch = b'[';
							matched |= t_ch == p_ch;
						} else {
							match class(&pattern[start..p - 1], t_ch) {
								Some(member) => matched |= member,
								None => return Wild::AbortAll,
							}
							p_ch = 0;
						}
					} else {
						matched |= t_ch == p_ch;
					}
					prev_ch = p_ch;
					p += 1;
					p_ch = byte(pattern, p);
					if p_ch == b']' {
						break;
					}
				}
				if matched == negated || (pathname && t_ch == b'/') {
					return Wild::NoMatch;
				}
			}
			_ => {
				if t_ch != p_ch {
					return Wild::NoMatch;
				}
			}
		}
		p += 1;
		t += 1;
	}
	if byte(text, t) == 0 {
		Wild::Match
	} else {
		Wild::NoMatch
	}
}

/// Whether `byte` is in the POSIX class `name` as git's ASCII-only ctype has it (`sane-ctype.h`: `space` is space,
/// tab, newline and carriage return only), None for a name git does not know.
fn class(name: &[u8], byte: u8) -> Option<bool> {
	Some(match name {
		b"alnum" => byte.is_ascii_alphanumeric(),
		b"alpha" => byte.is_ascii_alphabetic(),
		b"blank" => byte == b' ' || byte == b'\t',
		b"cntrl" => byte.is_ascii_control(),
		b"digit" => byte.is_ascii_digit(),
		b"graph" => byte.is_ascii_graphic(),
		b"lower" => byte.is_ascii_lowercase(),
		b"print" => (0x20..=0x7e).contains(&byte),
		b"punct" => byte.is_ascii_punctuation(),
		b"space" => matches!(byte, b' ' | b'\t' | b'\n' | b'\r'),
		b"upper" => byte.is_ascii_uppercase(),
		b"xdigit" => byte.is_ascii_hexdigit(),
		_ => return None,
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::collections::HashMap;

	/// A case's ignore file in the repository's `info/exclude`, not in a worktree folder.
	const EXCLUDE: &str = "info/exclude";
	const FILE: bool = false;
	const DIR: bool = true;

	/// Ignore files (worktree folder or EXCLUDE, text), the path, whether it is a folder, whether git ignores it.
	type Case = (&'static [(&'static str, &'static str)], &'static str, bool, bool);

	const CASES: &[Case] = &[
		(&[("", "*.o")], "a.o", FILE, true),
		(&[("", "*.o")], "src/a.o", FILE, true),
		(&[("", "*.o")], "a.c", FILE, false),
		(&[("", "*.o")], "a.o", DIR, true),
		(&[("", "# a comment\n")], "# a comment", FILE, false),
		(&[("", "#hash")], "#hash", FILE, false),
		(&[("", "\\#hash")], "#hash", FILE, true),
		(&[("", " #hash")], " #hash", FILE, true),
		(&[("", "foo   ")], "foo", FILE, true),
		(&[("", "foo   ")], "foo   ", FILE, false),
		(&[("", "foo\\ ")], "foo ", FILE, true),
		(&[("", "foo\\ ")], "foo", FILE, false),
		(&[("", "foo\\  ")], "foo ", FILE, true),
		(&[("", "foo\\\\ ")], "foo\\", FILE, true),
		(&[("", "foo\t")], "foo", FILE, false),
		(&[("", "foo\t")], "foo\t", FILE, true),
		(&[("", "foo \t")], "foo \t", FILE, true),
		(&[("", "   ")], "   ", FILE, false),
		// dir.c drops a `\r` before each newline, on Linux too.
		(&[("", "foo\r\nbar\r\n")], "foo", FILE, true),
		(&[("", "foo\r\nbar\r\n")], "bar", FILE, true),
		(&[("", "foo\r\nbar\r\n")], "foo\r", FILE, false),
		(&[("", "foo\r")], "foo", FILE, true),
		(&[("", "a\nfoo")], "foo", FILE, true),
		// dir.c skips a UTF-8 byte order mark at the file's start only.
		(&[("", "\u{feff}foo\n")], "foo", FILE, true),
		(&[("", "\u{feff}#x\n")], "\u{feff}#x", FILE, false),
		(&[("", "a\n\u{feff}foo\n")], "\u{feff}foo", FILE, true),
		(&[("", "a\n\u{feff}foo\n")], "foo", FILE, false),
		// A NUL byte ends the pattern (dir.c works on C strings).
		(&[("", "foo\0bar")], "foo", FILE, true),
		(&[("", "foo\0bar")], "foobar", FILE, false),
		(&[("", "\\!important!.txt")], "!important!.txt", FILE, true),
		(&[("", "!foo")], "foo", FILE, false),
		(&[("", "!\n")], "!", FILE, false),
		(&[("", "\\!")], "!", FILE, true),
		(&[("", "*.log\n!keep.log")], "keep.log", FILE, false),
		(&[("", "*.log\n!keep.log")], "a/keep.log", FILE, false),
		(&[("", "*.log\n!keep.log")], "other.log", FILE, true),
		(&[("", "!keep.log\n*.log")], "keep.log", FILE, true),
		(&[("", "build/")], "build", DIR, true),
		(&[("", "build/")], "build", FILE, false),
		(&[("", "build/")], "build/x", FILE, true),
		(&[("", "build/")], "a/build", DIR, true),
		(&[("", "build/")], "a/build", FILE, false),
		(&[("", "doc/frotz/")], "doc/frotz", DIR, true),
		(&[("", "doc/frotz/")], "a/doc/frotz", DIR, false),
		(&[("", "frotz/")], "a/frotz", DIR, true),
		(&[("", "a/b/")], "a/b", DIR, true),
		(&[("", "a/b/")], "a/b", FILE, false),
		(&[("", "a/b/")], "x/a/b", DIR, false),
		(&[("", "build/\n!build/keep")], "build/keep", FILE, true),
		(&[("", "build/*\n!build/keep")], "build/keep", FILE, false),
		(&[("", "build/*\n!build/keep")], "build/other", FILE, true),
		(&[("", "/*\n!/foo")], "foo/bar", FILE, false),
		(&[("", "/*\n!/foo")], "bar", FILE, true),
		(&[("", "*\n!*/\n!*.c")], "a/b.c", FILE, false),
		(&[("", "*\n!*/\n!*.c")], "a/b.h", FILE, true),
		(&[("", "*\n!keep/")], "keep", DIR, false),
		(&[("", "*\n!keep/")], "keep/x", FILE, true),
		(&[("", "*/")], "a", DIR, true),
		(&[("", "*/")], "a", FILE, false),
		(&[("", "*/")], "a/b", FILE, true),
		(&[("", "*.txt/")], "x.txt", FILE, false),
		(&[("", "*.txt/")], "x.txt", DIR, true),
		(&[("", "a/\n!a/")], "a/x", FILE, false),
		(&[("", "/foo")], "foo", FILE, true),
		(&[("", "/foo")], "a/foo", FILE, false),
		(&[("", "a/foo")], "a/foo", FILE, true),
		(&[("", "a/foo")], "b/a/foo", FILE, false),
		(&[("", "foo")], "a/b/foo", FILE, true),
		(&[("", "b/c")], "a/b/c", FILE, false),
		(&[("a", "b/c")], "a/b/c", FILE, true),
		(&[("sub", "/x")], "sub/x", FILE, true),
		(&[("sub", "/x")], "sub/y/x", FILE, false),
		(&[("sub", "/x")], "x", FILE, false),
		(&[("sub", "x")], "sub/y/x", FILE, true),
		(&[("sub", "y/x")], "sub/y/x", FILE, true),
		(&[("sub", "y/x")], "sub/z/y/x", FILE, false),
		(&[("sub", "y/")], "sub/z/y", DIR, true),
		(&[(EXCLUDE, "/top")], "top", FILE, true),
		(&[(EXCLUDE, "/top")], "a/top", FILE, false),
		(&[(EXCLUDE, "a/b")], "a/b", FILE, true),
		(&[(EXCLUDE, "a")], "a/b/c", FILE, true),
		(&[(EXCLUDE, "*.tmp")], "a/b.tmp", FILE, true),
		(&[("", "*.log"), ("sub", "!keep.log")], "sub/keep.log", FILE, false),
		(&[("", "*.log"), ("sub", "!keep.log")], "keep.log", FILE, true),
		(&[("", "*.log"), ("sub", "!keep.log")], "sub/other.log", FILE, true),
		(&[(EXCLUDE, "*.log"), ("", "!keep.log")], "keep.log", FILE, false),
		(&[(EXCLUDE, "!x"), ("", "x")], "x", FILE, true),
		(&[("", "!x"), (EXCLUDE, "x")], "x", FILE, false),
		(&[(EXCLUDE, "*.log"), ("", "!*.log"), ("sub", "*.log")], "sub/a.log", FILE, true),
		(&[(EXCLUDE, "*.log"), ("", "!*.log"), ("sub", "*.log")], "a.log", FILE, false),
		(&[(EXCLUDE, "*.log"), ("", "!a.log"), ("sub", "!b.log")], "sub/c.log", FILE, true),
		(&[(EXCLUDE, "*.log"), ("", "!a.log"), ("sub", "!b.log")], "sub/b.log", FILE, false),
		(&[(EXCLUDE, "*.log"), ("", "!a.log"), ("sub", "!b.log")], "sub/a.log", FILE, false),
		(&[("", "x"), ("a", "!x"), ("a/b", "x")], "a/b/x", FILE, true),
		(&[("", "x"), ("a", "!x"), ("a/b", "x")], "a/x", FILE, false),
		(&[("", "x"), ("a", "!x"), ("a/b", "x")], "x", FILE, true),
		(&[("", "build/"), ("build", "!keep")], "build/keep", FILE, true),
		(&[(EXCLUDE, "vendor/"), ("vendor", "!*")], "vendor/a", FILE, true),
		(&[("", "!*.txt"), ("a", "b/")], "a/b/c.txt", FILE, true),
		(&[("", "b/"), ("a", "!b/")], "a/b/c", FILE, false),
		(&[("", "**/foo")], "foo", FILE, true),
		(&[("", "**/foo")], "a/b/foo", FILE, true),
		(&[("", "**/foo")], "afoo", FILE, false),
		(&[("", "**/foo")], "a/foo/x", FILE, true),
		(&[("", "**/foo/bar")], "x/foo/bar", FILE, true),
		(&[("", "**/foo/bar")], "foo/bar", FILE, true),
		(&[("", "**/foo/bar")], "foo/x/bar", FILE, false),
		(&[("", "abc/**")], "abc/x", FILE, true),
		(&[("", "abc/**")], "abc/x/y", FILE, true),
		(&[("", "abc/**")], "abc", DIR, false),
		(&[("", "a/**/b")], "a/b", FILE, true),
		(&[("", "a/**/b")], "a/x/b", FILE, true),
		(&[("", "a/**/b")], "a/x/y/b", FILE, true),
		(&[("", "a/**/b")], "a/xb", FILE, false),
		(&[("", "a**b")], "axyb", FILE, true),
		(&[("", "a**b")], "ax/yb", FILE, false),
		(&[("", "**foo")], "xfoo", FILE, true),
		(&[("", "**foo")], "a/xfoo", FILE, true),
		(&[("", "**foo")], "foo", FILE, true),
		(&[("", "**foo")], "foox", FILE, false),
		(&[("", "**")], "a", FILE, true),
		(&[("", "**")], "a/b", FILE, true),
		(&[("", "/**")], "a", FILE, true),
		(&[("", "**/")], "a", DIR, true),
		(&[("", "**/")], "a", FILE, false),
		(&[("", "**/")], "a/b", FILE, true),
		(&[("", "a/**/")], "a", DIR, false),
		(&[("", "a/**/")], "a/b", DIR, true),
		(&[("", "a/**/")], "a/b", FILE, false),
		(&[("", "a/**/")], "a/b/c", FILE, true),
		// wildmatch.c: `**\/` is a `**` between slashes, but only `**/` may match no folder at all.
		(&[("", "a/**\\/b")], "a/x/b", FILE, true),
		(&[("", "a/**\\/b")], "a/x/y/b", FILE, true),
		(&[("", "a/**\\/b")], "a/b", FILE, false),
		(&[("", "a/***/b")], "a/b", FILE, true),
		(&[("", "a/***/b")], "a/x/y/b", FILE, true),
		// A `**` not between slashes is a `*`.
		(&[("", "foo**/bar")], "foox/bar", FILE, true),
		(&[("", "foo**/bar")], "foo/bar", FILE, true),
		(&[("", "foo**/bar")], "foox/y/bar", FILE, false),
		(&[("", "a/**b")], "a/xb", FILE, true),
		(&[("", "a/**b")], "a/b", FILE, true),
		(&[("", "a/**b")], "a/x/yb", FILE, false),
		(&[("", "**foo/bar")], "xfoo/bar", FILE, true),
		(&[("", "**foo/bar")], "foo/bar", FILE, true),
		(&[("", "**foo/bar")], "a/xfoo/bar", FILE, false),
		(&[("", "?.c")], "a.c", FILE, true),
		(&[("", "?.c")], "ab.c", FILE, false),
		(&[("", "*.[oa]")], "x.o", FILE, true),
		(&[("", "*.[oa]")], "x.a", FILE, true),
		(&[("", "*.[oa]")], "x.c", FILE, false),
		(&[("", "[a-c]x")], "bx", FILE, true),
		(&[("", "[a-c]x")], "dx", FILE, false),
		(&[("", "[!a-c]x")], "dx", FILE, true),
		(&[("", "[!a-c]x")], "bx", FILE, false),
		(&[("", "[^a-c]x")], "dx", FILE, true),
		(&[("", "[^a-c]x")], "bx", FILE, false),
		(&[("", "[]]x")], "]x", FILE, true),
		(&[("", "[]]x")], "ax", FILE, false),
		(&[("", "[!]]x")], "ax", FILE, true),
		(&[("", "[!]]x")], "]x", FILE, false),
		(&[("", "[a-]x")], "-x", FILE, true),
		(&[("", "[a-]x")], "ax", FILE, true),
		(&[("", "[a-]x")], "bx", FILE, false),
		(&[("", "[\\]]x")], "]x", FILE, true),
		(&[("", "[\\]]x")], "\\x", FILE, false),
		(&[("", "x[[:alnum:]]y")], "x7y", FILE, true),
		(&[("", "x[[:alnum:]]y")], "x_y", FILE, false),
		(&[("", "x[[:alpha:]]y")], "xQy", FILE, true),
		(&[("", "x[[:alpha:]]y")], "x1y", FILE, false),
		(&[("", "x[[:blank:]]y")], "x y", FILE, true),
		(&[("", "x[[:blank:]]y")], "x\ty", FILE, true),
		(&[("", "x[[:blank:]]y")], "x\ry", FILE, false),
		(&[("", "x[[:cntrl:]]y")], "x\u{1}y", FILE, true),
		(&[("", "x[[:cntrl:]]y")], "x\u{7f}y", FILE, true),
		(&[("", "x[[:cntrl:]]y")], "x y", FILE, false),
		(&[("", "x[[:digit:]]y")], "x5y", FILE, true),
		(&[("", "x[[:digit:]]y")], "xay", FILE, false),
		(&[("", "x[[:graph:]]y")], "x~y", FILE, true),
		(&[("", "x[[:graph:]]y")], "x y", FILE, false),
		(&[("", "x[[:lower:]]y")], "xay", FILE, true),
		(&[("", "x[[:lower:]]y")], "xAy", FILE, false),
		(&[("", "x[[:print:]]y")], "x y", FILE, true),
		(&[("", "x[[:print:]]y")], "x\ty", FILE, false),
		(&[("", "x[[:punct:]]y")], "x_y", FILE, true),
		(&[("", "x[[:punct:]]y")], "x~y", FILE, true),
		(&[("", "x[[:punct:]]y")], "xay", FILE, false),
		(&[("", "x[[:space:]]y")], "x y", FILE, true),
		(&[("", "x[[:space:]]y")], "x\ty", FILE, true),
		(&[("", "x[[:space:]]y")], "x\ry", FILE, true),
		// Git's own ctype: vertical tab and form feed are not `[:space:]`.
		(&[("", "x[[:space:]]y")], "x\u{b}y", FILE, false),
		(&[("", "x[[:space:]]y")], "x\u{c}y", FILE, false),
		(&[("", "x[[:upper:]]y")], "xAy", FILE, true),
		(&[("", "x[[:upper:]]y")], "xay", FILE, false),
		(&[("", "x[[:xdigit:]]y")], "xfy", FILE, true),
		(&[("", "x[[:xdigit:]]y")], "xgy", FILE, false),
		(&[("", "x[[:alpha:][:digit:]]y")], "x1y", FILE, true),
		(&[("", "x[[:digit:]-z]y")], "x-y", FILE, true),
		(&[("", "x[[:digit:]-z]y")], "xqy", FILE, false),
		(&[("", "caf??")], "caf\u{e9}", FILE, true),
		(&[("", "caf?")], "caf\u{e9}", FILE, false),
		(&[("", "caf[[:alpha:]]*")], "caf\u{e9}", FILE, false),
		// wildmatch.c: an unknown class or a set with no `]` matches nothing; `[:` with no `:]` is a plain member.
		(&[("", "[[:foo:]]x")], "fx", FILE, false),
		(&[("", "[[:alpha]x")], ":x", FILE, true),
		(&[("", "[[:alpha]x")], "[x", FILE, true),
		(&[("", "[[:alpha]x")], "bx", FILE, false),
		(&[("", "[abc")], "a", FILE, false),
		(&[("", "[abc")], "[abc", FILE, false),
		(&[("", "x/a[--0]c")], "x/a.c", FILE, true),
		(&[("", "x/a[--0]c")], "x/a/c", FILE, false),
		(&[("", "x/a?c")], "x/abc", FILE, true),
		(&[("", "x/a?c")], "x/a/c", FILE, false),
		(&[("", "x/*.c")], "x/a.c", FILE, true),
		(&[("", "x/*.c")], "x/y/a.c", FILE, false),
		(&[("", "\\*")], "*", FILE, true),
		(&[("", "\\*")], "a", FILE, false),
		(&[("", "\\a")], "a", FILE, true),
		(&[("", "\\[a]")], "[a]", FILE, true),
		(&[("", "\\[a]")], "a", FILE, false),
		(&[("", "foo\\")], "foo", FILE, false),
		(&[("", "foo\\")], "foo\\", FILE, false),
		(&[("", "Foo")], "foo", FILE, false),
		(&[("", "Foo")], "Foo", FILE, true),
		(&[("", "*.c")], ".c", FILE, true),
		(&[("", "/")], "a", DIR, false),
		(&[("", "/")], "a", FILE, false),
		(&[("", "./foo")], "foo", FILE, false),
	];

	/// What `ignored` answers for a case's files and path.
	fn run(files: &[(&str, &str)], path: &str, folder: bool) -> bool {
		let mut gitignores = HashMap::new();
		let mut exclude = None;
		for &(at, text) in files {
			let patterns = Patterns::parse(text.as_bytes());
			if at == EXCLUDE {
				exclude = Some(patterns);
			} else {
				gitignores.insert(at, patterns);
			}
		}
		ignored(path, folder, |dir| gitignores.get(dir), exclude.as_ref())
	}

	#[test]
	fn every_case_decides_as_git() {
		let differ: Vec<String> = CASES
			.iter()
			.enumerate()
			.filter(|&(_, &(files, path, folder, expected))| run(files, path, folder) != expected)
			.map(|(i, case)| format!("case {i}: {case:?}"))
			.collect();
		assert!(differ.is_empty(), "{} of {} cases differ:\n{}", differ.len(), CASES.len(), differ.join("\n"));
	}

	#[test]
	fn decide_answers_for_its_own_file() {
		let patterns = Patterns::parse(b"*.o\n!keep.o\n");
		assert_eq!(patterns.decide("a.o", false), Some(true));
		assert_eq!(patterns.decide("src/keep.o", false), Some(false));
		assert_eq!(patterns.decide("a.c", false), None);
		assert_eq!(patterns.decide("", true), None);
		assert!(!ignored("", true, |_| Some(&patterns), Some(&patterns)));
	}

	#[test]
	fn an_ignored_folder_keeps_its_gitignore_unread() {
		let (top, inner) = (Patterns::parse(b"build/\n"), Patterns::parse(b"!keep\n"));
		let mut asked = Vec::new();
		let answer = ignored(
			"build/keep",
			false,
			|dir| {
				asked.push(dir.to_string());
				match dir {
					"" => Some(&top),
					"build" => Some(&inner),
					_ => None,
				}
			},
			None,
		);
		assert!(answer);
		assert_eq!(asked, [""]);
		asked.clear();
		let answer = ignored(
			"src/a/b.c",
			false,
			|dir| {
				asked.push(dir.to_string());
				None::<&Patterns>
			},
			None,
		);
		assert!(!answer);
		assert_eq!(asked, ["", "src", "src/a"]);
	}

	#[test]
	fn a_file_of_100_mib_is_left_out() {
		let mut text = vec![b'#'; MAX_FILE - 5];
		text.extend_from_slice(b"\nfoo");
		assert_eq!(Patterns::parse(&text).decide("foo", false), Some(true));
		text.push(b'\n');
		assert_eq!(Patterns::parse(&text).decide("foo", false), None);
	}
}
