//! `data`: a company machine's command for the company's databases (company databases slice 8a,
//! deploy/first-node/RUNTIME-COMPANY-DATABASES.md §9a). It acts as the boot's folder view: it says hello to the
//! node's folder service in the `data` role (protocol 5), sends one call (`T`) and prints the data gateway's answer
//! (`t`). No database login and no key is in the machine. The node side is
//! `packages/object-gateway/src/folder-service/` (RUNTIME-FOLDER-SERVICE.md, "The `data` role").

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

/// The command printed an answer.
pub const EXIT_ANSWER: u8 = 0;
/// The call was refused: its words are on standard error.
pub const EXIT_REFUSED: u8 = 1;
/// The databases cannot be reached from this machine now, no answer came, or the answer could not be printed.
pub const EXIT_UNREACHABLE: u8 = 3;

/// A call's frame at the service (protocol.ts `DATA_MAX_PAYLOAD`).
const MAX_CALL: usize = 1024 * 1024;
/// The node sends the call's body on with its own pass in it, and that must fit the same 1 MiB: the texts of one
/// round leave it this much room.
const PASS_ROOM: usize = 128;
/// A file whose text the gateway asks for: a step's is 64 KiB at most, a question's or a change's 16 KiB.
const MAX_TEXT: u64 = 64 * 1024;
/// Rounds of texts one call sends at most, each up to a frame.
const ROUNDS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verb {
	Describe,
	Apply,
	Query,
	Change,
}

/// One call, as the data gateway takes it: the verb and its body, without a pass (the node adds its own).
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
	pub verb: Verb,
	pub body: Map<String, Value>,
}

/// How long the command waits, so tests need not.
#[derive(Debug, Clone, Copy)]
pub struct Waits {
	/// The node's answer to the hello.
	pub hello: Duration,
	/// A call's answer: the service ends a call at 30 s, so the command waits a little longer.
	pub call: Duration,
	/// An apply's: the service gives it 120 s.
	pub apply: Duration,
	/// A file written a moment ago is saved to the folder about two seconds after its last change: the command asks
	/// again this long for a file whose text here is not the saved one, this often.
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

/// A database's name, as the platform and the gateway take it.
fn database_name(name: &str) -> bool {
	let bytes = name.as_bytes();
	!bytes.is_empty()
		&& bytes.len() <= 40
		&& bytes[0].is_ascii_lowercase()
		&& bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

/// A question's or a change's name: the file `<name>.sql`.
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

/// `name=value` is text; `name:=<JSON>` is a number, `true`, `false` or `null`.
fn parameters(args: &[String]) -> Result<Map<String, Value>, String> {
	let mut params = Map::new();
	for arg in args {
		let (left, text) = arg.split_once('=').ok_or_else(|| format!("{arg} is not name=value"))?;
		let (name, value) = match left.strip_suffix(':') {
			None => (left, Value::String(text.to_string())),
			Some(name) => match serde_json::from_str::<Value>(text) {
				Ok(value @ (Value::Number(_) | Value::Bool(_) | Value::Null)) => (name, value),
				_ => return Err(format!("{name}:= takes a number, true, false or null; {name}=<text> gives text")),
			},
		};
		if !parameter_name(name) {
			return Err(format!("{name} is no value's name (a lower-case letter or _, then letters, digits or _)"));
		}
		if params.insert(name.to_string(), value).is_some() {
			return Err(format!("{name} is given twice"));
		}
	}
	Ok(params)
}

/// The call a command line names:
/// `describe [<database>]`, `apply <database>`, `query <database> <question> [name=value ...]`,
/// `query <database> --sql <one select> [name=value ...]`, `change <database> <change> [name=value ...]`.
pub fn call(args: &[String]) -> Result<Call, String> {
	let (verb, rest) = args.split_first().ok_or("name what to do: describe, apply, query or change")?;
	let database = |name: &String| -> Result<Value, String> {
		if database_name(name) {
			Ok(Value::String(name.clone()))
		} else {
			Err(format!("{name} is no database's name (a lower-case letter, then letters, digits or _)"))
		}
	};
	let named = |what: &str, name: &String| -> Result<Value, String> {
		if file_name(name) {
			Ok(Value::String(name.clone()))
		} else {
			Err(format!("{name} is no {what}'s name (lower-case letters and digits, in parts joined by -)"))
		}
	};
	let mut body = Map::new();
	let verb = match verb.as_str() {
		"describe" => {
			match rest {
				[] => {}
				[name] => {
					body.insert("database".into(), database(name)?);
				}
				_ => return Err("describe takes one database, or none for all of them".into()),
			}
			Verb::Describe
		}
		"apply" => {
			match rest {
				[name] => body.insert("database".into(), database(name)?),
				_ => return Err("apply takes one database".into()),
			};
			Verb::Apply
		}
		"query" => {
			let (name, rest) = rest.split_first().ok_or("query takes a database, then a question's name or --sql and one select")?;
			body.insert("database".into(), database(name)?);
			let values = match rest {
				[flag] if flag == "--sql" => return Err("--sql takes one select".into()),
				[flag, sql, values @ ..] if flag == "--sql" => {
					body.insert("sql".into(), Value::String(sql.clone()));
					values
				}
				[question, values @ ..] => {
					body.insert("question".into(), named("question", question)?);
					values
				}
				[] => return Err("query takes a question's name, or --sql and one select".into()),
			};
			let params = parameters(values)?;
			if !params.is_empty() {
				body.insert("params".into(), Value::Object(params));
			}
			Verb::Query
		}
		"change" => {
			let (name, rest) = rest.split_first().ok_or("change takes a database, then a change's name")?;
			body.insert("database".into(), database(name)?);
			let (change, values) = rest.split_first().ok_or("change takes a change's name")?;
			body.insert("change".into(), named("change", change)?);
			let params = parameters(values)?;
			if !params.is_empty() {
				body.insert("params".into(), Value::Object(params));
			}
			Verb::Change
		}
		other => return Err(format!("{other} is not one of describe, apply, query and change")),
	};
	Ok(Call { verb, body })
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

/// What came of a call.
#[derive(Debug, PartialEq)]
pub enum Outcome {
	/// The gateway's answer, as JSON.
	Answer(Value),
	/// A refusal, in words.
	Refused(String),
	/// The databases could not be reached, or no answer came, in words.
	Unreachable(String),
}

enum Fail {
	/// The node answered with an error frame.
	Remote(ErrorReply),
	/// The link broke, or the answer made no sense.
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

/// Words from the node or the store, safe to print on a terminal: no control character.
fn plain(words: &str) -> String {
	words.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// The text of `path` under the company folder here, if it is the file the gateway asks for: a regular file of at
/// most 64 KiB whose bytes hash to `sha256`, and are text. A text counts only by its hash, so nothing read here is
/// trusted for more.
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

/// One call as the view, at the node's folder service at `addr`. When the gateway asks for a file's text (`need`),
/// the text is read from the company folder under `root` and the call is sent again.
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
	let writes = matches!(call.verb, Verb::Apply | Verb::Change);
	let limit = if call.verb == Verb::Apply { waits.apply } else { waits.call };
	if let Err(e) = stream.set_timeouts(Some(limit), Some(waits.hello)) {
		return unreachable(e.to_string());
	}
	// A call that may have written and got no answer has an outcome no one knows.
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
			// A refusal is the call's own; anything else is the road's (507: the company's data is at its limit).
			let refused = (400..500).contains(&answer.status) || answer.status == 507;
			return if refused { Outcome::Refused(words) } else { Outcome::Unreachable(words) };
		}
		let asks = answer.value.get("need").and_then(Value::as_array).is_some_and(|need| !need.is_empty());
		if !asks {
			return Outcome::Answer(answer.value);
		}
		let need = answer.value.get("need").and_then(Value::as_array).expect("checked above");
		// The files the gateway asks for, as they are saved in the folder: each adds `"<hash>":"<text>",` to the body.
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
			// None here is the saved one yet (written a moment ago), or the folder changed since: ask again for a while.
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

/// Runs one call and prints what came of it: the answer as one line of JSON on `out`, else the words on `err`.
pub fn run(addr: &str, view: &View, root: &Path, call: &Call, waits: &Waits, out: &mut impl Write, err: &mut impl Write) -> u8 {
	match ask(addr, view, root, call, waits) {
		Outcome::Answer(value) => {
			let line = serde_json::to_string(&value).expect("an answer serializes");
			if let Err(e) = writeln!(out, "{line}").and_then(|()| out.flush()) {
				// The answer came and could not be printed (a reader that left, a full disk): never a refusal, which
				// says nothing ran.
				let ran = if matches!(call.verb, Verb::Apply | Verb::Change) {
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
		// A value is text; `:=` gives a number, true, false or null.
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
			vec!["query", "shop", "count", "n:=[1]"],
			vec!["query", "shop", "count", "n:={}"],
			vec!["query", "shop", "count", ":=1"],
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

	/// What the stand-in service does with a frame it reads: answer it, or end the connection.
	enum Reply {
		Frame(u8, Value),
		Hang,
	}

	/// A stand-in for the node's folder service on a Unix socket: it takes one connection, answers each frame it
	/// reads (the first is frame 0) as `respond` says, and hands back the frames it read (kind and JSON).
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

	/// The stand-in with its answers in order; after the last it ends the connection.
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
		// PostgreSQL's place in the statement, and no control character on the terminal.
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
		// A node that answers the hello at another protocol (a mount's), or for another view, is sent no call.
		for ok in [json!({"protocol": 4, "viewId": view().view_id}), json!({"protocol": 5, "viewId": "another"})] {
			let (addr, heard) = service_with(&temp, move |_, _| Reply::Frame(kind::HELLO_OK, ok.clone()));
			let (code, out, err) = printed(&addr, &temp, &["describe"]);
			assert_eq!((code, out.as_str()), (EXIT_UNREACHABLE, ""));
			assert!(err.contains("the node answered for another view or protocol"), "{err}");
			assert_eq!(heard.recv().unwrap().len(), 1);
		}
		let missing = format!("unix:{}", temp.0.join("nothing.sock").display());
		assert_eq!(printed(&missing, &temp, &["describe"]).0, EXIT_UNREACHABLE);
		// A read that got no answer could not be asked; a change that got none may have run.
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
		// The second call carries the text under its hash, and only the one whose bytes here are the ones asked for.
		assert_eq!(seen[2].1, json!({"verb": "query", "body": {"database": "shop", "question": "count", "texts": {sha256_hex(text): text}}}));
	}

	#[test]
	fn asks_again_for_a_file_not_saved_yet_and_gives_up_with_words() {
		let temp = Temp::new();
		let saved = "select 1;\n";
		std::fs::write(temp.root().join("data/shop/queries/count.sql"), "select 2;\n").unwrap();
		let need = move || answer(200, json!({"need": [{"path": "data/shop/queries/count.sql", "sha256": sha256_hex(saved)}]}));
		// The folder here catches up a moment later: the call that follows carries the text, and is answered.
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
		// It never does: refused with the file's name, after the wait.
		std::fs::write(temp.root().join("data/shop/queries/count.sql"), "select 3;\n").unwrap();
		let (addr, _) = service_with(&temp, move |frame, _| if frame == 0 { hello_ok() } else { need() });
		let (code, out, err) = printed(&addr, &temp, &["query", "shop", "count"]);
		assert_eq!((code, out.as_str()), (EXIT_REFUSED, ""));
		assert!(err.contains("data/shop/queries/count.sql on this machine is not the file saved in the company folder"), "{err}");
		// A file's name reaches the terminal without its control characters.
		let odd = || answer(200, json!({"need": [{"path": "data/shop/queries/\u{1b}[2J.sql", "sha256": sha256_hex("select 1")}]}));
		let (addr, _) = service_with(&temp, move |frame, _| if frame == 0 { hello_ok() } else { odd() });
		let (code, _, err) = printed(&addr, &temp, &["describe", "shop"]);
		assert_eq!(code, EXIT_REFUSED);
		assert!(err.contains("data/shop/queries/ [2J.sql on this machine") && !err.contains('\u{1b}'), "{err:?}");
	}

	#[test]
	fn a_round_of_texts_leaves_room_for_the_pass_the_node_adds() {
		let temp = Temp::new();
		// Seventeen texts that together make a call some 40 bytes short of 1 MiB: with the node's pass, past it.
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
		// The call, then a round of sixteen texts, then the last one, whose call is answered.
		let rounds: Vec<usize> = seen[1..].iter().map(|(_, call)| call["body"].get("texts").and_then(Value::as_object).map_or(0, |texts| texts.len())).collect();
		assert_eq!(rounds, vec![0, 16, 1]);
		for (_, call) in &seen[1..] {
			assert!(serde_json::to_vec(call).unwrap().len() <= MAX_CALL - PASS_ROOM);
		}
	}

	/// A reader that left: every write fails.
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
		// The call, then one more for each round of texts.
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
}
