#!/usr/bin/env python3
"""P4: the file operations Claude Code's tools do, timed on one folder: fsbench.py ROOT LABEL [ROUNDS]
read = open+read one 2 KB file; edit = read, write a temp file, rename over (Claude Code's own way of saving);
glob = walk 5,000 files and match *.txt; grep = read all 5,000 files and look for the needle. Median of ROUNDS, ms."""
import os, statistics, sys, time

root, label = sys.argv[1], sys.argv[2]
rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 5
tree = os.path.join(root, "tree")


def t(fn):
    a = time.perf_counter(); r = fn(); return (time.perf_counter() - a) * 1000, r


def read(i):
    with open(f"{tree}/d{30 + i:02d}/f011.txt", "rb") as f:
        return len(f.read())


def edit(i):
    p = f"{tree}/d{40 + i:02d}/f012.txt"
    b = open(p, "rb").read().replace(b"\n", b"\nP4 bench edit\n", 1)
    tmp = p + f".tmp.{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(b)
    os.chmod(tmp, os.stat(p).st_mode & 0o7777)
    os.rename(tmp, p)
    return len(b)


def glob(_):
    n = 0
    for d, _, fs in os.walk(tree):
        n += sum(1 for x in fs if x.endswith(".txt"))
    return n


def grep(_):
    hits = 0
    for d, _, fs in os.walk(tree):
        for x in fs:
            with open(os.path.join(d, x), "rb") as f:
                if b"P4NEEDLE" in f.read():
                    hits += 1
    return hits


out = {}
for name, fn in (("read", read), ("edit", edit), ("glob", glob), ("grep", grep)):
    ms, res = [], None
    for i in range(rounds):
        m, res = t(lambda: fn(i))
        ms.append(m)
    out[name] = (round(ms[0], 2), round(statistics.median(ms), 2), res)
print("FSBENCH " + label + " " + " ".join(f"{k}: first {v[0]} ms, median {v[1]} ms ({v[2]})" for k, v in out.items()), flush=True)
