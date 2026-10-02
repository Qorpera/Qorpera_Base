# Node parity check

Identical nodes (Stateless Compute step 2; design page "Identical Nodes",
https://claude.ai/artifact/8Gm5z4Jym3fpLWpeXe4t9Y). Both nodes should run the same setup. This read-only
tool shows every way they differ.

```sh
# On each node, as root (through the task-admin helper). It reads only and prints JSON.
node qorpera-node-parity.mjs collect company41-node-01 > node01.json
node qorpera-node-parity.mjs collect company41-node-02 > node02.json
# Anywhere. Exit 0: only allowed differences. Exit 1: the setups differ. Exit 2: bad input or an error.
node qorpera-node-parity.mjs compare class.json node01.json node02.json
```

An error prints one short line. It never prints a failed command's output, since an instance
listing carries every instance's configuration.

## What it looks at

It compares what the runtime depends on:

- the Qorpera and LXD systemd units, and whether each one runs and is enabled;
- the storage server (NFS) mounts: source and the options that matter (`ro`/`rw`, `noexec`,
  `nosuid`, `nodev`, `vers`, `hard`/`soft`, `sec`, `proto`);
- the LXD projects (`features.*`, `restricted*`, `limits.*`), managed networks and storage pools;
- the LXD projects that exist, even with none of those keys set;
- LXD instances that the database does not place: the fast host and company machine hosts. Their
  size (from the expanded configuration, as the node inventory reads it) and state are checked.
  Runs, sign-ins and machines placed by the database are checked by the node inventory, not here.
  Build machines (`user.qorpera.image_builder=true`) come and go, so they are left out.
- the node agent's role releases, and the **names** of each role's fixed settings and secret keys.

It takes only the names of a role's settings and secret keys. It never prints or stores a
setting's value or a credential, and never reads an env file.

The node's name is replaced by `<node>` in every name. For the label `company41-node-01` that is
the full label and its short forms `node01`, `node-01`, `node1` and `node-1`. So
`qorpera-exec-node01` on node 1 and `qorpera-exec-node02` on node 2 compare as the same thing. A
form only matches as a whole word: `node1` does not match inside `node10` or `subnode1`. If two
names on one node become the same after the swap, the collection stops with
`NODE_SETUP_NAME_COLLISION` rather than lose one.

## The class file

`class.json` lists the differences that are planned:

- `mayDiffer`: path prefixes that may differ. Example: `agent › roles`, while a rolling update has
  one node a release ahead.
- `onlyOn`: `{"<label>": [prefix, …]}`, things that only that node has on purpose. They must be
  missing on the other node. The label is the one given to `collect`.

Keep the class small. The goal is identical nodes, so every entry is a known gap with a plan. The
checked-in class allows only role releases. As of 2026-09-28 the known gaps are:

- node 1 mounts the company objects `noexec`, and node 2 does not;
- per-node coding and office workbench shares;
- node 1 alone has the production company machine, the recovery mounts and the object gateway;
- node 1 has no fast host until its own is made (`deploy/shared-execution/README.md`, "Node 1, in this order");
- the LXD project names are compared as they are. If the two nodes' run projects have different
  names (node 2's is `qn25b2`), their fast hosts show as two different hosts until the projects
  share a name or the class lists them.

Each gap closes with its own change. The changes are listed on the design page and, once change 1
(#424) is merged, in `deploy/first-node/RUNTIME-IDENTICAL-NODES.md`.
