# Node parity check

Identical nodes (Stateless Compute step 2; design page "Identical Nodes",
https://claude.ai/artifact/8Gm5z4Jym3fpLWpeXe4t9Y). Both nodes should run the same setup. This read-only
tool shows every way they differ.

```sh
# On each node, as root (through the task-admin helper). It reads only and prints JSON.
node qorpera-node-parity.mjs collect company41-node-01 > node01.json
node qorpera-node-parity.mjs collect company41-node-02 > node02.json
# Anywhere. Exit 0: only allowed differences. Exit 1: the setups differ.
node qorpera-node-parity.mjs compare class.json node01.json node02.json
```

## What it looks at

It compares what the runtime depends on:

- the Qorpera and LXD systemd units, and whether each one runs and is enabled;
- the storage server (NFS) mounts: source and the options that matter (`ro`/`rw`, `noexec`,
  `nosuid`, `nodev`, `vers`, `hard`/`soft`, `sec`, `proto`);
- the LXD projects (`features.*`, `restricted*`, `limits.*`), managed networks and storage pools;
- LXD instances that the database does not place: the fast host and company machine hosts. Its
  size and state are checked. Runs, sign-ins and machines placed by the database are checked by the
  node inventory, not here.
- the node agent's role releases, and the **names** of each role's fixed settings and secret keys.

It never reads a setting's value, a credential or an env file.

The node's own label is replaced by `<node>` in every name (`node01`, `node-01`, `node1` alike). So
`qorpera-exec-node01` on node 1 and `qorpera-exec-node02` on node 2 compare as the same thing.

## The class file

`class.json` lists the differences that are planned:

- `mayDiffer`: path prefixes that may differ. Example: `agent › roles`, while a rolling update has
  one node a release ahead.
- `onlyOn`: `{"<label>": [prefix, …]}`, things that only that node has on purpose. They must be
  missing on the other node.

Keep the class small. The goal is identical nodes, so every entry is a known gap with a plan. The
checked-in class allows only role releases. As of 2026-09-28 the known gaps are:

- node 1 mounts the company objects `noexec`, and node 2 does not;
- per-node coding and office workbench shares;
- node 1 alone has the production company machine, the recovery mounts and the object gateway;
- node 1 has no fast host.

Each gap closes with its own change (see `deploy/first-node/RUNTIME-IDENTICAL-NODES.md`).
