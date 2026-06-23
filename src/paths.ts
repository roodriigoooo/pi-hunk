import os from "node:os";
import path from "node:path";

/** Resolve a user-typed path (handles @ prefix, ~, relative-to-cwd). */
export function resolveUserPath(inputPath: string, cwd: string): string {
	let p = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
	return path.resolve(p);
}

export function stripDiffPrefix(input: string): string {
	return input.replace(/^[ab]\//, "");
}

function relativePath(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : filePath;
}

/** Repo-relative display path for a diff file header / note grouping. */
export function displayPath(filePath: string | undefined, cwd: string): string {
	if (!filePath) return "general";
	const stripped = stripDiffPrefix(filePath);
	const p = path.isAbsolute(stripped) ? stripped : path.resolve(cwd, stripped);
	return relativePath(p, cwd).replace(/\\/g, "/");
}

export function fileKey(filePath: string | undefined, cwd: string): string | undefined {
	if (!filePath) return undefined;
	return displayPath(filePath, cwd).toLowerCase();
}

/** Shell-quote a single argument. Currently unused by the spawn-based hunk exec. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'"'"'`)}'`;
}
