use std::collections::BTreeSet;
use std::sync::OnceLock;

const MAX_PATTERN_BYTES: usize = 16 * 1024;
const MAX_NESTING_DEPTH: usize = 64;
const MAX_QUANTIFIER_COUNT: usize = 64;
const MAX_NFA_INSTS: usize = 2048;
const MAX_TRIGRAM_EXACT: usize = 16;
const MAX_TRIGRAM_OR: usize = 32;
const MAX_TRIGRAM_DEPTH: usize = 32;
const MAX_EXACT_STR_LEN: usize = 64;

const SHORTHAND_D: u8 = 1 << 0;
const SHORTHAND_NOT_D: u8 = 1 << 1;
const SHORTHAND_W: u8 = 1 << 2;
const SHORTHAND_NOT_W: u8 = 1 << 3;
const SHORTHAND_S: u8 = 1 << 4;
const SHORTHAND_NOT_S: u8 = 1 << 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternError(pub String);

impl std::fmt::Display for PatternError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl std::error::Error for PatternError {}

pub fn fold_text(text: &str) -> String {
	if text.is_ascii() {
		return text.to_ascii_lowercase();
	}
	let mut out = String::with_capacity(text.len());
	for ch in text.chars() {
		if ch.is_ascii() {
			out.push(ch.to_ascii_lowercase());
		} else {
			for lc in ch.to_lowercase() {
				out.push(if lc == '\u{03c2}' { '\u{03c3}' } else { lc });
			}
		}
	}
	out
}

pub fn fold_char(ch: char) -> String {
	if ch.is_ascii() {
		return (ch.to_ascii_lowercase()).to_string();
	}
	let mut out = String::new();
	for lc in ch.to_lowercase() {
		out.push(if lc == '\u{03c2}' { '\u{03c3}' } else { lc });
	}
	out
}

pub fn fold_char_utf8_len(ch: char) -> usize {
	if ch.is_ascii() {
		return 1;
	}
	let mut len = 0usize;
	for lc in ch.to_lowercase() {
		let mapped = if lc == '\u{03c2}' { '\u{03c3}' } else { lc };
		len += mapped.len_utf8();
	}
	len
}

fn is_word_char(ch: char) -> bool {
	ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_js_space_ascii(b: u8) -> bool {
	matches!(b, b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ')
}

fn is_js_space_unicode(ch: char) -> bool {
	matches!(
		ch,
		'\u{00a0}'
			| '\u{1680}'
			| '\u{2000}'..='\u{200a}'
			| '\u{2028}'
			| '\u{2029}'
			| '\u{202f}'
			| '\u{205f}'
			| '\u{3000}'
			| '\u{feff}'
	)
}

fn is_line_terminator(ch: char) -> bool {
	matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssertKind {
	StartLine,
	EndLine,
	StartText,
	EndText,
	WordBoundary,
	NonWordBoundary,
}

#[derive(Debug, Clone)]
struct CharClass {
	negated: bool,
	ascii_bits: [u64; 2],
	ranges: Vec<(u32, u32)>,
	shorthands: u8,
}

impl CharClass {
	fn build(negated: bool, raw_ranges: &[(u32, u32)], shorthands: u8) -> Self {
		let mut ascii_bits = [0u64; 2];
		for b in 0u8..128u8 {
			let ch = b as char;
			let mut matched = false;
			if (shorthands & SHORTHAND_D) != 0 && b.is_ascii_digit() {
				matched = true;
			}
			if (shorthands & SHORTHAND_NOT_D) != 0 && !b.is_ascii_digit() {
				matched = true;
			}
			if (shorthands & SHORTHAND_W) != 0 && is_word_char(ch) {
				matched = true;
			}
			if (shorthands & SHORTHAND_NOT_W) != 0 && !is_word_char(ch) {
				matched = true;
			}
			if (shorthands & SHORTHAND_S) != 0 && is_js_space_ascii(b) {
				matched = true;
			}
			if (shorthands & SHORTHAND_NOT_S) != 0 && !is_js_space_ascii(b) {
				matched = true;
			}
			if !matched {
				let code = b as u32;
				for &(lo, hi) in raw_ranges {
					if code >= lo && code <= hi {
						matched = true;
						break;
					}
				}
			}
			if matched ^ negated {
				ascii_bits[(b >> 6) as usize] |= 1u64 << (b & 63);
			}
		}
		let mut non_ascii: Vec<(u32, u32)> = raw_ranges
			.iter()
			.filter_map(|&(lo, hi)| (hi >= 128).then_some((lo.max(128), hi)))
			.collect();
		non_ascii.sort_unstable();
		let mut merged: Vec<(u32, u32)> = Vec::with_capacity(non_ascii.len());
		for (lo, hi) in non_ascii {
			if let Some(last) = merged.last_mut() {
				if lo <= last.1 + 1 {
					last.1 = last.1.max(hi);
					continue;
				}
			}
			merged.push((lo, hi));
		}
		Self { negated, ascii_bits, ranges: merged, shorthands }
	}

	fn from_shorthand(flag: u8) -> Self {
		Self::build(false, &[], flag)
	}

	#[inline]
	fn matches(&self, ch: char) -> bool {
		let code = ch as u32;
		if code < 128 {
			return ((self.ascii_bits[(code >> 6) as usize] >> (code & 63)) & 1) != 0;
		}
		let mut matched = false;
		if (self.shorthands & (SHORTHAND_NOT_D | SHORTHAND_NOT_W)) != 0 {
			matched = true;
		} else {
			if (self.shorthands & SHORTHAND_S) != 0 && is_js_space_unicode(ch) {
				matched = true;
			}
			if !matched && (self.shorthands & SHORTHAND_NOT_S) != 0 && !is_js_space_unicode(ch) {
				matched = true;
			}
		}
		if !matched && !self.ranges.is_empty() {
			let idx = self.ranges.partition_point(|&(lo, _)| lo <= code);
			if idx > 0 && code <= self.ranges[idx - 1].1 {
				matched = true;
			}
		}
		matched ^ self.negated
	}

	fn small_folded_literals(&self) -> Option<Vec<String>> {
		if self.negated || self.shorthands != 0 {
			return None;
		}
		let mut set = BTreeSet::new();
		for b in 0u8..128u8 {
			if ((self.ascii_bits[(b >> 6) as usize] >> (b & 63)) & 1) != 0 {
				set.insert(fold_char(b as char));
				if set.len() > 8 {
					return None;
				}
			}
		}
		for &(lo, hi) in &self.ranges {
			if hi - lo > 8 {
				return None;
			}
			for code in lo..=hi {
				if let Some(ch) = char::from_u32(code) {
					set.insert(fold_char(ch));
					if set.len() > 8 {
						return None;
					}
				}
			}
		}
		if set.is_empty() {
			None
		} else {
			Some(set.into_iter().collect())
		}
	}

	fn single_exact_char(&self) -> Option<char> {
		if self.negated || self.shorthands != 0 {
			return None;
		}
		let mut found: Option<char> = None;
		for word_idx in 0..2 {
			let bits = self.ascii_bits[word_idx];
			if bits != 0 {
				if bits.count_ones() > 1 || found.is_some() {
					return None;
				}
				let b = (word_idx as u32) * 64 + bits.trailing_zeros();
				found = char::from_u32(b);
			}
		}
		for &(lo, hi) in &self.ranges {
			if lo != hi || found.is_some() {
				return None;
			}
			found = char::from_u32(lo);
		}
		found
	}
}

#[derive(Debug, Clone)]
enum Expr {
	Empty,
	Flag,
	Char(char),
	AnyNoNl,
	Class(CharClass),
	Assert(AssertKind),
	Concat(Vec<Expr>),
	Alt(Vec<Expr>),
	Repeat { inner: Box<Expr>, min: usize, max: Option<usize> },
}

enum Escape {
	Char(char),
	Shorthand(u8),
	Assert(AssertKind),
}

fn syntax_err(msg: &str) -> PatternError {
	PatternError(format!("REGEX_SYNTAX: {msg}"))
}

fn escape_err(msg: &str) -> PatternError {
	PatternError(format!("REGEX_ESCAPE: {msg}"))
}

fn too_large_err() -> PatternError {
	PatternError(
		"REGEX_TOO_LARGE: a count above 64, or counts inside counts, cannot run in linear time; write a smaller one"
			.to_string(),
	)
}

fn parse_hex(chars: &[char], from: usize, digits: usize) -> Result<u32, PatternError> {
	if from + digits > chars.len() {
		return Err(escape_err("\\x takes two hex digits, \\u four, \\x{...} up to six"));
	}
	let mut val = 0u32;
	for &ch in &chars[from..from + digits] {
		let d = ch
			.to_digit(16)
			.ok_or_else(|| escape_err("\\x takes two hex digits, \\u four, \\x{...} up to six"))?;
		val = (val << 4) | d;
	}
	Ok(val)
}

fn scalar(code: u32) -> Result<char, PatternError> {
	if code > 0x10ffff || (0xd800..=0xdfff).contains(&code) {
		return Err(escape_err("that escape names no character"));
	}
	char::from_u32(code).ok_or_else(|| escape_err("that escape names no character"))
}

fn escape_at(chars: &[char], at: usize, in_class: bool) -> Result<(Escape, usize), PatternError> {
	let Some(&c) = chars.get(at + 1) else {
		return Err(syntax_err("the pattern ends with a backslash"));
	};
	match c {
		'd' => Ok((Escape::Shorthand(SHORTHAND_D), at + 2)),
		'D' => Ok((Escape::Shorthand(SHORTHAND_NOT_D), at + 2)),
		'w' => Ok((Escape::Shorthand(SHORTHAND_W), at + 2)),
		'W' => Ok((Escape::Shorthand(SHORTHAND_NOT_W), at + 2)),
		's' => Ok((Escape::Shorthand(SHORTHAND_S), at + 2)),
		'S' => Ok((Escape::Shorthand(SHORTHAND_NOT_S), at + 2)),
		'b' | 'B' => {
			if in_class {
				return Err(escape_err("\\b and \\B are not characters; leave them out of [ ]"));
			}
			let kind = if c == 'b' { AssertKind::WordBoundary } else { AssertKind::NonWordBoundary };
			Ok((Escape::Assert(kind), at + 2))
		}
		'1'..='9' | 'k' => Err(PatternError(
			"REGEX_BACKREFERENCE: a back-reference cannot run in linear time; search without it".to_string(),
		)),
		'p' | 'P' => Err(escape_err("\\p classes are not taken; write the characters as a class like [a-z]")),
		'n' => Ok((Escape::Char('\n'), at + 2)),
		't' => Ok((Escape::Char('\t'), at + 2)),
		'r' => Ok((Escape::Char('\r'), at + 2)),
		'f' => Ok((Escape::Char('\u{000c}'), at + 2)),
		'v' => Ok((Escape::Char('\u{000b}'), at + 2)),
		'0' => {
			if chars.get(at + 2).is_some_and(|n| n.is_ascii_digit()) {
				return Err(escape_err("octal escapes are not taken"));
			}
			Ok((Escape::Char('\0'), at + 2))
		}
		'x' => {
			if chars.get(at + 2) == Some(&'{') {
				let close = chars[at + 3..]
					.iter()
					.position(|&ch| ch == '}')
					.map(|rel| at + 3 + rel)
					.ok_or_else(|| escape_err("\\x{...} takes one to six hex digits"))?;
				let len = close - (at + 3);
				if !(1..=6).contains(&len) {
					return Err(escape_err("\\x{...} takes one to six hex digits"));
				}
				let ch = scalar(parse_hex(chars, at + 3, len)?)?;
				Ok((Escape::Char(ch), close + 1))
			} else {
				let ch = scalar(parse_hex(chars, at + 2, 2)?)?;
				Ok((Escape::Char(ch), at + 4))
			}
		}
		'u' => {
			let ch = scalar(parse_hex(chars, at + 2, 4)?)?;
			Ok((Escape::Char(ch), at + 6))
		}
		'c' => {
			let Some(&letter) = chars.get(at + 2) else {
				return Err(escape_err("\\c takes a letter"));
			};
			if !letter.is_ascii_alphabetic() {
				return Err(escape_err("\\c takes a letter"));
			}
			let code = (letter.to_ascii_uppercase() as u32) - 64;
			Ok((Escape::Char(char::from_u32(code).unwrap()), at + 3))
		}
		_ if c.is_ascii_alphanumeric() => Err(escape_err(&format!("\\{c} is not an escape this search takes"))),
		_ => Ok((Escape::Char(c), at + 2)),
	}
}

fn expand_unfolded_case(ch: char, out: &mut Vec<u32>) {
	let code = ch as u32;
	out.push(code);
	if ch.is_ascii_alphabetic() {
		let lo = ch.to_ascii_lowercase();
		let hi = ch.to_ascii_uppercase();
		out.push(lo as u32);
		out.push(hi as u32);
		if lo == 'k' {
			out.push(0x212a);
		}
		return;
	}
	if ch == '\u{212a}' {
		out.push(b'k' as u32);
		out.push(b'K' as u32);
		return;
	}
	if matches!(ch, '\u{03a3}' | '\u{03c2}' | '\u{03c3}') {
		out.push(0x03a3);
		out.push(0x03c2);
		out.push(0x03c3);
		return;
	}
	let mut lo = ch.to_lowercase();
	if let (Some(c), None) = (lo.next(), lo.next()) {
		out.push(c as u32);
	}
	let mut hi = ch.to_uppercase();
	if let (Some(c), None) = (hi.next(), hi.next()) {
		out.push(c as u32);
	}
}

struct Parser<'a> {
	chars: &'a [char],
	pos: usize,
	depth: usize,
	case_sensitive: bool,
	multiline: bool,
	folded_input: bool,
	saw_cs: bool,
	saw_ci: bool,
}

fn bmp_folded_map() -> &'static [(u32, u32)] {
	static TABLE: OnceLock<Vec<(u32, u32)>> = OnceLock::new();
	TABLE.get_or_init(|| {
		let mut entries = Vec::new();
		for code in 128u32..=0xffff {
			if let Some(ch) = char::from_u32(code) {
				let folded = fold_char(ch);
				let mut it = folded.chars();
				if let (Some(f), None) = (it.next(), it.next()) {
					let f_code = f as u32;
					if f_code != code {
						entries.push((code, f_code));
					}
				}
			}
		}
		entries
	})
}

fn bmp_unfolded_map() -> &'static [(u32, u32)] {
	static TABLE: OnceLock<Vec<(u32, u32)>> = OnceLock::new();
	TABLE.get_or_init(|| {
		let mut entries = Vec::new();
		let mut variants = Vec::new();
		for code in 128u32..=0xffff {
			if let Some(ch) = char::from_u32(code) {
				variants.clear();
				expand_unfolded_case(ch, &mut variants);
				for &v in &variants {
					if v != code {
						entries.push((code, v));
					}
				}
			}
		}
		entries
	})
}

impl<'a> Parser<'a> {
	fn parse(chars: &'a [char], case_sensitive: bool) -> Result<(Expr, bool), PatternError> {
		let first_folded = !case_sensitive;
		let mut p = Self {
			chars,
			pos: 0,
			depth: 0,
			case_sensitive,
			multiline: true,
			folded_input: first_folded,
			saw_cs: false,
			saw_ci: false,
		};
		let expr = p.parse_alt()?;
		if p.pos < p.chars.len() {
			return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
		}
		let want_folded = !p.saw_cs && (p.saw_ci || !case_sensitive);
		if want_folded != first_folded {
			let mut p2 = Self {
				chars,
				pos: 0,
				depth: 0,
				case_sensitive,
				multiline: true,
				folded_input: want_folded,
				saw_cs: false,
				saw_ci: false,
			};
			let expr2 = p2.parse_alt()?;
			return Ok((expr2, want_folded));
		}
		Ok((expr, first_folded))
	}

	fn parse_alt(&mut self) -> Result<Expr, PatternError> {
		let mut branches = vec![self.parse_concat()?];
		while self.chars.get(self.pos) == Some(&'|') {
			self.pos += 1;
			branches.push(self.parse_concat()?);
		}
		if branches.len() == 1 { Ok(branches.pop().unwrap()) } else { Ok(Expr::Alt(branches)) }
	}

	fn parse_concat(&mut self) -> Result<Expr, PatternError> {
		let mut items = Vec::new();
		while let Some(&c) = self.chars.get(self.pos) {
			if c == '|' || c == ')' {
				break;
			}
			let atom = self.parse_atom()?;
			let quantified = self.parse_quantifier(atom)?;
			if !matches!(quantified, Expr::Flag) {
				items.push(quantified);
			}
		}
		match items.len() {
			0 => Ok(Expr::Empty),
			1 => Ok(items.pop().unwrap()),
			_ => Ok(Expr::Concat(items)),
		}
	}

	fn literal_expr(&mut self, ch: char) -> Expr {
		if self.case_sensitive {
			self.saw_cs = true;
			return Expr::Char(ch);
		}
		self.saw_ci = true;
		if self.folded_input {
			let folded = fold_char(ch);
			let mut it = folded.chars();
			let first = it.next().unwrap();
			if it.clone().next().is_none() {
				return Expr::Char(first);
			}
			let mut v = vec![Expr::Char(first)];
			v.extend(it.map(Expr::Char));
			return Expr::Concat(v);
		}
		if matches!(ch, 'ß' | 'ẞ') {
			return Expr::Class(CharClass::build(false, &[(0x00df, 0x00df), (0x1e9e, 0x1e9e)], 0));
		}
		let mut variants = Vec::with_capacity(4);
		expand_unfolded_case(ch, &mut variants);
		variants.sort_unstable();
		variants.dedup();
		if variants.len() == 1 {
			Expr::Char(ch)
		} else {
			let ranges: Vec<(u32, u32)> = variants.into_iter().map(|c| (c, c)).collect();
			Expr::Class(CharClass::build(false, &ranges, 0))
		}
	}

	fn parse_inline_flags(&mut self) -> Result<Expr, PatternError> {
		let mut j = self.pos + 2;
		let mut neg = false;
		let mut set_cs: Option<bool> = None;
		let mut set_ml: Option<bool> = None;
		let mut count = 0usize;
		while let Some(&ch) = self.chars.get(j) {
			match ch {
				'i' => {
					set_cs = Some(neg);
					count += 1;
					j += 1;
				}
				'm' => {
					set_ml = Some(!neg);
					count += 1;
					j += 1;
				}
				'-' if !neg => {
					neg = true;
					j += 1;
				}
				')' => {
					if count == 0 {
						return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
					}
					if let Some(cs) = set_cs {
						self.case_sensitive = cs;
					}
					if let Some(ml) = set_ml {
						self.multiline = ml;
					}
					self.pos = j + 1;
					return Ok(Expr::Flag);
				}
				':' => {
					if count == 0 {
						return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
					}
					let saved_cs = self.case_sensitive;
					let saved_ml = self.multiline;
					if let Some(cs) = set_cs {
						self.case_sensitive = cs;
					}
					if let Some(ml) = set_ml {
						self.multiline = ml;
					}
					self.pos = j + 1;
					// WHY: Bound group nesting so deeply nested parens return PatternError instead of overflowing the 2 MiB search worker stack.
					if self.depth >= MAX_NESTING_DEPTH {
						return Err(too_large_err());
					}
					self.depth += 1;
					let inner = self.parse_alt()?;
					self.depth -= 1;
					self.case_sensitive = saved_cs;
					self.multiline = saved_ml;
					if self.chars.get(self.pos) != Some(&')') {
						return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
					}
					self.pos += 1;
					return Ok(inner);
				}
				_ => {
					return Err(PatternError(
						"REGEX_FLAGS: only (?i) and (?m) inline flags are supported; write another pattern"
							.to_string(),
					));
				}
			}
		}
		Err(syntax_err("the pattern is not a regular expression (check its brackets)"))
	}

	fn parse_atom(&mut self) -> Result<Expr, PatternError> {
		let c = self.chars[self.pos];
		match c {
			'\\' => {
				let (esc, end) = escape_at(self.chars, self.pos, false)?;
				self.pos = end;
				match esc {
					Escape::Char(ch) => Ok(self.literal_expr(ch)),
					Escape::Shorthand(flag) => Ok(Expr::Class(CharClass::from_shorthand(flag))),
					Escape::Assert(kind) => Ok(Expr::Assert(kind)),
				}
			}
			'[' => self.parse_class(),
			'(' => {
				if self.chars.get(self.pos + 1) != Some(&'?') {
					self.pos += 1;
				} else {
					let kind = self.chars.get(self.pos + 2).copied();
					match kind {
						Some(':') => {
							self.pos += 3;
						}
						Some('=' | '!') => {
							return Err(PatternError(
								"REGEX_LOOKAROUND: lookahead and lookbehind are not taken; search without them"
									.to_string(),
							));
						}
						Some('<') if matches!(self.chars.get(self.pos + 3), Some('=' | '!')) => {
							return Err(PatternError(
								"REGEX_LOOKAROUND: lookahead and lookbehind are not taken; search without them"
									.to_string(),
							));
						}
						Some('P') if self.chars.get(self.pos + 3) == Some(&'<') => {
							self.pos = self.skip_named_group(self.pos + 4)?;
						}
						Some('<') => {
							self.pos = self.skip_named_group(self.pos + 3)?;
						}
						_ => {
							return self.parse_inline_flags();
						}
					}
				}
				let saved_cs = self.case_sensitive;
				let saved_ml = self.multiline;
				if self.depth >= MAX_NESTING_DEPTH {
					return Err(too_large_err());
				}
				self.depth += 1;
				let inner = self.parse_alt()?;
				self.depth -= 1;
				self.case_sensitive = saved_cs;
				self.multiline = saved_ml;
				if self.chars.get(self.pos) != Some(&')') {
					return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
				}
				self.pos += 1;
				Ok(inner)
			}
			'.' => {
				self.pos += 1;
				Ok(Expr::AnyNoNl)
			}
			'^' => {
				self.pos += 1;
				Ok(Expr::Assert(if self.multiline { AssertKind::StartLine } else { AssertKind::StartText }))
			}
			'$' => {
				self.pos += 1;
				Ok(Expr::Assert(if self.multiline { AssertKind::EndLine } else { AssertKind::EndText }))
			}
			'*' | '+' | '?' => Err(syntax_err("the pattern is not a regular expression (check its brackets)")),
			'{' => {
				if self.try_parse_brace_count(self.pos).is_some() {
					return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
				}
				self.pos += 1;
				Ok(self.literal_expr('{'))
			}
			_ => {
				self.pos += 1;
				Ok(self.literal_expr(c))
			}
		}
	}

	fn skip_named_group(&self, start: usize) -> Result<usize, PatternError> {
		let close = self.chars[start..]
			.iter()
			.position(|&ch| ch == '>')
			.map(|rel| start + rel)
			.ok_or_else(|| syntax_err("a named group is (?<name>...)"))?;
		let name = &self.chars[start..close];
		if name.is_empty()
			|| !(name[0].is_ascii_alphabetic() || name[0] == '_')
			|| !name.iter().all(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
		{
			return Err(syntax_err("a named group is (?<name>...)"));
		}
		Ok(close + 1)
	}

	fn try_parse_brace_count(&self, open: usize) -> Option<(usize, Option<usize>, usize)> {
		let close = self.chars[open..].iter().position(|&ch| ch == '}').map(|rel| open + rel)?;
		let body = &self.chars[open + 1..close];
		if body.is_empty() {
			return None;
		}
		let comma = body.iter().position(|&ch| ch == ',');
		let (min_part, max_part) = match comma {
			None => (body, None),
			Some(idx) => (&body[..idx], Some(&body[idx + 1..])),
		};
		if min_part.is_empty() || min_part.len() > 4 || !min_part.iter().all(|ch| ch.is_ascii_digit()) {
			return None;
		}
		if let Some(mp) = max_part {
			if mp.len() > 4 || !mp.iter().all(|ch| ch.is_ascii_digit()) {
				return None;
			}
		}
		let min = min_part.iter().fold(0usize, |acc, &ch| acc * 10 + (ch as u8 - b'0') as usize);
		let max = match max_part {
			None => Some(min),
			Some([]) => None,
			Some(mp) => Some(mp.iter().fold(0usize, |acc, &ch| acc * 10 + (ch as u8 - b'0') as usize)),
		};
		Some((min, max, close + 1))
	}

	fn parse_quantifier(&mut self, atom: Expr) -> Result<Expr, PatternError> {
		let Some(&c) = self.chars.get(self.pos) else {
			return Ok(atom);
		};
		let (min, max, next_pos) = match c {
			'*' => (0usize, None, self.pos + 1),
			'+' => (1usize, None, self.pos + 1),
			'?' => (0usize, Some(1), self.pos + 1),
			'{' => match self.try_parse_brace_count(self.pos) {
				Some(parsed) => parsed,
				None => return Ok(atom),
			},
			_ => return Ok(atom),
		};
		if matches!(atom, Expr::Assert(_) | Expr::Flag) {
			return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
		}
		if let Some(m) = max {
			if m < min {
				return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
			}
			if m > MAX_QUANTIFIER_COUNT {
				return Err(too_large_err());
			}
		}
		if min > MAX_QUANTIFIER_COUNT {
			return Err(too_large_err());
		}
		self.pos = next_pos;
		if self.chars.get(self.pos) == Some(&'?') {
			self.pos += 1;
		}
		if let Some(&after) = self.chars.get(self.pos) {
			if matches!(after, '*' | '+' | '?') || (after == '{' && self.try_parse_brace_count(self.pos).is_some()) {
				return Err(syntax_err("the pattern is not a regular expression (check its brackets)"));
			}
		}
		Ok(Expr::Repeat { inner: Box::new(atom), min, max })
	}

	fn parse_class(&mut self) -> Result<Expr, PatternError> {
		let mut j = self.pos + 1;
		let negated = self.chars.get(j) == Some(&'^');
		if negated {
			j += 1;
		}
		let mut ranges: Vec<(u32, u32)> = Vec::new();
		let mut shorthands: u8 = 0;
		let mut first = true;
		while self.chars.get(j) != Some(&']') || first {
			first = false;
			let (lo_code, lo_short, lo_end) = self.class_member(j)?;
			if let Some(flag) = lo_short {
				shorthands |= flag;
				j = lo_end;
				continue;
			}
			let lo = lo_code.unwrap();
			let mut hi = lo;
			let mut next_j = lo_end;
			if self.chars.get(lo_end) == Some(&'-')
				&& self.chars.get(lo_end + 1).is_some()
				&& self.chars.get(lo_end + 1) != Some(&']')
			{
				let (hi_code, hi_short, hi_end) = self.class_member(lo_end + 1)?;
				if hi_short.is_some() {
					return Err(syntax_err("a range ends at a character, not a class"));
				}
				hi = hi_code.unwrap();
				if hi < lo {
					return Err(syntax_err("a range in [ ] is out of order"));
				}
				next_j = hi_end;
			}
			if hi > 0xffff {
				return Err(syntax_err("[ ] takes characters up to U+FFFF only"));
			}
			ranges.push((lo, hi));
			j = next_j;
			if self.chars.get(j).is_none() {
				return Err(syntax_err("a [ has no ]"));
			}
		}
		if self.case_sensitive {
			self.saw_cs = true;
		} else {
			self.saw_ci = true;
			let mut added = Vec::new();
			let mut variants = Vec::new();
			for &(lo, hi) in &ranges {
				if lo < 128 {
					for code in lo..=hi.min(127) {
						if let Some(ch) = char::from_u32(code) {
							if self.folded_input {
								let folded = fold_char(ch);
								let mut it = folded.chars();
								if let (Some(f), None) = (it.next(), it.next()) {
									let f_code = f as u32;
									if f_code < lo || f_code > hi {
										added.push((f_code, f_code));
									}
								}
							} else {
								variants.clear();
								expand_unfolded_case(ch, &mut variants);
								for &v in &variants {
									if v < lo || v > hi {
										added.push((v, v));
									}
								}
							}
						}
					}
				}
				if hi >= 128 {
					let non_ascii_lo = lo.max(128);
					let table = if self.folded_input { bmp_folded_map() } else { bmp_unfolded_map() };
					let start = table.partition_point(|&(cp, _)| cp < non_ascii_lo);
					for &(cp, target) in &table[start..] {
						if cp > hi {
							break;
						}
						if target < lo || target > hi {
							added.push((target, target));
						}
					}
				}
			}
			ranges.extend(added);
		}
		self.pos = j + 1;
		Ok(Expr::Class(CharClass::build(negated, &ranges, shorthands)))
	}

	fn class_member(&self, at: usize) -> Result<(Option<u32>, Option<u8>, usize), PatternError> {
		let Some(&c) = self.chars.get(at) else {
			return Err(syntax_err("a [ has no ]"));
		};
		if c == '[' && self.chars.get(at + 1) == Some(&':') {
			return Err(syntax_err("[:alpha:] classes are not taken; write [a-zA-Z] or \\w"));
		}
		if c == '\\' {
			let (esc, end) = escape_at(self.chars, at, true)?;
			return match esc {
				Escape::Char(ch) => Ok((Some(ch as u32), None, end)),
				Escape::Shorthand(flag) => Ok((None, Some(flag), end)),
				Escape::Assert(_) => unreachable!(),
			};
		}
		Ok((Some(c as u32), None, at + 1))
	}
}

#[derive(Debug, Clone)]
enum Inst {
	Char(char),
	AnyNoNl,
	Class(usize),
	Split(usize, usize),
	Jump(usize),
	Assert(AssertKind),
	Match,
}

struct Compiler {
	insts: Vec<Inst>,
	classes: Vec<CharClass>,
}

impl Compiler {
	fn compile(expr: &Expr) -> Result<(Vec<Inst>, Vec<CharClass>), PatternError> {
		let mut c = Self { insts: Vec::new(), classes: Vec::new() };
		c.emit(expr, 1)?;
		c.push(Inst::Match)?;
		Ok((c.insts, c.classes))
	}

	fn push(&mut self, inst: Inst) -> Result<usize, PatternError> {
		if self.insts.len() >= MAX_NFA_INSTS {
			return Err(too_large_err());
		}
		let idx = self.insts.len();
		self.insts.push(inst);
		Ok(idx)
	}

	fn emit(&mut self, expr: &Expr, rep_factor: usize) -> Result<(), PatternError> {
		match expr {
			Expr::Empty | Expr::Flag => Ok(()),
			Expr::Char(ch) => {
				self.push(Inst::Char(*ch))?;
				Ok(())
			}
			Expr::AnyNoNl => {
				self.push(Inst::AnyNoNl)?;
				Ok(())
			}
			Expr::Class(cc) => {
				let idx = self.classes.len();
				self.classes.push(cc.clone());
				self.push(Inst::Class(idx))?;
				Ok(())
			}
			Expr::Assert(kind) => {
				self.push(Inst::Assert(*kind))?;
				Ok(())
			}
			Expr::Concat(parts) => {
				for part in parts {
					self.emit(part, rep_factor)?;
				}
				Ok(())
			}
			Expr::Alt(branches) => {
				let mut jumps = Vec::with_capacity(branches.len().saturating_sub(1));
				for (i, branch) in branches.iter().enumerate() {
					let is_last = i + 1 == branches.len();
					let split = if !is_last { Some(self.push(Inst::Split(0, 0))?) } else { None };
					let branch_start = self.insts.len();
					self.emit(branch, rep_factor)?;
					if !is_last {
						jumps.push(self.push(Inst::Jump(0))?);
					}
					if let Some(sp) = split {
						let next_branch = self.insts.len();
						self.insts[sp] = Inst::Split(branch_start, next_branch);
					}
				}
				let end = self.insts.len();
				for j in jumps {
					self.insts[j] = Inst::Jump(end);
				}
				Ok(())
			}
			Expr::Repeat { inner, min, max } => {
				let count = max.unwrap_or(*min).max(1);
				let next_factor = rep_factor.saturating_mul(count);
				if rep_factor > 1 && count > 1 && next_factor > MAX_QUANTIFIER_COUNT {
					return Err(too_large_err());
				}
				for _ in 0..*min {
					self.emit(inner, next_factor)?;
				}
				match max {
					None => {
						let split = self.push(Inst::Split(0, 0))?;
						let body = self.insts.len();
						self.emit(inner, next_factor)?;
						self.push(Inst::Jump(split))?;
						let end = self.insts.len();
						self.insts[split] = Inst::Split(body, end);
					}
					Some(m) => {
						for _ in *min..*m {
							let split = self.push(Inst::Split(0, 0))?;
							let body = self.insts.len();
							self.emit(inner, next_factor)?;
							let end = self.insts.len();
							self.insts[split] = Inst::Split(body, end);
						}
					}
				}
				Ok(())
			}
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrigramQuery {
	All,
	Exact(u32),
	And(Vec<TrigramQuery>),
	Or(Vec<TrigramQuery>),
}

impl TrigramQuery {
	fn depth(&self) -> usize {
		match self {
			Self::All | Self::Exact(_) => 1,
			Self::And(xs) | Self::Or(xs) => 1 + xs.iter().map(Self::depth).max().unwrap_or(0),
		}
	}
}

fn bound_trigram_depth(q: TrigramQuery) -> TrigramQuery {
	// WHY: Bound recursive TrigramQuery trees so downstream compilation and evaluation cannot overflow the search worker stack.
	if q.depth() > MAX_TRIGRAM_DEPTH { TrigramQuery::All } else { q }
}

pub fn trigrams_of_bytes(bytes: &[u8]) -> TrigramQuery {
	if bytes.len() < 3 {
		return TrigramQuery::All;
	}
	let mut set = BTreeSet::new();
	for w in bytes.windows(3) {
		set.insert(((w[0] as u32) << 16) | ((w[1] as u32) << 8) | (w[2] as u32));
	}
	if set.len() == 1 {
		TrigramQuery::Exact(*set.iter().next().unwrap())
	} else {
		TrigramQuery::And(set.into_iter().map(TrigramQuery::Exact).collect())
	}
}

fn q_and(a: TrigramQuery, b: TrigramQuery) -> TrigramQuery {
	let out = match (a, b) {
		(TrigramQuery::All, x) | (x, TrigramQuery::All) => x,
		(TrigramQuery::And(mut xs), TrigramQuery::And(ys)) => {
			for y in ys {
				if !xs.contains(&y) {
					xs.push(y);
				}
			}
			simplify_and(xs)
		}
		(TrigramQuery::And(mut xs), y) => {
			if !xs.contains(&y) {
				xs.push(y);
			}
			simplify_and(xs)
		}
		(x, TrigramQuery::And(mut ys)) => {
			if !ys.contains(&x) {
				ys.push(x);
			}
			simplify_and(ys)
		}
		(x, y) if x == y => x,
		(x, y) => TrigramQuery::And(vec![x, y]),
	};
	bound_trigram_depth(out)
}

fn simplify_and(mut xs: Vec<TrigramQuery>) -> TrigramQuery {
	xs.retain(|q| !matches!(q, TrigramQuery::All));
	match xs.len() {
		0 => TrigramQuery::All,
		1 => xs.pop().unwrap(),
		_ => TrigramQuery::And(xs),
	}
}

fn q_or(a: TrigramQuery, b: TrigramQuery) -> TrigramQuery {
	let out = match (a, b) {
		(TrigramQuery::All, _) | (_, TrigramQuery::All) => TrigramQuery::All,
		(TrigramQuery::Or(mut xs), TrigramQuery::Or(ys)) => {
			for y in ys {
				if !xs.contains(&y) {
					xs.push(y);
				}
			}
			if xs.len() > MAX_TRIGRAM_OR { TrigramQuery::All } else { TrigramQuery::Or(xs) }
		}
		(TrigramQuery::Or(mut xs), y) => {
			if !xs.contains(&y) {
				xs.push(y);
			}
			if xs.len() > MAX_TRIGRAM_OR { TrigramQuery::All } else { TrigramQuery::Or(xs) }
		}
		(x, TrigramQuery::Or(mut ys)) => {
			if !ys.contains(&x) {
				ys.push(x);
			}
			if ys.len() > MAX_TRIGRAM_OR { TrigramQuery::All } else { TrigramQuery::Or(ys) }
		}
		(x, y) if x == y => x,
		(x, y) => TrigramQuery::Or(vec![x, y]),
	};
	bound_trigram_depth(out)
}

fn trigrams_of_any(strings: &[String]) -> TrigramQuery {
	if strings.is_empty() {
		return TrigramQuery::All;
	}
	let mut acc: Option<TrigramQuery> = None;
	for s in strings {
		let q = trigrams_of_bytes(s.as_bytes());
		acc = Some(match acc {
			None => q,
			Some(prev) => q_or(prev, q),
		});
		if matches!(acc, Some(TrigramQuery::All)) {
			return TrigramQuery::All;
		}
	}
	acc.unwrap_or(TrigramQuery::All)
}

fn cartesian(a: &[String], b: &[String]) -> Option<Vec<String>> {
	if a.is_empty() || b.is_empty() || a.len().saturating_mul(b.len()) > MAX_TRIGRAM_EXACT {
		return None;
	}
	let mut out = BTreeSet::new();
	for x in a {
		for y in b {
			if x.len() + y.len() > MAX_EXACT_STR_LEN {
				return None;
			}
			let mut joined = String::with_capacity(x.len() + y.len());
			joined.push_str(x);
			joined.push_str(y);
			out.insert(joined);
			if out.len() > MAX_TRIGRAM_EXACT {
				return None;
			}
		}
	}
	Some(out.into_iter().collect())
}

struct AstInfo {
	exact: Option<Vec<String>>,
	prefix: Vec<String>,
	suffix: Vec<String>,
	query: TrigramQuery,
	required: Vec<String>,
}

fn merge_required(mut a: Vec<String>, b: Vec<String>) -> Vec<String> {
	for s in b {
		if !s.is_empty() && !a.iter().any(|existing| existing.contains(&s)) {
			a.retain(|existing| !s.contains(existing));
			a.push(s);
		}
	}
	a.sort_by(|x, y| y.len().cmp(&x.len()));
	a.truncate(4);
	a
}

fn analyze(expr: &Expr) -> AstInfo {
	match expr {
		Expr::Empty | Expr::Flag | Expr::Assert(_) => AstInfo {
			exact: Some(vec![String::new()]),
			prefix: vec![String::new()],
			suffix: vec![String::new()],
			query: TrigramQuery::All,
			required: Vec::new(),
		},
		Expr::Char(ch) => {
			let s = fold_char(*ch);
			let query = trigrams_of_bytes(s.as_bytes());
			let req = if !s.is_empty() { vec![s.clone()] } else { Vec::new() };
			AstInfo { exact: Some(vec![s.clone()]), prefix: vec![s.clone()], suffix: vec![s], query, required: req }
		}
		Expr::AnyNoNl => AstInfo {
			exact: None,
			prefix: Vec::new(),
			suffix: Vec::new(),
			query: TrigramQuery::All,
			required: Vec::new(),
		},
		Expr::Class(cc) => match cc.small_folded_literals() {
			Some(lits) => {
				let query = trigrams_of_any(&lits);
				let required = if lits.len() == 1 && !lits[0].is_empty() { vec![lits[0].clone()] } else { Vec::new() };
				AstInfo { exact: Some(lits.clone()), prefix: lits.clone(), suffix: lits, query, required }
			}
			None => AstInfo {
				exact: None,
				prefix: Vec::new(),
				suffix: Vec::new(),
				query: TrigramQuery::All,
				required: Vec::new(),
			},
		},
		Expr::Concat(parts) => {
			let mut acc = AstInfo {
				exact: Some(vec![String::new()]),
				prefix: vec![String::new()],
				suffix: vec![String::new()],
				query: TrigramQuery::All,
				required: Vec::new(),
			};
			for part in parts {
				let b = analyze(part);
				let mut query = q_and(acc.query, b.query);
				let mut required = merge_required(acc.required, b.required);
				let (exact, prefix, suffix) = match (&acc.exact, &b.exact) {
					(Some(ax), Some(bx)) => match cartesian(ax, bx) {
						Some(joined) => {
							query = q_and(query, trigrams_of_any(&joined));
							if joined.len() == 1 && !joined[0].is_empty() {
								required = merge_required(required, vec![joined[0].clone()]);
							}
							(Some(joined.clone()), joined.clone(), joined)
						}
						None => {
							if let Some(cross) = cartesian(&acc.suffix, &b.prefix) {
								query = q_and(query, trigrams_of_any(&cross));
								if cross.len() == 1 && !cross[0].is_empty() {
									required = merge_required(required, vec![cross[0].clone()]);
								}
							}
							(None, acc.prefix, b.suffix)
						}
					},
					_ => {
						if let Some(cross) = cartesian(&acc.suffix, &b.prefix) {
							query = q_and(query, trigrams_of_any(&cross));
							if cross.len() == 1 && !cross[0].is_empty() {
								required = merge_required(required, vec![cross[0].clone()]);
							}
						}
						let prefix = match (&acc.exact, b.prefix.is_empty()) {
							(Some(ax), false) => cartesian(ax, &b.prefix).unwrap_or_else(|| acc.prefix.clone()),
							_ => acc.prefix,
						};
						let suffix = match (acc.suffix.is_empty(), &b.exact) {
							(false, Some(bx)) => cartesian(&acc.suffix, bx).unwrap_or_else(|| b.suffix.clone()),
							_ => b.suffix,
						};
						(None, prefix, suffix)
					}
				};
				acc = AstInfo { exact, prefix, suffix, query, required };
			}
			acc
		}
		Expr::Alt(branches) => {
			let infos: Vec<AstInfo> = branches.iter().map(analyze).collect();
			let mut query: Option<TrigramQuery> = None;
			for info in &infos {
				query = Some(match query {
					None => info.query.clone(),
					Some(prev) => q_or(prev, info.query.clone()),
				});
			}
			let query = query.unwrap_or(TrigramQuery::All);
			let mut all_exact = BTreeSet::new();
			let mut exact_ok = true;
			for info in &infos {
				match &info.exact {
					Some(xs) => {
						for x in xs {
							all_exact.insert(x.clone());
							if all_exact.len() > MAX_TRIGRAM_EXACT {
								exact_ok = false;
								break;
							}
						}
					}
					None => exact_ok = false,
				}
				if !exact_ok {
					break;
				}
			}
			let exact = if exact_ok { Some(all_exact.into_iter().collect::<Vec<_>>()) } else { None };
			let prefix = exact.clone().unwrap_or_default();
			let suffix = exact.clone().unwrap_or_default();
			AstInfo { exact, prefix, suffix, query, required: Vec::new() }
		}
		Expr::Repeat { inner, min, max } => {
			if *min == 0 {
				if *max == Some(0) {
					return analyze(&Expr::Empty);
				}
				return AstInfo {
					exact: None,
					prefix: Vec::new(),
					suffix: Vec::new(),
					query: TrigramQuery::All,
					required: Vec::new(),
				};
			}
			let info = analyze(inner);
			if *max == Some(*min) && *min <= 4 {
				if let Some(xs) = &info.exact {
					let mut acc = xs.clone();
					let mut ok = true;
					for _ in 1..*min {
						match cartesian(&acc, xs) {
							Some(next) => acc = next,
							None => {
								ok = false;
								break;
							}
						}
					}
					if ok {
						let query = q_and(info.query, trigrams_of_any(&acc));
						let required = if acc.len() == 1 && !acc[0].is_empty() {
							vec![acc[0].clone()]
						} else {
							info.required
						};
						return AstInfo { exact: Some(acc.clone()), prefix: acc.clone(), suffix: acc, query, required };
					}
				}
			}
			let mut query = info.query;
			if *min >= 2 {
				if let Some(cross) = cartesian(&info.suffix, &info.prefix) {
					query = q_and(query, trigrams_of_any(&cross));
				}
			}
			AstInfo { exact: None, prefix: info.prefix, suffix: info.suffix, query, required: info.required }
		}
	}
}

struct ExactInfo {
	exact: Option<String>,
	prefix: String,
	suffix: String,
	required: Vec<String>,
}

fn analyze_exact(expr: &Expr) -> ExactInfo {
	match expr {
		Expr::Empty | Expr::Flag | Expr::Assert(_) => ExactInfo {
			exact: Some(String::new()),
			prefix: String::new(),
			suffix: String::new(),
			required: Vec::new(),
		},
		Expr::Char(ch) => {
			let s = ch.to_string();
			ExactInfo { exact: Some(s.clone()), prefix: s.clone(), suffix: s.clone(), required: vec![s] }
		}
		Expr::AnyNoNl => ExactInfo {
			exact: None,
			prefix: String::new(),
			suffix: String::new(),
			required: Vec::new(),
		},
		Expr::Class(cc) => match cc.single_exact_char() {
			Some(ch) => {
				let s = ch.to_string();
				ExactInfo { exact: Some(s.clone()), prefix: s.clone(), suffix: s.clone(), required: vec![s] }
			}
			None => ExactInfo {
				exact: None,
				prefix: String::new(),
				suffix: String::new(),
				required: Vec::new(),
			},
		},
		Expr::Concat(parts) => {
			let mut acc = ExactInfo {
				exact: Some(String::new()),
				prefix: String::new(),
				suffix: String::new(),
				required: Vec::new(),
			};
			for part in parts {
				let b = analyze_exact(part);
				let mut required = merge_required(acc.required, b.required);
				let (exact, prefix, suffix) = match (&acc.exact, &b.exact) {
					(Some(ax), Some(bx)) if ax.len() + bx.len() <= MAX_EXACT_STR_LEN => {
						let mut joined = String::with_capacity(ax.len() + bx.len());
						joined.push_str(ax);
						joined.push_str(bx);
						if !joined.is_empty() {
							required = merge_required(required, vec![joined.clone()]);
						}
						(Some(joined.clone()), joined.clone(), joined)
					}
					_ => {
						if !acc.suffix.is_empty()
							&& !b.prefix.is_empty()
							&& acc.suffix.len() + b.prefix.len() <= MAX_EXACT_STR_LEN
						{
							let mut cross = String::with_capacity(acc.suffix.len() + b.prefix.len());
							cross.push_str(&acc.suffix);
							cross.push_str(&b.prefix);
							required = merge_required(required, vec![cross]);
						}
						let prefix = match &acc.exact {
							Some(ax) if ax.len() + b.prefix.len() <= MAX_EXACT_STR_LEN => {
								let mut p = String::with_capacity(ax.len() + b.prefix.len());
								p.push_str(ax);
								p.push_str(&b.prefix);
								p
							}
							_ => acc.prefix,
						};
						let suffix = match &b.exact {
							Some(bx) if acc.suffix.len() + bx.len() <= MAX_EXACT_STR_LEN => {
								let mut s = String::with_capacity(acc.suffix.len() + bx.len());
								s.push_str(&acc.suffix);
								s.push_str(bx);
								s
							}
							_ => b.suffix,
						};
						(None, prefix, suffix)
					}
				};
				acc = ExactInfo { exact, prefix, suffix, required };
			}
			acc
		}
		Expr::Alt(branches) => {
			let infos: Vec<ExactInfo> = branches.iter().map(analyze_exact).collect();
			if let Some(first) = infos.first().and_then(|i| i.exact.as_ref()) {
				if infos.iter().all(|i| i.exact.as_ref() == Some(first)) {
					let req = if first.is_empty() { Vec::new() } else { vec![first.clone()] };
					return ExactInfo {
						exact: Some(first.clone()),
						prefix: first.clone(),
						suffix: first.clone(),
						required: req,
					};
				}
			}
			ExactInfo { exact: None, prefix: String::new(), suffix: String::new(), required: Vec::new() }
		}
		Expr::Repeat { inner, min, max } => {
			if *min == 0 {
				if *max == Some(0) {
					return analyze_exact(&Expr::Empty);
				}
				return ExactInfo { exact: None, prefix: String::new(), suffix: String::new(), required: Vec::new() };
			}
			let info = analyze_exact(inner);
			if *max == Some(*min) {
				if let Some(s) = &info.exact {
					if s.len().saturating_mul(*min) <= MAX_EXACT_STR_LEN {
						let repeated = s.repeat(*min);
						let req = if repeated.is_empty() { Vec::new() } else { vec![repeated.clone()] };
						return ExactInfo {
							exact: Some(repeated.clone()),
							prefix: repeated.clone(),
							suffix: repeated,
							required: req,
						};
					}
				}
			}
			let mut required = info.required;
			if *min >= 2
				&& !info.suffix.is_empty()
				&& !info.prefix.is_empty()
				&& info.suffix.len() + info.prefix.len() <= MAX_EXACT_STR_LEN
			{
				let mut cross = String::with_capacity(info.suffix.len() + info.prefix.len());
				cross.push_str(&info.suffix);
				cross.push_str(&info.prefix);
				required = merge_required(required, vec![cross]);
			}
			ExactInfo { exact: None, prefix: info.prefix, suffix: info.suffix, required }
		}
	}
}

pub fn find_subslice_ascii_icase(haystack: &[u8], needle_lower: &[u8]) -> Option<usize> {
	if needle_lower.is_empty() {
		return Some(0);
	}
	if needle_lower.len() > haystack.len() {
		return None;
	}
	let first = needle_lower[0];
	let last_idx = needle_lower.len() - 1;
	let last = needle_lower[last_idx];
	let first_is_alpha = first.is_ascii_lowercase();
	let limit = haystack.len() - needle_lower.len() + 1;
	let mut i = 0usize;
	while i < limit {
		let rel = if first_is_alpha {
			haystack[i..limit].iter().position(|&b| (b | 0x20) == first)
		} else {
			haystack[i..limit].iter().position(|&b| b == first)
		};
		let Some(rel) = rel else {
			return None;
		};
		let pos = i + rel;
		if haystack[pos + last_idx].to_ascii_lowercase() == last
			&& haystack[pos..pos + needle_lower.len()].eq_ignore_ascii_case(needle_lower)
		{
			return Some(pos);
		}
		i = pos + 1;
	}
	None
}

#[derive(Debug, Clone)]
pub struct Regex {
	insts: Vec<Inst>,
	classes: Vec<CharClass>,
	trigram_query: TrigramQuery,
	required_folded_literals: Vec<String>,
	required_exact_literals: Vec<String>,
	run_on_folded: bool,
	has_text_anchor: bool,
}

pub struct ExecScratch {
	curr: Vec<(usize, usize)>,
	next: Vec<(usize, usize)>,
	stack: Vec<(usize, usize)>,
	visited: Vec<u32>,
	gen: u32,
}

impl ExecScratch {
	pub fn new() -> Self {
		Self { curr: Vec::new(), next: Vec::new(), stack: Vec::new(), visited: Vec::new(), gen: 0 }
	}

	fn next_gen(&mut self, n_states: usize) -> u32 {
		if self.visited.len() < n_states {
			self.visited.resize(n_states, 0);
		}
		self.gen = self.gen.wrapping_add(1);
		if self.gen == 0 {
			self.visited.fill(0);
			self.gen = 1;
		}
		self.gen
	}
}

impl Default for ExecScratch {
	fn default() -> Self {
		Self::new()
	}
}

impl Regex {
	pub fn compile(pattern: &str, case_sensitive: bool) -> Result<Self, PatternError> {
		if pattern.len() > MAX_PATTERN_BYTES {
			return Err(too_large_err());
		}
		let chars: Vec<char> = pattern.chars().collect();
		let (expr, run_on_folded) = Parser::parse(&chars, case_sensitive)?;
		let (insts, classes) = Compiler::compile(&expr)?;
		let has_text_anchor = insts
			.iter()
			.any(|inst| matches!(inst, Inst::Assert(AssertKind::StartText | AssertKind::EndText)));
		let info = analyze(&expr);
		let required_folded_literals: Vec<String> = info
			.required
			.into_iter()
			.filter(|s| s.len() >= 2)
			.collect();
		let required_exact_literals: Vec<String> = if run_on_folded {
			Vec::new()
		} else {
			analyze_exact(&expr)
				.required
				.into_iter()
				.filter(|s| s.len() >= 2)
				.collect()
		};
		Ok(Self {
			insts,
			classes,
			trigram_query: info.query,
			required_folded_literals,
			required_exact_literals,
			run_on_folded,
			has_text_anchor,
		})
	}

	pub fn trigram_query(&self) -> &TrigramQuery {
		&self.trigram_query
	}

	pub fn has_text_anchor(&self) -> bool {
		self.has_text_anchor
	}

	pub fn required_folded_literals(&self) -> &[String] {
		&self.required_folded_literals
	}

	pub fn required_exact_literals(&self) -> &[String] {
		&self.required_exact_literals
	}

	pub fn runs_on_folded(&self) -> bool {
		self.run_on_folded
	}

	pub fn find_in_folded(&self, folded_text: &str, scratch: &mut ExecScratch) -> Option<usize> {
		if self.run_on_folded {
			for lit in &self.required_folded_literals {
				if !folded_text.contains(lit.as_str()) {
					return None;
				}
			}
		}
		self.run_nfa(folded_text, scratch)
	}

	pub fn find_in_ascii_folded(&self, ascii_bytes: &[u8], scratch: &mut ExecScratch) -> Option<usize> {
		for lit in &self.required_folded_literals {
			if !lit.is_ascii() {
				return None;
			}
			if find_subslice_ascii_icase(ascii_bytes, lit.as_bytes()).is_none() {
				return None;
			}
		}
		self.run_nfa_ascii_folded(ascii_bytes, scratch)
	}

	pub fn find_in_text(&self, text: &str, scratch: &mut ExecScratch) -> Option<usize> {
		if !self.run_on_folded {
			for lit in &self.required_exact_literals {
				if !text.contains(lit.as_str()) {
					return None;
				}
			}
			if text.is_ascii() {
				for lit in &self.required_folded_literals {
					if !lit.is_ascii() || find_subslice_ascii_icase(text.as_bytes(), lit.as_bytes()).is_none() {
						return None;
					}
				}
			}
			self.run_nfa(text, scratch)
		} else if text.is_ascii() {
			self.find_in_ascii_folded(text.as_bytes(), scratch)
		} else {
			let folded = fold_text(text);
			self.find_in_folded(&folded, scratch)
		}
	}

	fn add_state(
		&self,
		state: usize,
		start: usize,
		prev: Option<char>,
		curr: Option<char>,
		gen: u32,
		visited: &mut [u32],
		out: &mut Vec<(usize, usize)>,
		stack: &mut Vec<(usize, usize)>,
		best_start: &mut Option<usize>,
	) {
		stack.clear();
		stack.push((state, start));
		while let Some((s, st)) = stack.pop() {
			if best_start.is_some_and(|best| st >= best) {
				continue;
			}
			if visited[s] == gen {
				continue;
			}
			visited[s] = gen;
			match self.insts[s] {
				Inst::Jump(target) => stack.push((target, st)),
				Inst::Split(a, b) => {
					stack.push((b, st));
					stack.push((a, st));
				}
				Inst::Assert(kind) => {
					let holds = match kind {
						AssertKind::StartLine => prev.is_none() || prev == Some('\n'),
						AssertKind::EndLine => curr.is_none() || curr == Some('\n'),
						AssertKind::StartText => prev.is_none(),
						AssertKind::EndText => curr.is_none(),
						AssertKind::WordBoundary => {
							prev.is_some_and(is_word_char) != curr.is_some_and(is_word_char)
						}
						AssertKind::NonWordBoundary => {
							prev.is_some_and(is_word_char) == curr.is_some_and(is_word_char)
						}
					};
					if holds {
						stack.push((s + 1, st));
					}
				}
				Inst::Match => {
					*best_start = Some(best_start.map_or(st, |best| best.min(st)));
				}
				Inst::Char(_) | Inst::AnyNoNl | Inst::Class(_) => {
					out.push((s, st));
				}
			}
		}
	}

	fn run_nfa_ascii_folded(&self, bytes: &[u8], scratch: &mut ExecScratch) -> Option<usize> {
		let n_states = self.insts.len();
		scratch.curr.clear();
		scratch.next.clear();
		let mut best_start: Option<usize> = None;
		let first_ch = bytes.first().map(|&b| b.to_ascii_lowercase() as char);
		let gen0 = scratch.next_gen(n_states);
		self.add_state(
			0,
			0,
			None,
			first_ch,
			gen0,
			&mut scratch.visited,
			&mut scratch.curr,
			&mut scratch.stack,
			&mut best_start,
		);
		if best_start == Some(0) {
			return Some(0);
		}
		for pos in 0..bytes.len() {
			let ch = bytes[pos].to_ascii_lowercase() as char;
			let next_pos = pos + 1;
			let peek_next = bytes.get(next_pos).map(|&b| b.to_ascii_lowercase() as char);
			scratch.next.clear();
			let gen = scratch.next_gen(n_states);
			for i in 0..scratch.curr.len() {
				let (s, st) = scratch.curr[i];
				if best_start.is_some_and(|best| st >= best) {
					break;
				}
				let matched = match self.insts[s] {
					Inst::Char(expected) => ch == expected,
					Inst::AnyNoNl => !is_line_terminator(ch),
					Inst::Class(idx) => self.classes[idx].matches(ch),
					_ => false,
				};
				if matched {
					self.add_state(
						s + 1,
						st,
						Some(ch),
						peek_next,
						gen,
						&mut scratch.visited,
						&mut scratch.next,
						&mut scratch.stack,
						&mut best_start,
					);
				}
			}
			if best_start.is_none() {
				self.add_state(
					0,
					next_pos,
					Some(ch),
					peek_next,
					gen,
					&mut scratch.visited,
					&mut scratch.next,
					&mut scratch.stack,
					&mut best_start,
				);
			}
			std::mem::swap(&mut scratch.curr, &mut scratch.next);
			if let Some(best) = best_start {
				if scratch.curr.first().is_none_or(|&(_, st)| st >= best) {
					return Some(best);
				}
			}
		}
		best_start
	}

	fn run_nfa(&self, text: &str, scratch: &mut ExecScratch) -> Option<usize> {
		let n_states = self.insts.len();
		scratch.curr.clear();
		scratch.next.clear();
		let mut best_start: Option<usize> = None;
		let mut chars = text.char_indices().peekable();
		let first_ch = chars.peek().map(|&(_, c)| c);
		let gen0 = scratch.next_gen(n_states);
		self.add_state(
			0,
			0,
			None,
			first_ch,
			gen0,
			&mut scratch.visited,
			&mut scratch.curr,
			&mut scratch.stack,
			&mut best_start,
		);
		if best_start == Some(0) {
			return Some(0);
		}
		while let Some((pos, ch)) = chars.next() {
			let next_pos = pos + ch.len_utf8();
			let peek_next = chars.peek().map(|&(_, c)| c);
			scratch.next.clear();
			let gen = scratch.next_gen(n_states);
			for i in 0..scratch.curr.len() {
				let (s, st) = scratch.curr[i];
				if best_start.is_some_and(|best| st >= best) {
					break;
				}
				let matched = match self.insts[s] {
					Inst::Char(expected) => ch == expected,
					Inst::AnyNoNl => !is_line_terminator(ch),
					Inst::Class(idx) => self.classes[idx].matches(ch),
					_ => false,
				};
				if matched {
					self.add_state(
						s + 1,
						st,
						Some(ch),
						peek_next,
						gen,
						&mut scratch.visited,
						&mut scratch.next,
						&mut scratch.stack,
						&mut best_start,
					);
				}
			}
			if best_start.is_none() {
				self.add_state(
					0,
					next_pos,
					Some(ch),
					peek_next,
					gen,
					&mut scratch.visited,
					&mut scratch.next,
					&mut scratch.stack,
					&mut best_start,
				);
			}
			std::mem::swap(&mut scratch.curr, &mut scratch.next);
			if let Some(best) = best_start {
				if scratch.curr.first().is_none_or(|&(_, st)| st >= best) {
					return Some(best);
				}
			}
		}
		best_start
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::time::Instant;

	fn matches(pattern: &str, subject: &str, case_sensitive: bool) -> bool {
		let re = Regex::compile(pattern, case_sensitive).expect("pattern compiles");
		let mut scratch = ExecScratch::new();
		re.find_in_text(subject, &mut scratch).is_some()
	}

	fn find_idx(pattern: &str, subject: &str, case_sensitive: bool) -> Option<usize> {
		let re = Regex::compile(pattern, case_sensitive).expect("pattern compiles");
		let mut scratch = ExecScratch::new();
		re.find_in_text(subject, &mut scratch)
	}

	#[test]
	fn rejects_unsupported_and_invalid_patterns_with_exact_error_codes() {
		let cases = [
			("(a)\\1", "REGEX_BACKREFERENCE: "),
			("(?<x>a)\\k<x>", "REGEX_BACKREFERENCE: "),
			("a(?=b)", "REGEX_LOOKAROUND: "),
			("a(?!b)", "REGEX_LOOKAROUND: "),
			("(?<=a)b", "REGEX_LOOKAROUND: "),
			("(?<!a)b", "REGEX_LOOKAROUND: "),
			("(?s)a", "REGEX_FLAGS: "),
			("(?u)a", "REGEX_FLAGS: "),
			("(?x)a", "REGEX_FLAGS: "),
			("a{1,100}", "REGEX_TOO_LARGE: "),
			("a{65}", "REGEX_TOO_LARGE: "),
			("(a{1,10}){1,10}", "REGEX_TOO_LARGE: "),
			("[a", "REGEX_SYNTAX: "),
			("a)", "REGEX_SYNTAX: "),
			("(a", "REGEX_SYNTAX: "),
			("a\\", "REGEX_SYNTAX: "),
			("a{5,2}", "REGEX_SYNTAX: "),
			("*abc", "REGEX_SYNTAX: "),
			("a**", "REGEX_SYNTAX: "),
			("\\q", "REGEX_ESCAPE: "),
			("\\p{L}", "REGEX_ESCAPE: "),
			("\\P{ASCII}", "REGEX_ESCAPE: "),
			("\\01", "REGEX_ESCAPE: "),
			("\\x1", "REGEX_ESCAPE: "),
			("\\x{110000}", "REGEX_ESCAPE: "),
			("\\x{D800}", "REGEX_ESCAPE: "),
			("\\u123", "REGEX_ESCAPE: "),
			("\\c1", "REGEX_ESCAPE: "),
			("[\\b]", "REGEX_ESCAPE: "),
			("[[:alpha:]]", "REGEX_SYNTAX: "),
			("[z-a]", "REGEX_SYNTAX: "),
			("[a-\\d]", "REGEX_SYNTAX: "),
			("[😀]", "REGEX_SYNTAX: "),
			("(?<1bad>a)", "REGEX_SYNTAX: "),
		];
		for (pattern, prefix) in cases {
			let err = Regex::compile(pattern, false).expect_err(pattern);
			assert!(err.0.starts_with(prefix), "pattern={pattern} got={}", err.0);
			assert!(err.0.bytes().all(|b| (0x20..=0x7e).contains(&b)), "non-ascii error: {}", err.0);
		}
	}

	#[test]
	fn matches_case_folding_and_unicode_parity_with_regex_ts() {
		let cases = [
			("Straße", "STRASSE straße", false, true),
			("[A-C]x+", "bXX", false, true),
			("[^a-z]", "ABC", false, false),
			("ÆØÅ", "æøå", false, true),
			("[À-Þ]", "é", false, true),
			("\\u00c9t\\x{E9}", "été", false, true),
			("\\w+\\s\\d", "Word 7", false, true),
			("(?:ab|cd){2}", "ABCD", false, true),
			("ß", "ẞ", false, true),
			("a.c", "A\nC", false, false),
			("ΟΣ", "ΟΣ", false, true),
			("ος", "ΚΟΣΜΟΣ", false, true),
			("[ς]", "Σ", false, true),
			("κόσμος", "ΚΌΣΜΟΣ", false, true),
			("300k", "temp 300\u{212a}", false, true),
			("^pl[a-z]n( b)?$", "PLAN B", false, true),
			("^pl[a-z]n( b)?$", "PLAN B", true, false),
			("\\b\\d{3}-\\d{4}\\b", "Call 555-1234 now", false, true),
			("\\b\\d{3}-\\d{4}\\b", "Call 1555-1234 now", false, false),
			("^$", "", false, true),
			("^$", "a", false, false),
			("[]a]", "]", true, true),
			("[^]a]", "]", true, false),
			("a{foo}b", "a{foo}b", true, true),
			("a}b]c", "a}b]c", true, true),
			("(?<word>foo|bar)", "xxBARyy", false, true),
			("(?P<word>foo|bar)", "xxFOOyy", false, true),
			("\\cA", "\u{0001}", true, true),
			("\\0", "\0", true, true),
		];
		for (pattern, subject, cs, expected) in cases {
			assert_eq!(matches(pattern, subject, cs), expected, "pattern={pattern} subject={subject} cs={cs}");
		}
	}

	#[test]
	fn returns_exact_leftmost_match_start_index() {
		assert_eq!(find_idx("ab|b", "ab", true), Some(0));
		assert_eq!(find_idx("b|ab", "ab", true), Some(0));
		assert_eq!(find_idx("\\b\\d{3}-\\d{4}\\b", "Call 555-1234 now", false), Some(5));
		assert_eq!(find_idx("plan", "the plan and plan", false), Some(4));
		assert_eq!(find_idx("a*b", "xxaaab", true), Some(2));
		assert_eq!(find_idx("^$", "", true), Some(0));
	}

	#[test]
	fn executes_pathological_redos_patterns_in_linear_time() {
		let re = Regex::compile("(a|aa)*(a*)*b", false).unwrap();
		let mut scratch = ExecScratch::new();
		let subject = "a".repeat(200_000);
		let started = Instant::now();
		assert_eq!(re.find_in_text(&subject, &mut scratch), None);
		assert!(started.elapsed().as_millis() < 1000, "took {:?}", started.elapsed());
	}

	#[test]
	fn extracts_sound_trigram_queries_for_literals_and_regex_asts() {
		let re1 = Regex::compile("export\\s+(async\\s+)?function\\s+searchView", false).unwrap();
		assert_ne!(*re1.trigram_query(), TrigramQuery::All);
		let re2 = Regex::compile("(alpha_one|beta_two)", true).unwrap();
		assert!(matches!(re2.trigram_query(), TrigramQuery::Or(_)));
		let re3 = Regex::compile("[Ss]earchView", true).unwrap();
		assert_ne!(*re3.trigram_query(), TrigramQuery::All);
		assert_eq!(re3.required_exact_literals(), &["earchView".to_string()]);
		let re4 = Regex::compile("^$", false).unwrap();
		assert_eq!(*re4.trigram_query(), TrigramQuery::All);
		let re5 = Regex::compile("foo|a", false).unwrap();
		assert_eq!(*re5.trigram_query(), TrigramQuery::All);
	}

	#[test]
	fn supports_inline_flags_and_quantifiers_up_to_64() {
		assert!(matches("(?i)hello", "HELLO", true));
		assert!(matches("(?i)straße", "STRAẞE", true));
		assert!(matches("foo(?i:bar)baz", "fooBARbaz", true));
		assert!(!matches("foo(?i:bar)baz", "FOOBARbaz", true));
		assert!(matches("(?-i:Foo)bar", "FooBAR", false));
		assert!(!matches("(?-i:Foo)bar", "fooBAR", false));
		assert!(matches("(?m)^second$", "first\nsecond\nthird", true));
		assert!(!matches("(?-m)^second$", "first\nsecond\nthird", true));
		assert!(matches("(?-m)^first", "first\nsecond", true));
		assert!(matches("(?im)^plan$", "x\nPLAN\ny", true));
		assert!(matches("a{64}", &"a".repeat(64), true));
		assert!(!matches("a{64}", &"a".repeat(63), true));
		assert!(matches("[0-9a-f]{64}", &"a1b2".repeat(16), true));
		assert!(Regex::compile("a{65}", true).is_err());
		assert!(Regex::compile("(?i)*", true).is_err());
	}

	#[test]
	fn case_sensitive_literal_prefilter_rejects_nonmatching_large_text_fast() {
		let re = Regex::compile("export\\s+function\\s+searchView\\w+", true).unwrap();
		assert!(re.required_exact_literals().iter().any(|s| s == "searchView"));
		assert!(re.required_exact_literals().iter().any(|s| s == "export"));
		let mut scratch = ExecScratch::new();
		let subject = "const x = 12345;\n".repeat(100_000);
		let started = Instant::now();
		assert_eq!(re.find_in_text(&subject, &mut scratch), None);
		assert!(started.elapsed().as_millis() < 200, "took {:?}", started.elapsed());
	}

	#[test]
	fn rejects_deeply_nested_and_oversized_patterns_without_stack_overflow() {
		let handle = std::thread::Builder::new()
			.stack_size(2 * 1024 * 1024)
			.spawn(|| {
				let deep_parens = format!("{}a{}", "(".repeat(5000), ")".repeat(5000));
				assert!(Regex::compile(&deep_parens, true).is_err());
				let deep_flags = format!("{}a{}", "(?i:".repeat(5000), ")".repeat(5000));
				assert!(Regex::compile(&deep_flags, true).is_err());
				let over_limit = format!("{}a{}", "(".repeat(MAX_NESTING_DEPTH + 1), ")".repeat(MAX_NESTING_DEPTH + 1));
				assert!(Regex::compile(&over_limit, true).is_err());
				let at_limit = format!("{}a{}", "(".repeat(MAX_NESTING_DEPTH), ")".repeat(MAX_NESTING_DEPTH));
				assert!(Regex::compile(&at_limit, true).is_ok());
				let too_long = "a".repeat(MAX_PATTERN_BYTES + 1);
				assert!(Regex::compile(&too_long, true).is_err());
			})
			.expect("spawn 2 MiB test thread");
		handle.join().expect("thread must not overflow stack");
	}

	#[test]
	fn folds_wide_non_ascii_classes_accurately_and_tracks_text_anchors() {
		assert!(matches("[\u{0080}-\u{ffff}]", "\u{00e9}", false));
		assert!(matches("[\u{0080}-\u{ffff}]", "k", false));
		assert!(matches("[\u{00c9}]", "\u{00e9}", false));
		assert!(matches("[\u{0100}-\u{2fff}]", "\u{0101}", false));
		assert!(matches("[\u{0100}-\u{0110}A-Z]", "a", false));
		assert!(matches("[\u{0100}-\u{0110}A-Z]", "\u{0101}", false));
		assert!(matches("[\u{0100}-\u{0fff}][\u{0100}-\u{0fff}][A-Z]", "\u{0101}\u{0103}z", false));
		assert!(Regex::compile("(?-m)^foo", true).unwrap().has_text_anchor());
		assert!(Regex::compile("(?-m)foo$", true).unwrap().has_text_anchor());
		assert!(!Regex::compile("^foo$", true).unwrap().has_text_anchor());
	}
}
