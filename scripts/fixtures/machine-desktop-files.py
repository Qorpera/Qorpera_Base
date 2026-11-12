#!/usr/bin/env python3
"""Walks deploy/machine/desktop-files through its cases without privilege, for scripts/package-machine-guest.test.mjs.

The program's two sides both run as the one who runs this: "root" is that account, `/` is a folder made for the run
(the program's TOP and OWNER), the account's Desktop folder is another, and the account's side is started without
setpriv, on the real path of what root's side names under its `/`. Everything else is the program's own code: the
walk, the archive, the pipe, the checks of the answer. What needs a second account (that the account's side cannot
reach what only root can) is proved by the image build.

  machine-desktop-files.py HELPER BASE cases          prints the cases' results as JSON
  machine-desktop-files.py HELPER BASE account ...    the account's side, as the program starts it
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import stat
import struct
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
helper, base = sys.argv[1], sys.argv[2]
loader = importlib.machinery.SourceFileLoader("desktop_files", helper)
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("desktop_files", loader))
loader.exec_module(m)
top, desk = os.path.join(base, "top"), os.path.join(base, "desk")
m.TOP, m.OWNER, m.DESK = top, os.geteuid(), desk

if sys.argv[3] == "account":
	try:
		m.main(sys.argv[3:])
	except m.Stop as stop:
		print(stop, file=sys.stderr)
		sys.exit(stop.code)
	sys.exit(0)

calls = []


def real(path):
	return path if path.startswith(base) else top + path


def account_command(words):
	calls.append(words[0])
	words = list(words)
	if words[0] in ("copy", "place"):
		words[1] = real(words[1])
	if words[0] == "save":
		words[2] = real(words[2])
	return [sys.executable, "-I", "-B", os.path.abspath(__file__), helper, base, "account", *words]


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


def take(name, kind, archive):
	return subprocess.run(account_command(["take", name, kind]), input=archive, capture_output=True, check=False)


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
m.PATIENCE = dict(m.PATIENCE, place=1)
m.account_command = lambda words: ["/bin/sleep", "20"]
results["patience"] = outcome(lambda: m.root_open("/everyone/site", False))
m.account_command = account_command

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
