# Node tidy-up

Phase A2 of the node auto-update plan. Each runtime update imports a new ~1.8 GB LXD image and leaves an image
transfer file in `/var/tmp`. Nothing removed the old ones, and on 2026-09-23 the nodes' system disks reached 92 % and
95 %. `qorpera-node-tidy.mjs` removes what nothing live can use. The node agent (phase B) will take this over.

## What it keeps

An image stays when any of these holds:

- An instance uses it, whatever its state. That covers the exec host, the company computers (including suspended
  ones) and builders.
- It is listed in `keepFingerprints` (the v34 base image that runtime images are built from).
- It is the **live runtime pin**, **any newer (staged) pin**, or the **previous pin**, the newest older one with another
  fingerprint and so the rollback. The pins come from the provider env files (`pinFiles`). A pin file is live when a
  file a live unit starts from names it.
- A file that a live unit starts from names it. Those files are the effective `ExecStart`/`ExecStartPre`,
  `EnvironmentFiles`, the running process's command line, the paths named inside those files (three levels) and the
  `extraRoots`. Overridden drop-ins are not followed, so the pins of earlier cuts do not count as live.
- It is an Ubuntu base image.
- It was uploaded in the last `recentHours` (48). That covers an image a cut is importing.

Image transfer files matching `staging` are removed once they are older than `stagingMaxAgeHours` (6).

## When it refuses

The tool deletes nothing, not even transfer files, and exits 2 when:

- no live runtime pin is found;
- the live pin names no local image;
- more than `maxDelete` (20) images would go.

A refusal means the node looks unlike what these rules expect, so a person should look.

## Running it

- It is a dry run unless `--apply` is given. It prints one JSON report: kept images with their reasons, images and files
  to remove, the refusal, and errors.
- The unit wraps it in `flock --nonblock /run/lock/qorpera-node-update.lock`. Update lanes take the same lock around image
  transfer, import and old-image cleanup. While the lock is held, the run is skipped (exit 75, counted as success), never
  queued.

## Install (per node, root)

1. Copy `qorpera-node-tidy.mjs` to `/opt/qorpera-node-tidy/` (mode 0444), and write `/etc/qorpera-node-tidy.json` from
   `node-tidy.example.json`, adjusted to the node.
2. Run `/usr/bin/node /opt/qorpera-node-tidy/qorpera-node-tidy.mjs --config /etc/qorpera-node-tidy.json` (a dry run).
   Review the kept list against the live pins, the instances and the office and coding configuration.
3. Only then install `qorpera-node-tidy.service` and `.timer` into `/etc/systemd/system`, run `daemon-reload`, and
   `systemctl enable --now qorpera-node-tidy.timer`.

The first dry runs on 2026-09-23 kept exactly the images a manual, reviewed cleanup had kept: 8 on node 1 and 6 on node 2.
