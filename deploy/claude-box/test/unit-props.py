#!/usr/bin/env python3
"""C2i proof: a unit file's [Service] sandboxing, as `systemd-run -p` takes it, so a proof runs under the real unit's
hardening and not a copy of it. What starts the unit's own program and hands it its secrets (the account, its
folders, its environment, credentials, the command, restart and stop settings) is left out: the proof names its
own. One property per line. Usage: unit-props.py UNIT [INSTANCE]"""
import sys

unit, instance = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
LEFT_OUT = {
    "Type", "User", "Group", "WorkingDirectory", "Environment", "EnvironmentFile", "LoadCredential", "ExecStart",
    "ExecStopPost", "Restart", "RestartSec", "TimeoutStopSec", "KillMode", "KillSignal", "ReadWritePaths",
    "RuntimeDirectory", "RuntimeDirectoryMode", "StopWhenUnneeded",
}
section = None
for line in open(unit):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("["):
        section = line
        continue
    if section != "[Service]":
        continue
    key, _, value = line.partition("=")
    if key in LEFT_OUT:
        continue
    print(f"{key}={value.replace('%i', instance)}")
