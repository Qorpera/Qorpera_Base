#!/usr/bin/env python3
"""Walks deploy/machine/desktop-files through its cases without privilege, for scripts/package-machine-guest.test.mjs.

The program's two sides both run as the one who runs this: "root" is that account, `/` is a folder made for the run
(the program's TOP and OWNER), the account's Desktop folder is another, and the account's side is started without
setpriv, on the real path of what root's side names under its `/`. Everything else is the program's own code: the
walk, the archive, the pipe, the checks of the answer. What needs a second account (that the account's side cannot
reach what only root can) is proved by the image build.

  machine-desktop-files.py HELPER BASE cases               prints the cases' results as JSON
  machine-desktop-files.py HELPER BASE stopped:WHEN[:N]    root's side asked to stop, by N signals (default one), WHEN:
                                                           copying (a second into a copy), spawn (as the account's
                                                           side is started), end (the side gone, its cp still to
                                                           write, as root's side ends what is left), twice (a first
                                                           signal a second into a copy with its staging there, a
                                                           second as root's side ends the copy for the first), tidy
                                                           (as the taking away is started), ignored (started with
                                                           SIGHUP ignored, as under nohup: a copy under a burst of
                                                           SIGHUP, then a copy that a SIGTERM stops)
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import threading
import time

sys.dont_write_bytecode = True
helper, base = sys.argv[1], sys.argv[2]
loader = importlib.machinery.SourceFileLoader("desktop_files", helper)
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("desktop_files", loader))
loader.exec_module(m)
top, desk = os.path.join(base, "top"), os.path.join(base, "desk")
m.TOP, m.OWNER, m.DESK = top, os.geteuid(), desk

if sys.argv[3].startswith("account"):
	# The account's side held up or ended where a case wants it: after its copy is made and before it has its name,
	# after a link is made, after a picture is written and before it is in its place.
	how = sys.argv[3].partition(":")[2]
	# What the account's side is started with: which signals are held back for it (root's side holds its stop
	# signals back; the account's processes must not), and whether it ignores SIGHUP (it does when root's side was
	# started ignoring it, as any program started under nohup does).
	with open(os.path.join(base, "account-mask"), "w") as note:
		held_back = sorted(int(number) for number in signal.pthread_sigmask(signal.SIG_BLOCK, ()))
		note.write(json.dumps({"held back": held_back, "ignores SIGHUP": signal.getsignal(signal.SIGHUP) is signal.SIG_IGN}))
	if how in ("copied-then-held", "copied-then-ended"):
		run = subprocess.run

		def held(*args, **more):
			result = run(*args, **more)
			if how == "copied-then-ended":
				os.kill(os.getpid(), signal.SIGKILL)
			time.sleep(30)
			return result

		m.subprocess.run = held
	if how in ("copying-then-ended", "copying-then-failed", "copying-then-held"):
		# Its `cp` is still to begin (it waits two seconds first) when the account's side is ended by another, ends
		# itself with an error, or is held up: a child that would write after everything was taken away.

		def left_copying(command, **_):
			subprocess.Popen(["/bin/sh", "-c", 'grep SigBlk /proc/self/status >"$0"; sleep 2; exec "$@"', os.path.join(base, "child-mask"), *command], stdin=subprocess.DEVNULL)
			if how == "copying-then-ended":
				os.kill(os.getpid(), signal.SIGKILL)
			if how == "copying-then-failed":
				os._exit(1)
			time.sleep(30)

		m.subprocess.run = left_copying
	if how == "linked-then-held":
		symlink = os.symlink
		m.os.symlink = lambda *args: (symlink(*args), time.sleep(30))
	if how == "written-then-held":
		copyfile = m.shutil.copyfile
		m.shutil.copyfile = lambda *args: (copyfile(*args), time.sleep(30))
	sys.argv[3] = "account"
	try:
		m.main(sys.argv[3:])
	except m.Stop as stop:
		print(stop, file=sys.stderr)
		sys.exit(stop.code)
	sys.exit(0)

calls = []


def real(path):
	return path if path.startswith(base) else top + path


how = ""


def account_command(words):
	calls.append(words[0])
	words = list(words)
	if words[0] in ("copy", "place"):
		words[1] = real(words[1])
	if words[0] == "save" or (words[0] == "tidy" and len(words) == 3):
		words[2] = real(words[2])
	# What takes away is never held up: only the piece of work a case names.
	side = "account" if words[0] == "tidy" or not how else f"account:{how}"
	return [sys.executable, "-I", "-B", os.path.abspath(__file__), helper, base, side, *words]


m.account_command = account_command
os.umask(0o022)


def make(path, mode=0o755):
	os.makedirs(top + path, exist_ok=True)
	os.chmod(top + path, mode)


def write(path, text, mode=0o644):
	with open(top + path, "w") as file:
		file.write(text)
	os.chmod(top + path, mode)


def acl(path, entries):
	os.setxattr(top + path, "system.posix_acl_access", struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries))


def outcome(work):
	"""What a piece of the program's work came to: its answer, or which of its refusals and with what words."""
	del calls[:]
	try:
		answer = work()
	except m.Missing as missing:
		return {"missing": str(missing), "calls": list(calls)}
	except m.NotRootsAlone as refusal:
		return {"refused": str(refusal), "calls": list(calls)}
	except m.Stop as stop:
		return {"stop": str(stop), "code": stop.code, "calls": list(calls)}
	return {"answer": answer, "calls": list(calls)}


def walked(path, **more):
	def work():
		way, name = m.walk(path, **more)
		with way:
			return [way.shown(), name]

	return outcome(work)


def read(path):
	with open(path) as file:
		return file.read()


def listing(folder):
	found = {}
	for where, folders, files in os.walk(folder):
		for name in folders + files:
			path = os.path.join(where, name)
			status = os.lstat(path)
			kind = "link:" + os.readlink(path) if stat.S_ISLNK(status.st_mode) else "folder" if stat.S_ISDIR(status.st_mode) else "file" if stat.S_ISREG(status.st_mode) else "other"
			found[os.path.relpath(path, folder)] = f"{kind} {stat.S_IMODE(status.st_mode):o}" if kind in ("folder", "file") else kind
	return found


if sys.argv[3].startswith("stopped"):
	# Root's side is asked to stop while the account's side or its `cp` (still to write: it waits two seconds first)
	# is there, or while what was on its way is being taken away. Root's side holds the signals back as its `main`
	# does and looks for them where it waits. Whenever they come and however many, the account's side and all it
	# started are ended and collected, the taking away runs to its end, and only then does root's side end, by the
	# signal; three seconds after the work was given up nothing has appeared.
	_, when, count = (sys.argv[3] + "::").split(":")[:3]
	make("")
	make("/everyone", 0o1777)
	make("/everyone/large")
	write("/everyone/large/a.bin", "a" * 400000)
	os.makedirs(desk)
	m.heed_stops()

	def stop(only=(signal.SIGTERM, signal.SIGHUP, signal.SIGINT)):
		# One signal (SIGTERM), or as many as asked for, of the three kinds in turn.
		for number in range(int(count or 1)):
			os.kill(os.getpid(), only[number % len(only)])

	how = "copying-then-held"
	if when in ("copying", "twice"):
		# A second into the copy: sent by a process of its own, so that root's side stays one thread.
		how = "copied-then-held" if when == "twice" else how
		kinds = " ".join(("TERM", "HUP", "INT")[number % 3] for number in range(int(count or 1)))
		subprocess.Popen(["/bin/sh", "-c", f"sleep 1; for kind in {kinds}; do kill -$kind {os.getpid()}; done"])
	if when in ("spawn", "tidy"):
		how = "copying-then-failed" if when == "tidy" else how
		spawned = []

		class Started(subprocess.Popen):
			def __init__(self, *args, **more):
				super().__init__(*args, **more)
				spawned.append(True)
				if len(spawned) == (2 if when == "tidy" else 1):
					stop()

		subprocess.Popen = Started
	if when in ("end", "twice"):
		how = "copying-then-failed" if when == "end" else how
		end_group, ends = m.end_group, []

		def ending(process):
			# end: as root's side ends what the side left. twice: right after it ended the copy for the first signal.
			ends.append(True)
			if when == "end" and len(ends) == 1:
				stop()
			end_group(process)
			if when == "twice" and len(ends) == 1:
				stop((signal.SIGHUP,))

		m.end_group = ending
	went = None
	if when == "ignored":
		# Root's side was started with SIGHUP ignored (the test starts this so; `nohup` does). A first copy is made
		# under a burst of ten SIGHUP sent as the account's side is started: it runs to its end. A second copy, in
		# the same run, is then stopped by a SIGTERM (one, at its start) as any is.
		how = ""
		sends = [lambda: [os.kill(os.getpid(), signal.SIGHUP) for _ in range(10)], lambda: os.kill(os.getpid(), signal.SIGTERM)]

		class Signalled(subprocess.Popen):
			def __init__(self, *args, **more):
				super().__init__(*args, **more)
				if sends:
					sends.pop(0)()

		subprocess.Popen = Signalled
		went = outcome(lambda: m.root_open("/everyone/large", True))
		went["waits"] = sorted(int(number) for number in signal.sigpending())
		went["on the desk"] = sorted(listing(desk))
		how = "copying-then-held"
		del calls[:]
	try:
		m.root_open("/everyone/large", True)
		gave_up = "it went on"
	except m.Stopped:
		gave_up = "stopped"
	except m.Stop as error:
		gave_up = str(error)
	time.sleep(3)
	masks = [open(os.path.join(base, name)).read().strip() if os.path.exists(os.path.join(base, name)) else None for name in ("account-mask", "child-mask")]
	held_back = sorted(int(number) for number in signal.pthread_sigmask(signal.SIG_BLOCK, ()))
	told = {"gave up": gave_up, "calls": calls, "desk": listing(desk), "waits": sorted(int(number) for number in signal.sigpending()), "held back": held_back, "the account's side": json.loads(masks[0]), "its child": masks[1]}
	if went:
		told["under SIGHUP"] = went
	print(json.dumps(told))
	sys.stdout.flush()
	# As the program's last statement does.
	if m.stop_asked():
		m.leave(m.stop_asked())
	sys.exit(0)


def take(name, kind, archive):
	return subprocess.run(account_command(["take", name, kind, "0123456789abcdef"]), input=archive, capture_output=True, check=False)


results = {}
for folder in ("", "/own", "/own/tree", "/own/tree/inner", "/own/site", "/own/group", "/own/acl-write", "/own/acl-read", "/own/elsewhere"):
	make(folder)
make("/everyone", 0o1777)
make("/own/group", 0o775)
make("/own/tree/inner", 0o750)
os.makedirs(desk)
write("/own/file.txt", "a file of root\n", 0o600)
write("/own/tree/a.txt", "a\n")
write("/own/tree/inner/b.txt", "b\n", 0o640)
os.symlink("../file.txt", top + "/own/tree/link")
os.mkfifo(top + "/own/tree/pipe")
write("/own/site/index.html", "<title>site</title>")
write("/own/elsewhere/hidden.txt", "what the link leads to\n", 0o000)
os.symlink("elsewhere", top + "/own/hop")
os.symlink("elsewhere/hidden.txt", top + "/own/hop-file")
write("/everyone/notes.txt", "notes\n")
make("/everyone/site")
write("/everyone/site/index.html", "<title>everyone</title>")
write("/own/picture.png", "\x89PNG picture")
try:
	acl("/own/acl-write", [(1, 7, 0xFFFFFFFF), (2, 7, 12345), (4, 5, 0xFFFFFFFF), (16, 5, 0xFFFFFFFF), (32, 5, 0xFFFFFFFF)])
	acl("/own/acl-read", [(1, 7, 0xFFFFFFFF), (2, 5, 12345), (4, 5, 0xFFFFFFFF), (16, 5, 0xFFFFFFFF), (32, 5, 0xFFFFFFFF)])
	results["acl"] = {
		"mode": f"{stat.S_IMODE(os.stat(top + '/own/acl-write').st_mode):o}",
		"write": walked("/own/acl-write/x"),
		"read": walked("/own/acl-read/x"),
	}
except OSError as error:
	results["acl"] = {"unsupported": str(error)}

# The walk: part by part, never through a link, only through folders that root alone can change.
results["walk"] = {
	"plain": walked("/own/tree/inner/b.txt"),
	"folder": walked("/own/tree/"),
	"up": walked("/own/tree/inner/../../file.txt"),
	"top": walked("/"),
	"link in the middle": walked("/own/hop/hidden.txt"),
	"group": walked("/own/group/x.png"),
	"everyone": walked("/everyone/x.png"),
	"missing": walked("/own/nope/x"),
	"made": walked("/own/made/deeper/x.png", make=True),
	"made mode": f"{stat.S_IMODE(os.stat(top + '/own/made/deeper').st_mode):o}",
	"relative": outcome(lambda: m.walk("own/x")),
}
m.OWNER += 1
results["walk"]["another owner"] = walked("/own/x")
m.OWNER -= 1


def opened(path):
	def work():
		way, name = m.walk(path)
		with way:
			fd, status = m.source(way, name)
			os.close(fd)
			return "folder" if stat.S_ISDIR(status.st_mode) else "file"

	return outcome(work)


results["source"] = {name: opened(f"/own/{name}") for name in ("file.txt", "tree", "hop", "hop-file", "tree/pipe", "nope")}

# The archive root sends: links as links, what is neither file, folder nor link left out, `done` last.
sent = io.BytesIO()
way, name = m.walk("/own/tree")
with way:
	fd, status = m.source(way, name)
	left_out = m.send(fd, status, "/own/tree", sent)
	os.close(fd)
with tarfile.open(fileobj=io.BytesIO(sent.getvalue())) as tar:
	results["archive"] = {
		"left out": left_out,
		"members": [[member.name, "link:" + member.linkname if member.issym() else "folder" if member.isdir() else "file"] for member in tar],
	}
# A folder in it that others can write stops root in the middle: the copy that had begun is not kept, and the copy
# is the account's to make (which here, as the same account, it can: its cp copies the pipe too).
os.chmod(top + "/own/tree/inner", 0o777)
results["archive"]["a folder others can write"] = outcome(lambda: m.root_open("/own/tree", True))
results["archive"]["on the desk"] = listing(desk)
os.chmod(top + "/own/tree/inner", 0o750)
for name in os.listdir(desk):
	subprocess.run(["rm", "-rf", os.path.join(desk, name)], check=True)

# `desktop open --copy` and `desktop open`, root's side and the account's side together.
results["copy"] = {
	"file": outcome(lambda: m.root_open("/own/file.txt", True)),
	"file again": outcome(lambda: m.root_open("/own/file.txt", True)),
	"folder": outcome(lambda: m.root_open("/own/tree", True)),
	"site": outcome(lambda: m.root_open("/own/site/", True)),
	"missing": outcome(lambda: m.root_open("/own/nope", True)),
	"whole disk": outcome(lambda: m.root_open("/", True)),
}
results["copy"]["desk"] = listing(desk)
results["copy"]["file text"] = read(os.path.join(desk, "file.txt"))
# What is not on a way of root's alone is the account's to copy; root opens none of it.
results["account"] = {
	"copy": outcome(lambda: m.root_open("/everyone/notes.txt", True)),
	"a link at the end": outcome(lambda: m.root_open("/own/hop-file", True)),
	"a link in the middle": outcome(lambda: m.root_open("/own/hop/hidden.txt", True)),
	"place": outcome(lambda: m.root_open("/everyone/site", False)),
	"place again": outcome(lambda: m.root_open("/everyone/site", False)),
	"place cannot read": outcome(lambda: m.root_open("/own/elsewhere/hidden.txt", False)),
	"place missing": outcome(lambda: m.root_open("/everyone/nope", False)),
	"place missing where root alone writes": outcome(lambda: m.root_open("/own/nope", False)),
	"address": outcome(lambda: m.root_open("https://example.com/a", False)),
}
results["account"]["desk"] = listing(desk)
results["top"] = os.path.realpath(top)
results["desk"] = desk

# A copy that does not come whole is not kept; a name that is no plain name is refused.
half = io.BytesIO()
with tarfile.open(fileobj=half, mode="w|", format=tarfile.PAX_FORMAT) as tar:
	info = tarfile.TarInfo("copy")
	info.type = tarfile.DIRTYPE
	tar.addfile(info)
	info = tarfile.TarInfo("copy/a.txt")
	info.size = 2
	tar.addfile(info, io.BytesIO(b"a\n"))
before = sorted(os.listdir(desk))
cut = take("half", "folder", half.getvalue())
results["take"] = {
	"not whole": [cut.returncode, cut.stderr.decode().strip(), sorted(os.listdir(desk)) == before],
	"bad name": [take("../x", "file", b"").returncode, take("x", "pipe", b"").returncode],
}

# `desktop shot`: root writes inside the folder it holds, on a way of its own; elsewhere the account saves.
picture = top + "/own/picture.png"
os.symlink("file.txt", top + "/own/link.png")
results["save"] = {
	"own": outcome(lambda: m.root_save(picture, "/own/pictures/new/a.png")),
	"own again": outcome(lambda: m.root_save(picture, "/own/pictures/new/a.png")),
	"a link": outcome(lambda: m.root_save(picture, "/own/link.png")),
	"a folder": outcome(lambda: m.root_save(picture, "/own/tree/")),
	"company": outcome(lambda: m.root_save(picture, "/company/x.png")),
	"elsewhere": outcome(lambda: m.root_save(picture, "/everyone/shots/b.png")),
	"elsewhere, a link": outcome(lambda: m.root_save(picture, "/own/hop/c.png")),
}
results["save"]["written"] = [
	read(top + "/own/pictures/new/a.png") == read(picture),
	f"{stat.S_IMODE(os.stat(top + '/own/pictures/new').st_mode):o}",
	read(top + "/own/file.txt"),
	read(top + "/everyone/shots/b.png") == read(picture),
]

# An account's side that does not answer (the account can stop its own process) is ended when root's patience is.
patience = m.PATIENCE
m.PATIENCE = dict(patience, place=1, copy=1, take=1, save=1)
m.account_command = lambda words: ["/bin/sleep", "20"]
results["patience"] = outcome(lambda: m.root_open("/everyone/site", False))
m.account_command = account_command

# What is cut off leaves nothing that is not whole (review r1 F1 of #1712). Each case: what root answered, which of
# the account's works it started, and what the desk then holds beyond what it held (hidden names too).
make("/own/large")
for name in ("a", "b", "c", "d"):
	write(f"/own/large/{name}.bin", name * 400000)
make("/everyone/large")
write("/everyone/large/a.bin", "a" * 400000)
make("/everyone/half")
write("/everyone/half/a.bin", "a" * 400000)
write("/everyone/half/b.bin", "what the account cannot read", 0o000)


def cut(work, later=0):
	before = listing(desk)
	result = outcome(work)
	# What a child left behind would still write, it would have written by then.
	time.sleep(later)
	result["new on the desk"] = sorted(set(listing(desk)) - set(before))
	return result


class Slow:
	"""The pipe to the account's side, held up for three seconds once a part of the archive is through."""

	def __init__(self, pipe):
		self.pipe, self.through, self.held = pipe, 0, False

	def write(self, data):
		self.pipe.write(data)
		self.through += len(data)
		if self.through > 500000 and not self.held:
			self.pipe.flush()
			self.held = True
			time.sleep(3)
		return len(data)

	def flush(self):
		self.pipe.flush()


send = m.send
m.send = lambda fd, status, shown, out: send(fd, status, shown, Slow(out))
results["cut"] = {"a copy root sends, partly written, at root's patience": cut(lambda: m.root_open("/own/large", True))}
m.send = send
how = "copied-then-held"
results["cut"]["a copy the account makes, at root's patience"] = cut(lambda: m.root_open("/everyone/large", True))
how = "copied-then-ended"
results["cut"]["a copy the account makes, its process ended by another"] = cut(lambda: m.root_open("/everyone/large", True))
# The account's side gone while its `cp` is still to write (review r2 F1 of #1712): ended by another, ended by its own
# error. The child is ended with it and collected before anything is taken away, so nothing appears afterwards.
how = "copying-then-ended"
results["cut"]["a copy whose side another ends while its cp is still to write"] = cut(lambda: m.root_open("/everyone/large", True), later=3)
how = "copying-then-failed"
results["cut"]["a copy whose side ends itself while its cp is still to write"] = cut(lambda: m.root_open("/everyone/large", True), later=3)
how = "copying-then-held"
results["cut"]["a copy at root's patience while its cp is still to write"] = cut(lambda: m.root_open("/everyone/large", True), later=3)
how = ""
results["cut"]["a copy that fails half way"] = cut(lambda: m.root_open("/everyone/half", True))
results["cut"]["a copy after those"] = cut(lambda: m.root_open("/everyone/large", True))
how = "linked-then-held"
results["cut"]["a link, after it was made"] = cut(lambda: m.root_open("/everyone/large", False))
how = ""
results["cut"]["the link again"] = cut(lambda: m.root_open("/everyone/large", False))
write("/everyone/kept.png", "the picture that was there")
how = "written-then-held"
results["cut"]["a picture, written and not yet in its place"] = outcome(lambda: m.root_save(picture, "/everyone/cut/new.png"))
results["cut"]["a picture over one that was there"] = outcome(lambda: m.root_save(picture, "/everyone/kept.png"))
how = ""
results["cut"]["pictures"] = [sorted(os.listdir(top + "/everyone/cut")), read(top + "/everyone/kept.png"), sorted(name for name in os.listdir(top + "/everyone") if name.endswith(".part"))]
m.PATIENCE = patience

# The account's answer is checked before root goes by it.
results["answers"] = {
	name: outcome(lambda printed=printed: m.answer_of(0, printed, "", "target"))
	for name, printed in {
		"good": "site\n/home/desktop/Desktop/a b\na b\n",
		"kind": "program\n/x\nx\n",
		"relative": "file\nx\nx\n",
		"a name with a slash": "file\n/x\na/b\n",
		"more lines": "file\n/x\nx\nmore\n",
		"a control character": "file\n/x\x1b[2J\nx\n",
	}.items()
}
results["answers"]["failed"] = outcome(lambda: m.answer_of(1, "", "it said why", "target"))
results["answers"]["whole disk"] = outcome(lambda: m.answer_of(m.WHOLE_DISK, "", "", "target"))
results["names"] = {name: [candidate for candidate, _ in zip(m.names(name, folder), range(3))] for name, folder in (("site", True), ("notes.txt", False), (".bashrc", False), ("a.tar.gz", False), ("x.", False), ("v1.2", True))}
print(json.dumps(results, indent=1))
