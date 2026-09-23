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
- The unit wraps it in `flock --nonblock /run/lock/qorpera-node-update.lock`. While the lock is held, the run is skipped
  (exit 75, counted as success), never queued.
- An update lane holds the lock from **export through transfer to import**. It does that with one node-side holder
  process, not one lock per script call. If a lane stalls between export and transfer for more than 6 h without the lock,
  for example while it waits for approval, the tidy-up removes the exported tarball. That is safe: the lane re-exports.

## Install (per node, root)

`install-node-tidy.sh` pins the sha256 of the tool, the unit and the timer, and the test checks those pins.

1. Write the node's configuration from `node-tidy.example.json`, then run `install-node-tidy.sh --config <file>`. It
   verifies the pins, installs the tool (0444) and the config, and runs a dry run. A refusal or error stops the install.
   It then installs the unit and timer without enabling them.
2. Review the dry run's kept list against the live pins, the instances and the office and coding configuration.
3. Rerun with `--enable-timer`.

The first dry runs on 2026-09-23 kept exactly the images a manual, reviewed cleanup had kept: 8 on node 1 and 6 on node 2.
