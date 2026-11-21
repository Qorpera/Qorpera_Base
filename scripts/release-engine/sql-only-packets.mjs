import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertOneTransaction, literal, migrationBody, statements } from "../runtime-roll.mjs";
import { validateReleaseManifest } from "./manifest.mjs";
import { buildAnchorCheckSql, dollarQuote } from "./sql-checks.mjs";

export const SQL_ONLY_PACKET_SCHEMA = "qorpera.sql-only-packet/v1";
export const SQL_ONLY_DRY_RUN_FILES = Object.freeze([
	"00-check.sql",
	"05-rehearse-migrations.sql",
	"20-post-check.sql",
]);

const MIGRATION_BASENAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

function activeBundleIs(version, sha) {
	return `exists (select 1 from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id
		where a.singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = ${version} and b.sha256 = ${literal(sha)} and a.runtime_bundle_sha256 = b.sha256)`;
}

function recordQuery(name) {
	const [, version] = MIGRATION_BASENAME.exec(name);
	return `select 1 from supabase_migrations.schema_migrations where version = ${literal(version)}`;
}

function notRecordedCheck(name) {
	return [`not exists (${recordQuery(name)})`, `${name} is already recorded; inspect receipts instead of replaying`];
}

function recordedCheck(name) {
	const [, , slug] = MIGRATION_BASENAME.exec(name);
	return [
		`exists (${recordQuery(name)} and name = ${literal(slug)})`,
		`${name} is not recorded yet (or under another name)`,
	];
}

function gate(tag, checks) {
	const body = checks.map(
		([condition, message]) => `\tif not coalesce((${condition}), false) then raise exception ${literal(message)}; end if;`,
	);
	return `do $${tag}$ begin\n${body.join("\n")}\nend $${tag}$;`;
}

function wrapPacket(lines) {
	return `begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '120s';\n${lines.join("\n")}\ncommit;\n`;
}

function historyInsert(name, text) {
	const [, version, slug] = MIGRATION_BASENAME.exec(name);
	return `insert into supabase_migrations.schema_migrations(version,name,statements) values (${literal(version)},${literal(slug)},array[${dollarQuote(text)}]);`;
}

function dropTempFunction(name) {
	return `do $drop_pg_temp$ declare f regprocedure; begin for f in select p.oid::regprocedure from pg_catalog.pg_proc p where p.pronamespace = pg_my_temp_schema() and p.proname = ${literal(name)} loop execute format('drop function %s', f); end loop; end $drop_pg_temp$;`;
}

function readMigrationSql(migrationsByFile, file) {
	const text =
		migrationsByFile instanceof Map
			? migrationsByFile.get(file)
			: migrationsByFile && Object.hasOwn(migrationsByFile, file)
				? migrationsByFile[file]
				: undefined;
	if (typeof text !== "string" || text.trim().length === 0) {
		throw new Error(`Missing SQL text for migration ${file}`);
	}
	return text;
}

function validateSingleSelectSql(sql, name) {
	const trimmed = sql.trim().replace(/;+$/, "").trim();
	const parts = statements(`${trimmed};`);
	if (parts.length !== 1) {
		throw new Error(`postCheck '${name}' must be a single SQL statement`);
	}
	const masked = parts[0][2];
	if (!/^(?:select|with)\b/i.test(masked)) {
		throw new Error(`postCheck '${name}' must be a read-only SELECT or WITH query`);
	}
	if (/\b(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|into|call|do)\b/i.test(masked)) {
		throw new Error(`postCheck '${name}' must not contain mutating SQL keywords`);
	}
	return trimmed;
}

function analyzePgTempHelpers(ordered) {
	const helpers = new Map();
	const redeclared = new Map();
	for (const migration of ordered) {
		const cleaned = migration.text.replace(/--[^\n]*/g, "").toLowerCase();
		const functions = [...cleaned.matchAll(/create\s+(?:or\s+replace\s+)?function\s+pg_temp\.([a-z0-9_]+)/g)].map(
			(match) => match[1],
		);
		const tables = [
			...cleaned.matchAll(/create\s+(?:temporary|temp)\s+table\s+(if\s+not\s+exists\s+)?(?:pg_temp\.)?([a-z0-9_]+)/g),
		];
		for (const fnName of new Set(functions)) {
			const before = helpers.get(fnName);
			if (before?.table) {
				throw new Error(`${migration.name} and ${before.migration} both create pg_temp.${fnName}`);
			}
			if (before) {
				redeclared.set(before.migration, [...(redeclared.get(before.migration) ?? []), fnName]);
			}
			helpers.set(fnName, { migration: migration.name, table: false });
		}
		for (const tableName of tables.filter((match) => !match[1]).map((match) => match[2])) {
			if (helpers.has(tableName)) {
				throw new Error(`${migration.name} and ${helpers.get(tableName).migration} both create pg_temp.${tableName}`);
			}
			helpers.set(tableName, { migration: migration.name, table: true });
		}
		const created = new Set([...functions, ...tables.map((match) => match[2])]);
		for (const [, refName] of cleaned.matchAll(/pg_temp\.([a-z0-9_]+)/g)) {
			if (!created.has(refName)) {
				throw new Error(`${migration.name} uses pg_temp.${refName}, which it does not create`);
			}
		}
	}
	return redeclared;
}

export function sqlOnlyPackets(manifest, migrationsByFile) {
	validateReleaseManifest(manifest);
	if (manifest.mode !== "sql-only") {
		throw new Error(`sqlOnlyPackets requires mode 'sql-only' (got '${manifest.mode}')`);
	}
	const ordered = [...manifest.migrations]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((migration) => {
			const name = basename(migration.file);
			if (!MIGRATION_BASENAME.test(name)) {
				throw new Error(`Invalid migration filename: ${migration.file}`);
			}
			if (/runtime_bundle_activation/.test(name)) {
				throw new Error(`sql-only mode cannot apply activation migration ${name}`);
			}
			const text = readMigrationSql(migrationsByFile, migration.file);
			const body = migrationBody(text);
			return { ...migration, name, text, body };
		});

	const redeclared = analyzePgTempHelpers(ordered);
	const allAnchors = ordered.flatMap((migration) => migration.anchors);
	const allPostChecks = [];
	const seenPostNames = new Set();
	for (const migration of ordered) {
		for (const check of migration.postChecks) {
			if (seenPostNames.has(check.name)) {
				throw new Error(`Duplicate postCheck name across migrations: ${check.name}`);
			}
			seenPostNames.add(check.name);
			allPostChecks.push({ name: check.name, sql: validateSingleSelectSql(check.sql, check.name) });
		}
	}

	const activeCheck = [
		activeBundleIs(manifest.version, manifest.previousBundleSha256),
		`Runtime ${manifest.version} is not the active bundle`,
	];

	const files = {};
	files["00-check.sql"] = wrapPacket([
		gate("sql_only_check", [activeCheck, ...ordered.map((migration) => notRecordedCheck(migration.name))]),
		buildAnchorCheckSql(allAnchors),
	]);

	const rehearseLines = [
		gate("sql_only_rehearse", [activeCheck, ...ordered.map((migration) => notRecordedCheck(migration.name))]),
	];
	for (const migration of ordered) {
		rehearseLines.push("set local lock_timeout = '5s';\nset local statement_timeout = '120s';");
		rehearseLines.push(migration.body.trimEnd());
		rehearseLines.push(historyInsert(migration.name, migration.body));
		for (const tempFn of redeclared.get(migration.name) ?? []) {
			rehearseLines.push(dropTempFunction(tempFn));
		}
	}
	rehearseLines.push(
		`select jsonb_build_object('rehearsed', jsonb_build_array(${ordered.map((migration) => literal(migration.name)).join(", ")}), 'ok', true) as sql_only_rehearsal;`,
	);
	files["05-rehearse-migrations.sql"] = wrapPacket(rehearseLines);

	for (let idx = 0; idx < ordered.length; idx++) {
		const migration = ordered[idx];
		const checks = [activeCheck, notRecordedCheck(migration.name)];
		if (idx > 0) checks.push(recordedCheck(ordered[idx - 1].name));
		files[`10-migration-${migration.name}`] = wrapPacket([
			gate(`sql_only_mig_${idx}`, checks),
			migration.body.trimEnd(),
			historyInsert(migration.name, migration.body),
			`select jsonb_build_object('migration', ${literal(migration.name)}, 'recorded', true) as sql_only_migration;`,
		]);
	}

	const postCheckSelect =
		allPostChecks.length === 0
			? "select '{}'::jsonb as post_checks;"
			: `select jsonb_build_object(\n  ${allPostChecks
					.map((check) => `${literal(check.name)}, to_jsonb((${check.sql}))`)
					.join(",\n  ")}\n) as post_checks;`;
	files["20-post-check.sql"] = wrapPacket([
		gate("sql_only_post", [activeCheck, ...ordered.map((migration) => recordedCheck(migration.name))]),
		postCheckSelect,
	]);

	for (const [name, text] of Object.entries(files)) {
		assertOneTransaction(name, text);
	}
	return files;
}

export function writeSqlOnlyPackets(outDir, manifest, migrationsByFile) {
	if (typeof outDir !== "string" || outDir.length === 0) {
		throw new Error("outDir must be a non-empty path");
	}
	if (existsSync(outDir)) {
		throw new Error(`${outDir} exists; packets are written once`);
	}
	const files = sqlOnlyPackets(manifest, migrationsByFile);
	mkdirSync(outDir, { recursive: true });
	const digests = {};
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(outDir, name), text, { encoding: "utf8", flag: "wx" });
		digests[name] = createHash("sha256").update(text).digest("hex");
	}
	const packetManifest = {
		schema: SQL_ONLY_PACKET_SCHEMA,
		version: manifest.version,
		bundleSha256: manifest.previousBundleSha256,
		baseCommit: manifest.baseCommit,
		order: Object.keys(files),
		dryRunOnly: SQL_ONLY_DRY_RUN_FILES.filter((name) => name in files),
		files: digests,
	};
	writeFileSync(join(outDir, "packet.json"), `${JSON.stringify(packetManifest, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	return packetManifest;
}
