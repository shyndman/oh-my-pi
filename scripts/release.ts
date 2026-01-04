#!/usr/bin/env bun
/**
 * Release script for pi-mono
 *
 * Usage: bun scripts/release.ts <version>
 *
 * Example: bun scripts/release.ts 3.10.0
 *
 * Steps:
 * 1. Pre-flight checks (clean working dir, on main branch)
 * 2. Update package.json versions
 * 3. Regenerate lockfile
 * 4. Update CHANGELOGs ([Unreleased] -> [version] - date, add new [Unreleased])
 * 5. Commit and tag
 * 6. Push
 * 7. Watch CI
 */

import { $, Glob } from "bun";

const VERSION = process.argv[2];

if (!VERSION || !/^\d+\.\d+\.\d+/.test(VERSION)) {
	console.error("Usage: bun scripts/release.ts <version>");
	console.error("Example: bun scripts/release.ts 3.10.0");
	process.exit(1);
}

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];

	for await (const changelog of changelogGlob.scan(".")) {
		let content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// Replace [Unreleased] with version and date
		content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);

		// Add new [Unreleased] section after # Changelog header
		content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);

		await Bun.write(changelog, content);
		console.log(`  Updated ${changelog}`);
	}
}

// === Main Flow ===

console.log("\n=== Release Script ===\n");

// 1. Pre-flight checks
console.log("Pre-flight checks...");

const branch = await $`git branch --show-current`.text();
if (branch.trim() !== "main") {
	console.error(`Error: Must be on main branch (currently on '${branch.trim()}')`);
	process.exit(1);
}
console.log("  On main branch");

const status = await $`git status --porcelain`.text();
if (status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Update package versions
console.log(`Updating package versions to ${VERSION}...`);
const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));
await $`sd '"version": "[^"]+"' ${`"version": "${VERSION}"`} ${pkgJsonPaths}`;

// Verify
console.log("  Verifying versions:");
for (const pkgPath of pkgJsonPaths) {
	const pkgJson = await Bun.file(pkgPath).json();
	console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
}
console.log();

// 3. Regenerate lockfile
console.log("Regenerating lockfile...");
await $`rm -f bun.lock`;
await $`bun install`;
console.log();

// 4. Update changelogs
console.log("Updating CHANGELOGs...");
await updateChangelogsForRelease(VERSION);
console.log();

// 5. Commit and tag
console.log("Committing and tagging...");
await $`git add .`;
await $`git commit -m ${`chore: bump version to ${VERSION}`}`;
await $`git tag ${`v${VERSION}`}`;
console.log();

// 6. Push
console.log("Pushing to remote...");
await $`git push origin main`;
await $`git push origin ${`v${VERSION}`}`;
console.log();

// 7. Watch CI - wait for all workflow runs on current commit
console.log("Watching CI...");
const commitSha = (await $`git rev-parse HEAD`.text()).trim();
console.log(`  Commit: ${commitSha.slice(0, 8)}`);

// Poll until all runs complete
let allPassed = false;
while (!allPassed) {
	const runsOutput = await $`gh run list --commit ${commitSha} --json databaseId,status,conclusion,name`.text();
	const runs: Array<{ databaseId: number; status: string; conclusion: string | null; name: string }> =
		JSON.parse(runsOutput);

	if (runs.length === 0) {
		console.log("  Waiting for CI to start...");
		await Bun.sleep(3000);
		continue;
	}

	const pending = runs.filter((r) => r.status !== "completed");
	const failed = runs.filter((r) => r.status === "completed" && r.conclusion !== "success");
	const passed = runs.filter((r) => r.status === "completed" && r.conclusion === "success");

	console.log(`  ${passed.length} passed, ${pending.length} pending, ${failed.length} failed`);

	if (failed.length > 0) {
		console.error("\nCI failed:");
		for (const r of failed) {
			console.error(`  - ${r.name}: ${r.conclusion}`);
		}
		process.exit(1);
	}

	if (pending.length === 0) {
		allPassed = true;
	} else {
		await Bun.sleep(5000);
	}
}
console.log("  All CI checks passed!\n");

console.log(`=== Released v${VERSION} ===`);
console.log();
console.log("If CI failed, fix the issue and run:");
console.log("  git commit --amend --no-edit");
console.log("  git push origin main --force");
console.log(`  git tag -f v${VERSION} && git push origin v${VERSION} --force`);
console.log();
console.log("To publish to npm:");
console.log("  npm run publish");
