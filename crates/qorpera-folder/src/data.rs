
use crate::frame::{kind, read_frame, write_frame};
use crate::link::View;
use crate::proto::{ErrorReply, DATA_PROTOCOL};
use crate::transport::{connect, Stream};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

pub const EXIT_ANSWER: u8 = 0;
pub const EXIT_REFUSED: u8 = 1;
pub const EXIT_UNREACHABLE: u8 = 3;

pub const DATA_USAGE: &str = "Usage:
  qorpera-folder data [--view-file <file>] [--root <dir>] [--connect <addr>] [--format json|table|csv|tsv|ndjson] <command>

Commands:
  describe [<database>]
  apply <database> [--dry-run]
  query <database> <question> [--params-json '<obj>'] [--params-file <path>] [name=value | name:=<JSON> ...]
  query <database> --sql '<select>'|- [--params-json '<obj>'] [--params-file <path>] [name=value | name:=<JSON> ...]
  query <database> --sql-file <path> [--params-json '<obj>'] [--params-file <path>] [name=value | name:=<JSON> ...]
  change <database> <change> [--dry-run] [--params-json '<obj>'] [--params-file <path>] [name=value | name:=<JSON> ...]
  rows <database> <table> [--limit <1..=1000>] [--offset <N>] [--order <col>[:asc|:desc]]
  changes <database>

Options:
  --format json|table|csv|tsv|ndjson  Output format (default: json)
  --dry-run                           Preview a change or inspect pending apply steps without mutating data
  --params-json '<object>'            JSON object of named parameters
  --params-file <path>                Path to JSON object file of named parameters
  --sql-file <path>                   Read query SQL from file (--sql - reads from stdin)
  -h, --help                          Show this help and exit 0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Format {
	#[default]
	Json,
	Table,
	Csv,
	Tsv,
	Ndjson,
}

impl Format {
	pub fn parse(name: &str) -> Result<Self, String> {
		match name {
			"json" => Ok(Self::Json),
			"table" => Ok(Self::Table),
			"csv" => Ok(Self::Csv),
			"tsv" => Ok(Self::Tsv),
			"ndjson" => Ok(Self::Ndjson),
			other => Err(format!("--format {other} is not one of json, table, csv, tsv and ndjson")),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Transform {
	#[default]
	Identity,
	ApplyDryRun(String),
	DatabaseChanges(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCall {
	pub call: Call,
	pub format: Format,
	pub transform: Transform,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
	Help,
	Execute(ParsedCall),
}

const MAX_CALL: usize = 1024 * 1024;
const PASS_ROOM: usize = 128;
const MAX_TEXT: u64 = 64 * 1024;
const ROUNDS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verb {
	Describe,
	Apply,
	Query,
	Change,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
	pub verb: Verb,
	pub body: Map<String, Value>,
}

#[derive(Debug, Clone, Copy)]
pub struct Waits {
	pub hello: Duration,
	pub call: Duration,
	pub apply: Duration,
	pub save: Duration,
	pub pause: Duration,
}

impl Default for Waits {
	fn default() -> Self {
		Self {
			hello: Duration::from_secs(15),
			call: Duration::from_secs(45),
			apply: Duration::from_secs(135),
			save: Duration::from_secs(10),
			pause: Duration::from_millis(500),
		}
	}
}

fn database_name(name: &str) -> bool {
	let bytes = name.as_bytes();
	!bytes.is_empty()
		&& bytes.len() <= 40
		&& bytes[0].is_ascii_lowercase()
		&& bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

fn file_name(name: &str) -> bool {
	!name.is_empty()
		&& name.len() <= 60
		&& name.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

fn parameter_name(name: &str) -> bool {
	let bytes = name.as_bytes();
	!bytes.is_empty()
		&& bytes.len() <= 40
		&& (bytes[0].is_ascii_lowercase() || bytes[0] == b'_')
		&& bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

impl Call {
	pub fn writes(&self) -> bool {
		match self.verb {
			Verb::Apply => true,
			Verb::Change => self.body.get("preview") != Some(&Value::Bool(true)),
			Verb::Describe | Verb::Query => false,
		}
	}
}

fn sql_identifier(name: &str) -> bool {
	let bytes = name.as_bytes();
	!bytes.is_empty()
		&& bytes.len() <= 63
		&& (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
		&& bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn read_bounded_utf8(mut reader: impl Read, label: &str) -> Result<String, String> {
	let mut bytes = Vec::new();
	reader
		.by_ref()
		.take(MAX_CALL as u64 + 1)
		.read_to_end(&mut bytes)
		.map_err(|e| format!("{label} could not be read: {e}"))?;
	if bytes.len() > MAX_CALL {
		return Err(format!("{label} is larger than 1 MiB"));
	}
	String::from_utf8(bytes).map_err(|_| format!("{label} is not valid UTF-8"))
}

fn parse_params_object(raw: &str, source: &str, params: &mut Map<String, Value>) -> Result<(), String> {
	let parsed: Value = serde_json::from_str(raw).map_err(|e| format!("{source} is not valid JSON: {e}"))?;
	let Value::Object(obj) = parsed else {
		return Err(format!("{source} must be a JSON object"));
	};
	for (name, value) in obj {
		if !parameter_name(&name) {
			return Err(format!("{name} is no value's name (a lower-case letter or _, then letters, digits or _)"));
		}
		if params.insert(name.clone(), value).is_some() {
			return Err(format!("{name} is given twice"));
		}
	}
	Ok(())
}

fn parse_kv_param(arg: &str, params: &mut Map<String, Value>) -> Result<(), String> {
	let (left, text) = arg.split_once('=').ok_or_else(|| format!("{arg} is not name=value"))?;
	let (name, value) = match left.strip_suffix(':') {
		None => (left, Value::String(text.to_string())),
		Some(name) => match serde_json::from_str::<Value>(text) {
			Ok(value @ (Value::Number(_) | Value::Bool(_) | Value::Null | Value::Array(_) | Value::Object(_))) => (name, value),
			_ => return Err(format!("{name}:= takes a JSON number, boolean, null, array or object; {name}=<text> gives text")),
		},
	};
	if !parameter_name(name) {
		return Err(format!("{name} is no value's name (a lower-case letter or _, then letters, digits or _)"));
	}
	if params.insert(name.to_string(), value).is_some() {
		return Err(format!("{name} is given twice"));
	}
	Ok(())
}

fn parse_database(name: &str) -> Result<Value, String> {
	if database_name(name) {
		Ok(Value::String(name.to_string()))
	} else {
		Err(format!("{name} is no database's name (a lower-case letter, then letters, digits or _)"))
	}
}

fn parse_named(what: &str, name: &str) -> Result<Value, String> {
	if file_name(name) {
		Ok(Value::String(name.to_string()))
	} else {
		Err(format!("{name} is no {what}'s name (lower-case letters and digits, in parts joined by -)"))
	}
}

fn parse_param_tail(args: &[String], format: &mut Option<Format>, dry_run: Option<&mut bool>) -> Result<Option<Map<String, Value>>, String> {
	let mut params = Map::new();
	let mut saw_params_json = false;
	let mut saw_params_file = false;
	let mut dry_run = dry_run;
	let mut i = 0;
	while i < args.len() {
		match args[i].as_str() {
			"-h" | "--help" => return Ok(None),
			"--format" => {
				if format.is_some() {
					return Err("--format given twice".into());
				}
				let val = args.get(i + 1).ok_or("--format needs a value")?;
				*format = Some(Format::parse(val)?);
				i += 2;
			}
			"--dry-run" => match dry_run.as_deref_mut() {
				Some(slot) => {
					if *slot {
						return Err("--dry-run given twice".into());
					}
					*slot = true;
					i += 1;
				}
				None => return Err("--dry-run is only supported on apply and change".into()),
			},
			"--params-json" => {
				if saw_params_json {
					return Err("--params-json given twice".into());
				}
				saw_params_json = true;
				let raw = args.get(i + 1).ok_or("--params-json needs a JSON object")?;
				parse_params_object(raw, "--params-json", &mut params)?;
				i += 2;
			}
			"--params-file" => {
				if saw_params_file {
					return Err("--params-file given twice".into());
				}
				saw_params_file = true;
				let path = args.get(i + 1).filter(|p| !p.is_empty()).ok_or("--params-file needs a path")?;
				let file = std::fs::File::open(path).map_err(|e| format!("--params-file {path}: {e}"))?;
				let raw = read_bounded_utf8(file, &format!("--params-file {path}"))?;
				parse_params_object(&raw, "--params-file", &mut params)?;
				i += 2;
			}
			other if other.starts_with("--") => return Err(format!("unknown option {other}")),
			other => {
				parse_kv_param(other, &mut params)?;
				i += 1;
			}
		}
	}
	Ok(Some(params))
}

pub fn parse_cli(args: &[String], leading_format: Option<Format>, mut stdin: impl Read) -> Result<Command, String> {
	let Some((verb, rest)) = args.split_first() else {
		return Err("name what to do: describe, apply, query, change, rows or changes".into());
	};
	if verb == "-h" || verb == "--help" {
		return Ok(Command::Help);
	}
	let mut format = leading_format;
	let mut body = Map::new();
	let mut transform = Transform::Identity;
	let verb = match verb.as_str() {
		"describe" => {
			let mut db: Option<String> = None;
			let mut i = 0;
			while i < rest.len() {
				match rest[i].as_str() {
					"-h" | "--help" => return Ok(Command::Help),
					"--format" => {
						if format.is_some() {
							return Err("--format given twice".into());
						}
						let val = rest.get(i + 1).ok_or("--format needs a value")?;
						format = Some(Format::parse(val)?);
						i += 2;
					}
					other if other.starts_with("--") => return Err(format!("unknown option {other}")),
					name => {
						if db.is_some() {
							return Err("describe takes one database, or none for all of them".into());
						}
						let _ = parse_database(name)?;
						db = Some(name.to_string());
						i += 1;
					}
				}
			}
			if let Some(name) = db {
				body.insert("database".into(), Value::String(name));
			}
			Verb::Describe
		}
		"apply" => {
			let mut db: Option<String> = None;
			let mut dry_run = false;
			let mut i = 0;
			while i < rest.len() {
				match rest[i].as_str() {
					"-h" | "--help" => return Ok(Command::Help),
					"--dry-run" => {
						if dry_run {
							return Err("--dry-run given twice".into());
						}
						dry_run = true;
						i += 1;
					}
					"--format" => {
						if format.is_some() {
							return Err("--format given twice".into());
						}
						let val = rest.get(i + 1).ok_or("--format needs a value")?;
						format = Some(Format::parse(val)?);
						i += 2;
					}
					other if other.starts_with("--") => return Err(format!("unknown option {other}")),
					name => {
						if db.is_some() {
							return Err("apply takes one database".into());
						}
						let _ = parse_database(name)?;
						db = Some(name.to_string());
						i += 1;
					}
				}
			}
			let db = db.ok_or("apply takes one database")?;
			body.insert("database".into(), Value::String(db.clone()));
			if dry_run {
				transform = Transform::ApplyDryRun(db);
				Verb::Describe
			} else {
				Verb::Apply
			}
		}
		"query" => {
			if rest.iter().any(|a| a == "-h" || a == "--help") {
				if rest.first().is_some_and(|a| a == "-h" || a == "--help") {
					return Ok(Command::Help);
				}
			}
			let (name, rest) = rest.split_first().ok_or("query takes a database, then a question's name, --sql or --sql-file")?;
			body.insert("database".into(), parse_database(name)?);
			let values = match rest {
				[flag, ..] if flag == "-h" || flag == "--help" => return Ok(Command::Help),
				[flag] if flag == "--sql" => return Err("--sql takes one select or - for stdin".into()),
				[flag, sql, values @ ..] if flag == "--sql" => {
					let text = if sql == "-" { read_bounded_utf8(&mut stdin, "stdin")? } else { sql.clone() };
					body.insert("sql".into(), Value::String(text));
					values
				}
				[flag] if flag == "--sql-file" => return Err("--sql-file takes a file path".into()),
				[flag, path, values @ ..] if flag == "--sql-file" => {
					if path.is_empty() {
						return Err("--sql-file takes a file path".into());
					}
					let file = std::fs::File::open(path).map_err(|e| format!("--sql-file {path}: {e}"))?;
					let text = read_bounded_utf8(file, &format!("--sql-file {path}"))?;
					body.insert("sql".into(), Value::String(text));
					values
				}
				[question, values @ ..] => {
					body.insert("question".into(), parse_named("question", question)?);
					values
				}
				[] => return Err("query takes a question's name, --sql or --sql-file".into()),
			};
			let Some(params) = parse_param_tail(values, &mut format, None)? else {
				return Ok(Command::Help);
			};
			if !params.is_empty() {
				body.insert("params".into(), Value::Object(params));
			}
			Verb::Query
		}
		"change" => {
			if rest.first().is_some_and(|a| a == "-h" || a == "--help") {
				return Ok(Command::Help);
			}
			let (name, rest) = rest.split_first().ok_or("change takes a database, then a change's name")?;
			body.insert("database".into(), parse_database(name)?);
			if rest.first().is_some_and(|a| a == "-h" || a == "--help") {
				return Ok(Command::Help);
			}
			let (change, values) = rest.split_first().ok_or("change takes a change's name")?;
			body.insert("change".into(), parse_named("change", change)?);
			let mut dry_run = false;
			let Some(params) = parse_param_tail(values, &mut format, Some(&mut dry_run))? else {
				return Ok(Command::Help);
			};
			if !params.is_empty() {
				body.insert("params".into(), Value::Object(params));
			}
			if dry_run {
				body.insert("preview".into(), Value::Bool(true));
			}
			Verb::Change
		}
		"rows" => {
			if rest.first().is_some_and(|a| a == "-h" || a == "--help") {
				return Ok(Command::Help);
			}
			let (name, rest) = rest.split_first().ok_or("rows takes a database and a table")?;
			body.insert("database".into(), parse_database(name)?);
			if rest.first().is_some_and(|a| a == "-h" || a == "--help") {
				return Ok(Command::Help);
			}
			let (table, rest) = rest.split_first().ok_or("rows takes a table name")?;
			if !sql_identifier(table) {
				return Err(format!("{table} is no table's name (a letter or _, then up to 62 letters, digits or _)"));
			}
			let mut limit: u64 = 50;
			let mut saw_limit = false;
			let mut offset: u64 = 0;
			let mut saw_offset = false;
			let mut order: Option<(String, &'static str)> = None;
			let mut i = 0;
			while i < rest.len() {
				match rest[i].as_str() {
					"-h" | "--help" => return Ok(Command::Help),
					"--format" => {
						if format.is_some() {
							return Err("--format given twice".into());
						}
						let val = rest.get(i + 1).ok_or("--format needs a value")?;
						format = Some(Format::parse(val)?);
						i += 2;
					}
					"--limit" => {
						if saw_limit {
							return Err("--limit given twice".into());
						}
						saw_limit = true;
						let raw = rest.get(i + 1).ok_or("--limit needs a number")?;
						limit = raw.parse().map_err(|_| "--limit must be a number between 1 and 1000")?;
						if !(1..=1000).contains(&limit) {
							return Err("--limit must be between 1 and 1000".into());
						}
						i += 2;
					}
					"--offset" => {
						if saw_offset {
							return Err("--offset given twice".into());
						}
						saw_offset = true;
						let raw = rest.get(i + 1).ok_or("--offset needs a number")?;
						offset = raw.parse().map_err(|_| "--offset must be a non-negative integer")?;
						i += 2;
					}
					"--order" => {
						if order.is_some() {
							return Err("--order given twice".into());
						}
						let raw = rest.get(i + 1).ok_or("--order needs <column>[:asc|:desc]")?;
						let (col, dir) = match raw.split_once(':') {
							Some((c, d)) if d.eq_ignore_ascii_case("asc") => (c, "asc"),
							Some((c, d)) if d.eq_ignore_ascii_case("desc") => (c, "desc"),
							Some(_) => return Err("--order direction must be asc or desc".into()),
							None => (raw.as_str(), "asc"),
						};
						if !sql_identifier(col) {
							return Err(format!("{col} is no column's name"));
						}
						order = Some((col.to_string(), dir));
						i += 2;
					}
					other => return Err(format!("unknown option {other}")),
				}
			}
			let mut sql = format!("select * from \"{table}\"");
			if let Some((col, dir)) = order {
				sql.push_str(&format!(" order by \"{col}\" {dir}"));
			}
			sql.push_str(&format!(" limit {limit}"));
			if offset > 0 {
				sql.push_str(&format!(" offset {offset}"));
			}
			body.insert("sql".into(), Value::String(sql));
			Verb::Query
		}
		"changes" => {
			let mut db: Option<String> = None;
			let mut i = 0;
			while i < rest.len() {
				match rest[i].as_str() {
					"-h" | "--help" => return Ok(Command::Help),
					"--format" => {
						if format.is_some() {
							return Err("--format given twice".into());
						}
						let val = rest.get(i + 1).ok_or("--format needs a value")?;
						format = Some(Format::parse(val)?);
						i += 2;
					}
					other if other.starts_with("--") => return Err(format!("unknown option {other}")),
					name => {
						if db.is_some() {
							return Err("changes takes one database".into());
						}
						let _ = parse_database(name)?;
						db = Some(name.to_string());
						i += 1;
					}
				}
			}
			let db = db.ok_or("changes takes one database")?;
			body.insert("database".into(), Value::String(db.clone()));
			transform = Transform::DatabaseChanges(db);
			Verb::Describe
		}
		other => return Err(format!("{other} is not one of describe, apply, query, change, rows and changes")),
	};
	Ok(Command::Execute(ParsedCall { call: Call { verb, body }, format: format.unwrap_or(Format::Json), transform }))
}

pub fn call(args: &[String]) -> Result<Call, String> {
	match parse_cli(args, None, std::io::empty())? {
		Command::Execute(parsed) => Ok(parsed.call),
		Command::Help => Err("help requested".into()),
	}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hello<'a> {
	protocol: u32,
	environment_id: &'a str,
	view_id: &'a str,
	pass: &'a str,
	role: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloOk {
	protocol: u32,
	view_id: String,
}

#[derive(Serialize)]
struct Ask<'a> {
	verb: Verb,
	body: &'a Map<String, Value>,
}

#[derive(Deserialize)]
struct Answer {
	status: u64,
	value: Value,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
	Answer(Value),
	Refused(String),
	Unreachable(String),
}

enum Fail {
	Remote(ErrorReply),
	Link(String),
}

fn exchange<T: for<'de> Deserialize<'de>>(stream: &mut Stream, request: u8, payload: &[u8], answer: u8) -> Result<T, Fail> {
	write_frame(stream, request, payload).map_err(|e| Fail::Link(e.to_string()))?;
	let (got, body) = read_frame(stream).map_err(|e| Fail::Link(e.to_string()))?;
	if got == answer {
		serde_json::from_slice(&body).map_err(|_| Fail::Link("the node's answer made no sense".into()))
	} else if got == kind::ERROR {
		match serde_json::from_slice(&body) {
			Ok(reply) => Err(Fail::Remote(reply)),
			Err(_) => Err(Fail::Link("the node's answer made no sense".into())),
		}
	} else {
		Err(Fail::Link(format!("unexpected frame {got}")))
	}
}

fn plain(words: &str) -> String {
	words.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

fn saved_text(root: &Path, path: &str, sha256: &str) -> Option<String> {
	let inside = path.starts_with("data/") && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
	if !inside {
		return None;
	}
	let file = std::fs::File::open(root.join(path)).ok()?;
	let meta = file.metadata().ok()?;
	if !meta.is_file() || meta.len() > MAX_TEXT {
		return None;
	}
	let mut bytes = Vec::new();
	file.take(MAX_TEXT + 1).read_to_end(&mut bytes).ok()?;
	let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
	if hash != sha256 {
		return None;
	}
	String::from_utf8(bytes).ok()
}

pub fn ask(addr: &str, view: &View, root: &Path, call: &Call, waits: &Waits) -> Outcome {
	let unreachable = |why: String| Outcome::Unreachable(format!("the company's databases cannot be reached from this machine now: {why}"));
	let mut stream = match connect(addr) {
		Ok(stream) => stream,
		Err(e) => return unreachable(format!("the node's folder service did not answer ({e})")),
	};
	if let Err(e) = stream.set_timeouts(Some(waits.hello), Some(waits.hello)) {
		return unreachable(e.to_string());
	}
	let hello = Hello { protocol: DATA_PROTOCOL, environment_id: &view.environment_id, view_id: &view.view_id, pass: &view.pass, role: "data" };
	let payload = serde_json::to_vec(&hello).expect("a hello serializes");
	match exchange::<HelloOk>(&mut stream, kind::HELLO, &payload, kind::HELLO_OK) {
		Ok(ok) if ok.protocol == DATA_PROTOCOL && ok.view_id == view.view_id => {}
		Ok(_) => return unreachable("the node answered for another view or protocol".into()),
		Err(Fail::Remote(e)) => return unreachable(plain(&e.message)),
		Err(Fail::Link(e)) => return unreachable(e),
	}
	let writes = call.writes();
	let limit = if call.verb == Verb::Apply { waits.apply } else { waits.call };
	if let Err(e) = stream.set_timeouts(Some(limit), Some(waits.hello)) {
		return unreachable(e.to_string());
	}
	let unanswered = |why: String| {
		Outcome::Unreachable(if writes {
			format!("no answer came ({why}), so the call may or may not have run: look before you run it again")
		} else {
			format!("the company's databases cannot be reached from this machine now: {why}")
		})
	};
	let bare = serde_json::to_vec(&Ask { verb: call.verb, body: &call.body }).expect("a call serializes").len();
	let mut texts: Map<String, Value> = Map::new();
	let mut rounds = 0;
	let mut waiting: Option<Instant> = None;
	loop {
		let mut body = call.body.clone();
		if !texts.is_empty() {
			body.insert("texts".into(), Value::Object(std::mem::take(&mut texts)));
		}
		let payload = serde_json::to_vec(&Ask { verb: call.verb, body: &body }).expect("a call serializes");
		if payload.len() > MAX_CALL {
			return Outcome::Refused("the call is larger than 1 MiB".into());
		}
		let answer: Answer = match exchange(&mut stream, kind::DATA_CALL, &payload, kind::DATA_ANSWER) {
			Ok(answer) => answer,
			Err(Fail::Remote(e)) => return unanswered(plain(&e.message)),
			Err(Fail::Link(e)) => return unanswered(e),
		};
		if answer.status != 200 {
			let mut words = match answer.value.get("error").and_then(Value::as_str) {
				Some(error) => plain(error),
				None => format!("the company's databases answered {}", answer.status),
			};
			if let Some(position) = answer.value.get("position").and_then(Value::as_u64) {
				words = format!("{words} (at character {position})");
			}
			let refused = (400..500).contains(&answer.status) || answer.status == 507;
			return if refused { Outcome::Refused(words) } else { Outcome::Unreachable(words) };
		}
		let asks = answer.value.get("need").and_then(Value::as_array).is_some_and(|need| !need.is_empty());
		if !asks {
			return Outcome::Answer(answer.value);
		}
		let need = answer.value.get("need").and_then(Value::as_array).expect("checked above");
		let mut size = bare + 16;
		let mut first = "";
		for wanted in need {
			let (Some(path), Some(hash)) = (wanted.get("path").and_then(Value::as_str), wanted.get("sha256").and_then(Value::as_str)) else {
				return unanswered("the node's answer made no sense".into());
			};
			if first.is_empty() {
				first = path;
			}
			let Some(text) = saved_text(root, path, hash) else { continue };
			let adds = serde_json::to_string(&text).expect("text serializes").len() + hash.len() + 4;
			if !texts.is_empty() && size + adds > MAX_CALL - PASS_ROOM {
				break;
			}
			size += adds;
			texts.insert(hash.to_string(), Value::String(text));
		}
		if texts.is_empty() {
			let since = *waiting.get_or_insert_with(Instant::now);
			if since.elapsed() >= waits.save {
				return Outcome::Refused(format!(
					"{} on this machine is not the file saved in the company folder: save it, wait a moment and run the command again",
					plain(first)
				));
			}
			std::thread::sleep(waits.pause);
		} else {
			waiting = None;
			rounds += 1;
			if rounds > ROUNDS {
				return Outcome::Refused("the database's files kept changing while they were read: try again".into());
			}
		}
	}
}

fn transform_answer(value: Value, transform: &Transform) -> Value {
	match transform {
		Transform::Identity => value,
		Transform::ApplyDryRun(db) => {
			let entry = value
				.get("databases")
				.and_then(Value::as_array)
				.and_then(|dbs| dbs.iter().find(|d| d.get("database").and_then(Value::as_str) == Some(db.as_str())).or_else(|| dbs.first()));
			let steps = entry.and_then(|e| e.get("steps")).cloned().unwrap_or_else(|| Value::Object(Map::new()));
			let mut out = Map::new();
			out.insert("database".into(), Value::String(db.clone()));
			out.insert("dryRun".into(), Value::Bool(true));
			out.insert("steps".into(), steps);
			Value::Object(out)
		}
		Transform::DatabaseChanges(db) => {
			let entry = value
				.get("databases")
				.and_then(Value::as_array)
				.and_then(|dbs| dbs.iter().find(|d| d.get("database").and_then(Value::as_str) == Some(db.as_str())).or_else(|| dbs.first()));
			let changes = entry.and_then(|e| e.get("changes")).cloned().unwrap_or_else(|| Value::Array(Vec::new()));
			let steps = entry.and_then(|e| e.get("steps")).cloned().unwrap_or_else(|| Value::Object(Map::new()));
			let mut out = Map::new();
			out.insert("database".into(), Value::String(db.clone()));
			out.insert("changes".into(), changes);
			out.insert("steps".into(), steps);
			Value::Object(out)
		}
	}
}

fn cell_text(value: &Value) -> String {
	match value {
		Value::Null => String::new(),
		Value::String(s) => s.clone(),
		other => serde_json::to_string(other).expect("a value serializes"),
	}
}

fn tabular(value: &Value) -> (Vec<String>, Vec<Vec<String>>) {
	if let (Some(cols), Some(rows)) = (
		value.get("columns").and_then(Value::as_array),
		value.get("rows").and_then(Value::as_array),
	) {
		let headers: Vec<String> = cols.iter().map(cell_text).collect();
		let body = rows
			.iter()
			.map(|row| match row.as_array() {
				Some(cells) => cells.iter().map(cell_text).collect(),
				None => vec![cell_text(row)],
			})
			.collect();
		return (headers, body);
	}
	if value.get("dryRun") == Some(&Value::Bool(true)) {
		if let Some(steps) = value.get("steps").and_then(Value::as_object) {
			let headers = vec!["state".into(), "step".into(), "at".into()];
			let mut rows = Vec::new();
			if let Some(applied) = steps.get("applied").and_then(Value::as_array) {
				for item in applied {
					let step = item.get("name").map(cell_text).unwrap_or_else(|| cell_text(item));
					let at = item.get("at").map(cell_text).unwrap_or_default();
					rows.push(vec!["applied".into(), step, at]);
				}
			}
			for state in ["waiting", "changed", "missing"] {
				if let Some(items) = steps.get(state).and_then(Value::as_array) {
					for item in items {
						rows.push(vec![state.into(), cell_text(item), String::new()]);
					}
				}
			}
			return (headers, rows);
		}
	}
	if let (Some(_), Some(changes)) = (
		value.get("database").and_then(Value::as_str),
		value.get("changes").and_then(Value::as_array),
	) {
		let headers = vec!["name".into(), "parameters".into(), "words".into(), "problem".into()];
		let rows = changes
			.iter()
			.map(|item| {
				let name = item.get("name").map(cell_text).unwrap_or_default();
				let params = item.get("parameters").map(cell_text).unwrap_or_default();
				let words = item.get("words").map(cell_text).unwrap_or_default();
				let problem = item.get("problem").map(cell_text).unwrap_or_default();
				vec![name, params, words, problem]
			})
			.collect();
		return (headers, rows);
	}
	if let Some(dbs) = value.get("databases").and_then(Value::as_array) {
		let headers = vec!["database".into(), "name".into(), "tables".into(), "questions".into(), "changes".into(), "waiting".into()];
		let rows = dbs
			.iter()
			.map(|db| {
				let id = db.get("database").map(cell_text).unwrap_or_default();
				let title = db.get("name").map(cell_text).unwrap_or_default();
				let tables = db.get("tables").and_then(Value::as_array).map_or(0, Vec::len).to_string();
				let questions = db.get("questions").and_then(Value::as_array).map_or(0, Vec::len).to_string();
				let changes = db.get("changes").and_then(Value::as_array).map_or(0, Vec::len).to_string();
				let waiting = db
					.get("steps")
					.and_then(|s| s.get("waiting"))
					.and_then(Value::as_array)
					.map_or(0, Vec::len)
					.to_string();
				vec![id, title, tables, questions, changes, waiting]
			})
			.collect();
		return (headers, rows);
	}
	match value {
		Value::Object(map) => {
			let headers: Vec<String> = map.keys().cloned().collect();
			let row: Vec<String> = map.values().map(cell_text).collect();
			(headers, vec![row])
		}
		Value::Array(items) => (vec!["value".into()], items.iter().map(|v| vec![cell_text(v)]).collect()),
		other => (vec!["value".into()], vec![vec![cell_text(other)]]),
	}
}

fn csv_escape(field: &str) -> String {
	if field.contains([',', '"', '\n', '\r']) {
		format!("\"{}\"", field.replace('"', "\"\""))
	} else {
		field.to_string()
	}
}

fn tsv_cell(field: &str) -> String {
	field.chars().map(|c| if matches!(c, '\t' | '\n' | '\r') { ' ' } else { c }).collect()
}

fn table_cell(field: &str) -> String {
	field.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

pub fn format_value(value: &Value, format: Format, out: &mut impl Write) -> std::io::Result<()> {
	match format {
		Format::Json => {
			let line = serde_json::to_string(value).expect("an answer serializes");
			writeln!(out, "{line}")?;
		}
		Format::Ndjson => {
			if let (Some(cols), Some(rows)) = (
				value.get("columns").and_then(Value::as_array),
				value.get("rows").and_then(Value::as_array),
			) {
				let names: Vec<String> = cols.iter().map(cell_text).collect();
				for row in rows {
					if let Some(cells) = row.as_array() {
						let mut obj = Map::with_capacity(names.len());
						for (idx, name) in names.iter().enumerate() {
							obj.insert(name.clone(), cells.get(idx).cloned().unwrap_or(Value::Null));
						}
						writeln!(out, "{}", serde_json::to_string(&Value::Object(obj)).expect("row serializes"))?;
					} else {
						writeln!(out, "{}", serde_json::to_string(row).expect("row serializes"))?;
					}
				}
			} else if let Some(dbs) = value.get("databases").and_then(Value::as_array) {
				for db in dbs {
					writeln!(out, "{}", serde_json::to_string(db).expect("db serializes"))?;
				}
			} else if value.get("database").is_some() && value.get("changes").and_then(Value::as_array).is_some() {
				for item in value.get("changes").and_then(Value::as_array).expect("checked") {
					writeln!(out, "{}", serde_json::to_string(item).expect("change serializes"))?;
				}
			} else if let Value::Array(items) = value {
				for item in items {
					writeln!(out, "{}", serde_json::to_string(item).expect("item serializes"))?;
				}
			} else {
				writeln!(out, "{}", serde_json::to_string(value).expect("value serializes"))?;
			}
		}
		Format::Csv => {
			let (headers, rows) = tabular(value);
			if !headers.is_empty() {
				writeln!(out, "{}", headers.iter().map(|h| csv_escape(h)).collect::<Vec<_>>().join(","))?;
			}
			for row in rows {
				writeln!(out, "{}", row.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(","))?;
			}
		}
		Format::Tsv => {
			let (headers, rows) = tabular(value);
			if !headers.is_empty() {
				writeln!(out, "{}", headers.iter().map(|h| tsv_cell(h)).collect::<Vec<_>>().join("\t"))?;
			}
			for row in rows {
				writeln!(out, "{}", row.iter().map(|c| tsv_cell(c)).collect::<Vec<_>>().join("\t"))?;
			}
		}
		Format::Table => {
			let (headers, rows) = tabular(value);
			let col_count = headers.len().max(rows.iter().map(Vec::len).max().unwrap_or(0));
			if col_count == 0 {
				return out.flush();
			}
			let clean_headers: Vec<String> = (0..col_count).map(|i| headers.get(i).map(|s| table_cell(s)).unwrap_or_default()).collect();
			let clean_rows: Vec<Vec<String>> = rows
				.iter()
				.map(|row| (0..col_count).map(|i| row.get(i).map(|s| table_cell(s)).unwrap_or_default()).collect())
				.collect();
			let mut widths: Vec<usize> = clean_headers.iter().map(|h| h.chars().count()).collect();
			for row in &clean_rows {
				for (i, cell) in row.iter().enumerate() {
					widths[i] = widths[i].max(cell.chars().count());
				}
			}
			let write_row = |out: &mut dyn Write, cells: &[String]| -> std::io::Result<()> {
				for (i, cell) in cells.iter().enumerate() {
					if i > 0 {
						write!(out, " | ")?;
					}
					let pad = widths[i].saturating_sub(cell.chars().count());
					write!(out, "{cell}")?;
					if i + 1 < cells.len() && pad > 0 {
						write!(out, "{}", " ".repeat(pad))?;
					}
				}
				writeln!(out)
			};
			write_row(out, &clean_headers)?;
			for (i, &w) in widths.iter().enumerate() {
				if i > 0 {
					write!(out, "-+-")?;
				}
				write!(out, "{}", "-".repeat(w.max(1)))?;
			}
			writeln!(out)?;
			for row in &clean_rows {
				write_row(out, row)?;
			}
		}
	}
	out.flush()
}

pub fn run_parsed(addr: &str, view: &View, root: &Path, parsed: &ParsedCall, waits: &Waits, out: &mut impl Write, err: &mut impl Write) -> u8 {
	match ask(addr, view, root, &parsed.call, waits) {
		Outcome::Answer(value) => {
			let value = transform_answer(value, &parsed.transform);
			if let Err(e) = format_value(&value, parsed.format, out) {
				let ran = if parsed.call.writes() {
					": the call was answered, so what it does may be done: look before you run it again"
				} else {
					""
				};
				let _ = writeln!(err, "data: the answer could not be printed ({e}){ran}");
				return EXIT_UNREACHABLE;
			}
			EXIT_ANSWER
		}
		Outcome::Refused(words) => {
			let _ = writeln!(err, "data: {words}");
			EXIT_REFUSED
		}
		Outcome::Unreachable(words) => {
			let _ = writeln!(err, "data: {words}");
			EXIT_UNREACHABLE
		}
	}
}

pub fn run(addr: &str, view: &View, root: &Path, call: &Call, waits: &Waits, out: &mut impl Write, err: &mut impl Write) -> u8 {
	let parsed = ParsedCall { call: call.clone(), format: Format::Json, transform: Transform::Identity };
	run_parsed(addr, view, root, &parsed, waits, out, err)
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;
	use std::collections::HashSet;
	use std::os::unix::net::UnixListener;
	use std::path::PathBuf;
	use std::sync::atomic::{AtomicUsize, Ordering};
	use std::sync::mpsc;

	fn args(line: &[&str]) -> Vec<String> {
		line.iter().map(|s| s.to_string()).collect()
	}

	fn body(value: Value) -> Map<String, Value> {
		value.as_object().expect("an object").clone()
	}

	#[test]
	fn a_command_line_names_one_call() {
		let parsed = |line: &[&str]| call(&args(line));
		assert_eq!(parsed(&["describe"]), Ok(Call { verb: Verb::Describe, body: Map::new() }));
		assert_eq!(parsed(&["describe", "shop"]), Ok(Call { verb: Verb::Describe, body: body(json!({"database": "shop"})) }));
		assert_eq!(parsed(&["apply", "shop"]), Ok(Call { verb: Verb::Apply, body: body(json!({"database": "shop"})) }));
		assert_eq!(
			parsed(&["query", "shop", "open-orders"]),
			Ok(Call { verb: Verb::Query, body: body(json!({"database": "shop", "question": "open-orders"})) })
		);
		assert_eq!(
			parsed(&["query", "shop", "count", "since=2026-01-01", "limit:=20", "paid:=true", "tag:=null", "note=a=b", "zip=0123", "empty="]),
			Ok(Call {
				verb: Verb::Query,
				body: body(json!({"database": "shop", "question": "count", "params": {
					"since": "2026-01-01", "limit": 20, "paid": true, "tag": null, "note": "a=b", "zip": "0123", "empty": ""
				}})),
			})
		);
		assert_eq!(
			parsed(&["query", "shop", "--sql", "select count(*) from orders where id > :id", "id:=7"]),
			Ok(Call {
				verb: Verb::Query,
				body: body(json!({"database": "shop", "sql": "select count(*) from orders where id > :id", "params": {"id": 7}})),
			})
		);
		assert_eq!(
			parsed(&["change", "shop", "add-order", "id:=7", "viewer=11111111-2222-4333-8444-555555555555"]),
			Ok(Call {
				verb: Verb::Change,
				body: body(json!({"database": "shop", "change": "add-order", "params": {
					"id": 7, "viewer": "11111111-2222-4333-8444-555555555555"
				}})),
			})
		);
	}

	#[test]
	fn a_command_line_it_cannot_read_is_refused_with_words() {
		for bad in [
			vec![],
			vec!["watch", "shop"],
			vec!["describe", "shop", "stock"],
			vec!["describe", "Shop"],
			vec!["describe", "9lives"],
			vec!["apply"],
			vec!["apply", "shop", "stock"],
			vec!["apply", "shop/tables"],
			vec!["query"],
			vec!["query", "shop"],
			vec!["query", "shop", "Open"],
			vec!["query", "shop", "open_orders"],
			vec!["query", "shop", "-open"],
			vec!["query", "shop", "--sql"],
			vec!["query", "shop", "count", "since"],
			vec!["query", "shop", "count", "Since=1"],
			vec!["query", "shop", "count", "a=1", "a=2"],
			vec!["query", "shop", "count", "a=1", "a:=2"],
			vec!["query", "shop", "count", "n:=seven"],
			vec!["query", "shop", "count", "n:=\"7\""],
			vec!["query", "shop", "count", ":=1"],
			vec!["query", "shop", "--sql-file"],
			vec!["query", "shop", "count", "--dry-run"],
			vec!["query", "shop", "count", "--params-json", "[1,2]"],
			vec!["query", "shop", "count", "--params-json", "{\"Bad\":1}"],
			vec!["query", "shop", "count", "--params-json", "{\"a\":1}", "a:=2"],
			vec!["describe", "--format", "yaml"],
			vec!["rows", "shop"],
			vec!["rows", "shop", "bad-table"],
			vec!["rows", "shop", "orders", "--limit", "0"],
			vec!["rows", "shop", "orders", "--limit", "1001"],
			vec!["rows", "shop", "orders", "--order", "id:sideways"],
			vec!["rows", "shop", "orders", "--order", "bad-col:asc"],
			vec!["changes"],
			vec!["changes", "shop", "extra"],
			vec!["change", "shop"],
			vec!["change", "shop", "../add"],
			vec!["change", "shop", "add", "id"],
		] {
			let got = call(&args(&bad));
			assert!(got.as_ref().is_err_and(|words| !words.is_empty()), "{bad:?}: {got:?}");
		}
	}

	struct Temp(PathBuf);
	impl Temp {
		fn new() -> Self {
			static NEXT: AtomicUsize = AtomicUsize::new(0);
			let dir = std::env::temp_dir().join(format!("qorpera-data-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
			std::fs::create_dir_all(dir.join("company/data/shop/queries")).unwrap();
			Self(dir)
		}
		fn root(&self) -> PathBuf {
			self.0.join("company")
		}
	}
	impl Drop for Temp {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	fn view() -> View {
		View { environment_id: "11111111-2222-4333-8444-555555555555".into(), view_id: "7e57f1e0-0001-4a00-8b00-000000000001".into(), pass: "p".repeat(43) }
	}

	fn quick() -> Waits {
		Waits { hello: Duration::from_secs(5), call: Duration::from_secs(5), apply: Duration::from_secs(5), save: Duration::from_millis(300), pause: Duration::from_millis(50) }
	}

	fn sha256_hex(text: &str) -> String {
		Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
	}

	enum Reply {
		Frame(u8, Value),
		Hang,
	}

	fn service_with(temp: &Temp, mut respond: impl FnMut(usize, &Value) -> Reply + Send + 'static) -> (String, mpsc::Receiver<Vec<(u8, Value)>>) {
		let path = temp.0.join("service.sock");
		let _ = std::fs::remove_file(&path);
		let listener = UnixListener::bind(&path).unwrap();
		let (told, heard) = mpsc::channel();
		std::thread::spawn(move || {
			let (mut stream, _) = listener.accept().unwrap();
			let mut seen: Vec<(u8, Value)> = Vec::new();
			while let Ok((got, payload)) = read_frame(&mut stream) {
				let frame: Value = serde_json::from_slice(&payload).unwrap();
				let reply = respond(seen.len(), &frame);
				seen.push((got, frame));
				match reply {
					Reply::Frame(answers, value) => {
						if write_frame(&mut stream, answers, &serde_json::to_vec(&value).unwrap()).is_err() {
							break;
						}
					}
					Reply::Hang => break,
				}
			}
			let _ = told.send(seen);
		});
		(format!("unix:{}", path.display()), heard)
	}

	fn service(temp: &Temp, script: Vec<Reply>) -> (String, mpsc::Receiver<Vec<(u8, Value)>>) {
		let mut script = script.into_iter();
		service_with(temp, move |_, _| script.next().unwrap_or(Reply::Hang))
	}

	fn hello_ok() -> Reply {
		Reply::Frame(kind::HELLO_OK, json!({"protocol": 5, "viewId": view().view_id}))
	}

	fn answer(status: u64, value: Value) -> Reply {
		Reply::Frame(kind::DATA_ANSWER, json!({"status": status, "value": value}))
	}

	fn printed(addr: &str, temp: &Temp, line: &[&str]) -> (u8, String, String) {
		let (mut out, mut err) = (Vec::new(), Vec::new());
		let code = run(addr, &view(), &temp.root(), &call(&args(line)).unwrap(), &quick(), &mut out, &mut err);
		(code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
	}

	#[test]
	fn says_hello_as_the_view_in_the_data_role_and_prints_the_answer() {
		let temp = Temp::new();
		let (addr, heard) = service(&temp, vec![hello_ok(), answer(200, json!({"columns": ["n"], "rows": [[2]], "more": false}))]);
		let (code, out, err) = printed(&addr, &temp, &["query", "shop", "count", "since=2026"]);
		assert_eq!((code, out.as_str(), err.as_str()), (EXIT_ANSWER, "{\"columns\":[\"n\"],\"more\":false,\"rows\":[[2]]}\n", ""));
		let seen = heard.recv().unwrap();
		assert_eq!(
			seen,
			vec![
				(kind::HELLO, json!({"protocol": 5, "environmentId": view().environment_id, "viewId": view().view_id, "pass": view().pass, "role": "data"})),
				(kind::DATA_CALL, json!({"verb": "query", "body": {"database": "shop", "question": "count", "params": {"since": "2026"}}})),
			]
		);
	}

	#[test]
	fn a_refusal_is_exit_1_with_its_words_and_an_unreachable_store_exit_3() {
		let temp = Temp::new();
		let (addr, _) = service(&temp, vec![hello_ok(), answer(404, json!({"error": "No question shop/nope that you may read"}))]);
		assert_eq!(printed(&addr, &temp, &["query", "shop", "nope"]), (EXIT_REFUSED, String::new(), "data: No question shop/nope that you may read\n".into()));
		let (addr, _) = service(&temp, vec![hello_ok(), answer(400, json!({"error": "syntax error at or near \"selec\"\u{1b}[2J", "position": 1}))]);
		assert_eq!(
			printed(&addr, &temp, &["query", "shop", "--sql", "selec 1"]),
			(EXIT_REFUSED, String::new(), "data: syntax error at or near \"selec\" [2J (at character 1)\n".into())
		);
		let (addr, _) = service(&temp, vec![hello_ok(), answer(507, json!({"error": "The company's data is at its limit"}))]);
		assert_eq!(printed(&addr, &temp, &["apply", "shop"]).0, EXIT_REFUSED);
		let (addr, _) = service(&temp, vec![hello_ok(), answer(503, json!({"error": "The company's databases cannot be reached now: try again"}))]);
		assert_eq!(
			printed(&addr, &temp, &["describe"]),
			(EXIT_UNREACHABLE, String::new(), "data: The company's databases cannot be reached now: try again\n".into())
		);
		let (addr, _) = service(&temp, vec![hello_ok(), answer(504, json!({"error": "No answer came from the company's data store, so the change may or may not have run."}))]);
		let (code, _, err) = printed(&addr, &temp, &["change", "shop", "add"]);
		assert_eq!(code, EXIT_UNREACHABLE);
		assert!(err.contains("may or may not have run"), "{err}");
	}

	#[test]
	fn a_refused_hello_no_service_and_no_answer_are_exit_3() {
		let temp = Temp::new();
		let refused = Reply::Frame(kind::ERROR, json!({"code": "VIEW_REFUSED", "message": "The view, its pass or this machine did not match"}));
		let (addr, _) = service(&temp, vec![refused]);
		let (code, out, err) = printed(&addr, &temp, &["describe"]);
		assert_eq!((code, out.as_str()), (EXIT_UNREACHABLE, ""));
		assert!(err.contains("cannot be reached from this machine now: The view, its pass or this machine did not match"), "{err}");
		for ok in [json!({"protocol": 4, "viewId": view().view_id}), json!({"protocol": 5, "viewId": "another"})] {
			let (addr, heard) = service_with(&temp, move |_, _| Reply::Frame(kind::HELLO_OK, ok.clone()));
			let (code, out, err) = printed(&addr, &temp, &["describe"]);
			assert_eq!((code, out.as_str()), (EXIT_UNREACHABLE, ""));
			assert!(err.contains("the node answered for another view or protocol"), "{err}");
			assert_eq!(heard.recv().unwrap().len(), 1);
		}
		let missing = format!("unix:{}", temp.0.join("nothing.sock").display());
		assert_eq!(printed(&missing, &temp, &["describe"]).0, EXIT_UNREACHABLE);
		let (addr, _) = service(&temp, vec![hello_ok(), Reply::Hang]);
		let (code, _, err) = printed(&addr, &temp, &["query", "shop", "count"]);
		assert_eq!(code, EXIT_UNREACHABLE);
		assert!(err.contains("cannot be reached") && !err.contains("may or may not"), "{err}");
		let (addr, _) = service(&temp, vec![hello_ok(), Reply::Hang]);
		let (code, _, err) = printed(&addr, &temp, &["change", "shop", "add"]);
		assert_eq!(code, EXIT_UNREACHABLE);
		assert!(err.contains("may or may not have run"), "{err}");
		let (addr, _) = service(&temp, vec![hello_ok(), Reply::Frame(kind::ERROR, json!({"code": "VIEW_CLOSED", "message": "The view was ended"}))]);
		let (code, _, err) = printed(&addr, &temp, &["apply", "shop"]);
		assert_eq!(code, EXIT_UNREACHABLE);
		assert!(err.contains("The view was ended") && err.contains("may or may not have run"), "{err}");
	}

	#[test]
	fn sends_the_text_the_gateway_asks_for_from_the_company_folder_by_its_hash() {
		let temp = Temp::new();
		let text = "-- How many orders.\nselect count(*) from orders;\n";
		std::fs::write(temp.root().join("data/shop/queries/count.sql"), text).unwrap();
		let need = json!({"need": [
			{"path": "data/shop/queries/count.sql", "sha256": sha256_hex(text)},
			{"path": "data/shop/queries/gone.sql", "sha256": sha256_hex("select 1")},
		]});
		let (addr, heard) = service(&temp, vec![hello_ok(), answer(200, need), answer(200, json!({"rows": [[2]]}))]);
		assert_eq!(printed(&addr, &temp, &["query", "shop", "count"]), (EXIT_ANSWER, "{\"rows\":[[2]]}\n".into(), String::new()));
		let seen = heard.recv().unwrap();
		assert_eq!(seen[1].1, json!({"verb": "query", "body": {"database": "shop", "question": "count"}}));
		assert_eq!(seen[2].1, json!({"verb": "query", "body": {"database": "shop", "question": "count", "texts": {sha256_hex(text): text}}}));
	}

	#[test]
	fn asks_again_for_a_file_not_saved_yet_and_gives_up_with_words() {
		let temp = Temp::new();
		let saved = "select 1;\n";
		std::fs::write(temp.root().join("data/shop/queries/count.sql"), "select 2;\n").unwrap();
		let need = move || answer(200, json!({"need": [{"path": "data/shop/queries/count.sql", "sha256": sha256_hex(saved)}]}));
		let (addr, heard) = service_with(&temp, move |frame, call| {
			if frame == 0 {
				hello_ok()
			} else if call["body"].get("texts").is_some() {
				answer(200, json!({"rows": []}))
			} else {
				need()
			}
		});
		let root = temp.root();
		let writer = std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(80));
			std::fs::write(root.join("data/shop/queries/count.sql"), saved).unwrap();
		});
		let (code, out, _) = printed(&addr, &temp, &["query", "shop", "count"]);
		writer.join().unwrap();
		assert_eq!((code, out.as_str()), (EXIT_ANSWER, "{\"rows\":[]}\n"));
		let seen = heard.recv().unwrap();
		assert!(seen.len() >= 3, "the text went only once the store asked for it: {}", seen.len());
		assert_eq!(seen.last().unwrap().1["body"]["texts"], json!({sha256_hex(saved): saved}));
		std::fs::write(temp.root().join("data/shop/queries/count.sql"), "select 3;\n").unwrap();
		let (addr, _) = service_with(&temp, move |frame, _| if frame == 0 { hello_ok() } else { need() });
		let (code, out, err) = printed(&addr, &temp, &["query", "shop", "count"]);
		assert_eq!((code, out.as_str()), (EXIT_REFUSED, ""));
		assert!(err.contains("data/shop/queries/count.sql on this machine is not the file saved in the company folder"), "{err}");
		let odd = || answer(200, json!({"need": [{"path": "data/shop/queries/\u{1b}[2J.sql", "sha256": sha256_hex("select 1")}]}));
		let (addr, _) = service_with(&temp, move |frame, _| if frame == 0 { hello_ok() } else { odd() });
		let (code, _, err) = printed(&addr, &temp, &["describe", "shop"]);
		assert_eq!(code, EXIT_REFUSED);
		assert!(err.contains("data/shop/queries/ [2J.sql on this machine") && !err.contains('\u{1b}'), "{err:?}");
	}

	#[test]
	fn a_round_of_texts_leaves_room_for_the_pass_the_node_adds() {
		let temp = Temp::new();
		let mut wanted = Vec::new();
		for i in 0..17 {
			let length = if i < 16 { 62_000 } else { 55_281 };
			let head = format!("-- {i:02}\n");
			let text = format!("{head}{}", "x".repeat(length - head.len()));
			std::fs::write(temp.root().join(format!("data/shop/queries/q{i:02}.sql")), &text).unwrap();
			wanted.push((format!("data/shop/queries/q{i:02}.sql"), sha256_hex(&text)));
		}
		let mut sent: HashSet<String> = HashSet::new();
		let (addr, heard) = service_with(&temp, move |frame, call| {
			if frame == 0 {
				return hello_ok();
			}
			if let Some(texts) = call["body"].get("texts").and_then(Value::as_object) {
				sent.extend(texts.keys().cloned());
			}
			let need: Vec<Value> = wanted.iter().filter(|(_, hash)| !sent.contains(hash)).map(|(path, hash)| json!({"path": path, "sha256": hash})).collect();
			if need.is_empty() {
				answer(200, json!({"databases": []}))
			} else {
				answer(200, json!({ "need": need }))
			}
		});
		let (code, out, err) = printed(&addr, &temp, &["describe"]);
		assert_eq!((code, out.as_str(), err.as_str()), (EXIT_ANSWER, "{\"databases\":[]}\n", ""));
		let seen = heard.recv().unwrap();
		let rounds: Vec<usize> = seen[1..].iter().map(|(_, call)| call["body"].get("texts").and_then(Value::as_object).map_or(0, |texts| texts.len())).collect();
		assert_eq!(rounds, vec![0, 16, 1]);
		for (_, call) in &seen[1..] {
			assert!(serde_json::to_vec(call).unwrap().len() <= MAX_CALL - PASS_ROOM);
		}
	}

	struct Gone;
	impl Write for Gone {
		fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
			Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
		}
		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	#[test]
	fn an_answer_that_cannot_be_printed_is_never_a_refusal() {
		let temp = Temp::new();
		for (line, wrote) in [(&["change", "shop", "add"][..], true), (&["apply", "shop"][..], true), (&["query", "shop", "count"][..], false)] {
			let (addr, _) = service(&temp, vec![hello_ok(), answer(200, json!({"changed": 1}))]);
			let mut err = Vec::new();
			let code = run(&addr, &view(), &temp.root(), &call(&args(line)).unwrap(), &quick(), &mut Gone, &mut err);
			let words = String::from_utf8(err).unwrap();
			assert_eq!(code, EXIT_UNREACHABLE, "{line:?}");
			assert!(words.starts_with("data: the answer could not be printed"), "{words}");
			assert_eq!(words.contains("look before you run it again"), wrote, "{words}");
		}
	}

	#[test]
	fn a_call_larger_than_a_frame_is_refused_here_and_never_sent() {
		let temp = Temp::new();
		let (addr, heard) = service(&temp, vec![hello_ok()]);
		let big = "x".repeat(MAX_CALL);
		let (code, out, err) = printed(&addr, &temp, &["query", "shop", "--sql", big.as_str()]);
		assert_eq!((code, out.as_str(), err.as_str()), (EXIT_REFUSED, "", "data: the call is larger than 1 MiB\n"));
		assert_eq!(heard.recv().unwrap().len(), 1);
	}

	#[test]
	fn gives_up_when_the_store_keeps_asking_for_texts() {
		let temp = Temp::new();
		let text = "select 1;\n";
		std::fs::write(temp.root().join("data/shop/queries/count.sql"), text).unwrap();
		let hash = sha256_hex(text);
		let (addr, heard) = service_with(&temp, move |frame, _| {
			if frame == 0 {
				hello_ok()
			} else {
				answer(200, json!({"need": [{"path": "data/shop/queries/count.sql", "sha256": hash}]}))
			}
		});
		let (code, out, err) = printed(&addr, &temp, &["query", "shop", "count"]);
		assert_eq!((code, out.as_str()), (EXIT_REFUSED, ""));
		assert!(err.contains("kept changing while they were read"), "{err}");
		assert_eq!(heard.recv().unwrap().len(), 1 + 1 + ROUNDS);
	}

	#[test]
	fn reads_a_text_only_under_data_and_only_a_small_regular_file_of_that_hash() {
		let temp = Temp::new();
		let root = temp.root();
		let text = "select 1;\n";
		std::fs::write(root.join("data/shop/queries/one.sql"), text).unwrap();
		std::fs::write(temp.0.join("outside.sql"), text).unwrap();
		std::fs::write(root.join("data/shop/queries/big.sql"), vec![b'x'; MAX_TEXT as usize + 1]).unwrap();
		std::fs::write(root.join("data/shop/queries/bytes.sql"), [0xffu8, 0xfe]).unwrap();
		let hash = sha256_hex(text);
		assert_eq!(saved_text(&root, "data/shop/queries/one.sql", &hash).as_deref(), Some(text));
		assert_eq!(saved_text(&root, "data/shop/queries/one.sql", &sha256_hex("select 2;\n")), None);
		assert_eq!(saved_text(&root, "data/shop/queries/../../../../outside.sql", &hash), None);
		assert_eq!(saved_text(&root, "../outside.sql", &hash), None);
		assert_eq!(saved_text(&root, "/etc/hostname", &hash), None);
		assert_eq!(saved_text(&root, "data/shop/queries", &hash), None);
		assert_eq!(saved_text(&root, "data/shop/queries/none.sql", &hash), None);
		let big: String = Sha256::digest(vec![b'x'; MAX_TEXT as usize + 1]).iter().map(|b| format!("{b:02x}")).collect();
		assert_eq!(saved_text(&root, "data/shop/queries/big.sql", &big), None);
		let bytes: String = Sha256::digest([0xffu8, 0xfe]).iter().map(|b| format!("{b:02x}")).collect();
		assert_eq!(saved_text(&root, "data/shop/queries/bytes.sql", &bytes), None);
	}

	#[test]
	fn accepts_json_arrays_objects_params_files_sql_files_stdin_dry_run_rows_changes_and_help() {
		let temp = Temp::new();
		let parsed = |line: &[&str]| call(&args(line));
		assert_eq!(
			parsed(&["query", "shop", "search", "tags:=[\"a\",\"b\"]", "vec:=[0.1,0.2]", "meta:={\"k\":1,\"ok\":true}"]),
			Ok(Call {
				verb: Verb::Query,
				body: body(json!({
					"database": "shop",
					"question": "search",
					"params": { "tags": ["a", "b"], "vec": [0.1, 0.2], "meta": {"k": 1, "ok": true} }
				})),
			})
		);

		let sql_path = temp.0.join("q.sql");
		std::fs::write(&sql_path, "select * from orders where id = :id").unwrap();
		let params_path = temp.0.join("p.json");
		std::fs::write(&params_path, "{\"id\":42,\"tags\":[\"vip\"]}").unwrap();
		let from_file = parse_cli(
			&args(&[
				"query",
				"shop",
				"--sql-file",
				sql_path.to_str().unwrap(),
				"--params-file",
				params_path.to_str().unwrap(),
				"extra=ok",
				"--format",
				"table",
			]),
			None,
			std::io::empty(),
		)
		.unwrap();
		assert_eq!(
			from_file,
			Command::Execute(ParsedCall {
				call: Call {
					verb: Verb::Query,
					body: body(json!({
						"database": "shop",
						"sql": "select * from orders where id = :id",
						"params": { "id": 42, "tags": ["vip"], "extra": "ok" }
					})),
				},
				format: Format::Table,
				transform: Transform::Identity,
			})
		);

		let from_stdin = parse_cli(
			&args(&["query", "shop", "--sql", "-", "--params-json", "{\"n\":3}"]),
			None,
			"select :n".as_bytes(),
		)
		.unwrap();
		assert_eq!(
			from_stdin,
			Command::Execute(ParsedCall {
				call: Call { verb: Verb::Query, body: body(json!({"database": "shop", "sql": "select :n", "params": {"n": 3}})) },
				format: Format::Json,
				transform: Transform::Identity,
			})
		);

		let change_dry = parse_cli(&args(&["change", "shop", "add-order", "id:=7", "--dry-run"]), None, std::io::empty()).unwrap();
		assert_eq!(
			change_dry,
			Command::Execute(ParsedCall {
				call: Call {
					verb: Verb::Change,
					body: body(json!({"database": "shop", "change": "add-order", "params": {"id": 7}, "preview": true})),
				},
				format: Format::Json,
				transform: Transform::Identity,
			})
		);
		if let Command::Execute(ref p) = change_dry {
			assert!(!p.call.writes());
		}

		let apply_dry = parse_cli(&args(&["apply", "shop", "--dry-run"]), None, std::io::empty()).unwrap();
		assert_eq!(
			apply_dry,
			Command::Execute(ParsedCall {
				call: Call { verb: Verb::Describe, body: body(json!({"database": "shop"})) },
				format: Format::Json,
				transform: Transform::ApplyDryRun("shop".into()),
			})
		);

		let rows_cmd = parse_cli(
			&args(&["rows", "shop", "orders", "--limit", "25", "--offset", "10", "--order", "created_at:desc", "--format", "csv"]),
			None,
			std::io::empty(),
		)
		.unwrap();
		assert_eq!(
			rows_cmd,
			Command::Execute(ParsedCall {
				call: Call {
					verb: Verb::Query,
					body: body(json!({
						"database": "shop",
						"sql": "select * from \"orders\" order by \"created_at\" desc limit 25 offset 10"
					})),
				},
				format: Format::Csv,
				transform: Transform::Identity,
			})
		);

		let changes_cmd = parse_cli(&args(&["changes", "shop"]), None, std::io::empty()).unwrap();
		assert_eq!(
			changes_cmd,
			Command::Execute(ParsedCall {
				call: Call { verb: Verb::Describe, body: body(json!({"database": "shop"})) },
				format: Format::Json,
				transform: Transform::DatabaseChanges("shop".into()),
			})
		);

		for help in [vec!["--help"], vec!["-h"], vec!["query", "--help"], vec!["rows", "shop", "-h"]] {
			assert_eq!(parse_cli(&args(&help), None, std::io::empty()), Ok(Command::Help));
		}
	}

	#[test]
	fn formats_tabular_and_transformed_answers_in_all_formats() {
		let tabular_val = json!({"columns": ["id", "note"], "rows": [[1, "a, \"b\""], [2, null]], "more": false});
		let render = |val: &Value, fmt: Format| {
			let mut buf = Vec::new();
			format_value(val, fmt, &mut buf).unwrap();
			String::from_utf8(buf).unwrap()
		};
		assert_eq!(render(&tabular_val, Format::Csv), "id,note\n1,\"a, \"\"b\"\"\"\n2,\n");
		assert_eq!(render(&tabular_val, Format::Tsv), "id\tnote\n1\ta, \"b\"\n2\t\n");
		assert_eq!(render(&tabular_val, Format::Ndjson), "{\"id\":1,\"note\":\"a, \\\"b\\\"\"}\n{\"id\":2,\"note\":null}\n");
		let table = render(&tabular_val, Format::Table);
		assert!(table.contains("id | note\n") && table.contains("---+-------\n") && table.contains("1  | a, \"b\"\n"), "{table}");

		let describe_val = json!({
			"databases": [{
				"database": "shop",
				"steps": { "applied": [{"name": "001-init", "at": "2026-01-01"}], "waiting": ["002-idx"], "changed": [], "missing": [] },
				"changes": [{"name": "add", "words": "Add order", "parameters": ["id"]}]
			}]
		});
		let dry = transform_answer(describe_val.clone(), &Transform::ApplyDryRun("shop".into()));
		assert_eq!(dry["dryRun"], Value::Bool(true));
		assert_eq!(dry["steps"]["waiting"], json!(["002-idx"]));
		let dry_csv = render(&dry, Format::Csv);
		assert!(dry_csv.contains("applied,001-init,2026-01-01\n") && dry_csv.contains("waiting,002-idx,\n"), "{dry_csv}");

		let changes = transform_answer(describe_val, &Transform::DatabaseChanges("shop".into()));
		assert_eq!(changes["database"], json!("shop"));
		assert_eq!(changes["changes"][0]["name"], json!("add"));
		assert_eq!(render(&changes, Format::Ndjson), "{\"name\":\"add\",\"parameters\":[\"id\"],\"words\":\"Add order\"}\n");
	}
}
