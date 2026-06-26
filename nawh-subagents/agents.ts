/**
 * Agent discovery and loading for the nawh-subagents extension.
 *
 * This module reads agent definition `.md` files (with YAML frontmatter)
 * from user-level and project-level directories, merges them according to
 * scope, and provides formatting helpers for display.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition, AgentScope } from "./types";

/**
 * Parse the YAML frontmatter and body from a markdown file's content.
 *
 * Frontmatter is delimited by `---` at the top of the file. We use a
 * minimal YAML parser that handles the subset of fields our agent files
 * need: scalar strings, booleans, and block-lists (`- item`).
 */
function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	// Match `---\n...\n---\n<body>` at the start of the file.
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const yamlBlock = match[1];
	const body = match[2];
	const frontmatter = parseSimpleYaml(yamlBlock);

	return { frontmatter, body };
}

/**
 * A minimal YAML parser that supports the fields used in agent files:
 *
 * - `key: value`          → string or boolean
 * - `key:` then lines
 *   `- item`               → string array (block sequence)
 *
 * It does NOT attempt to be a full YAML parser — just enough for our
 * frontmatter which only uses scalars and string arrays.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split(/\r?\n/);

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		// Skip blank lines and comments
		if (line.trim() === "" || line.trim().startsWith("#")) {
			i++;
			continue;
		}

		// Match `key: value` or `key:` (with optional block sequence following)
		const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
		if (!kvMatch) {
			i++;
			continue;
		}

		const key = kvMatch[1];
		const value = kvMatch[2].trim();

		if (value !== "") {
			// Inline scalar value
			result[key] = parseScalar(value);
			i++;
		} else {
			// Could be a block sequence (list items with `- `) following
			i++;
			const listItems: string[] = [];
			while (i < lines.length) {
				const nextLine = lines[i];
				// List item: starts with `- `
				const listMatch = nextLine.match(/^\s+-\s+(.*)$/);
				if (listMatch) {
					listItems.push(listMatch[1].trim());
					i++;
				} else if (nextLine.trim() === "") {
					// Blank line within a block — skip but keep scanning
					i++;
				} else {
					// Not a list item — end of this block
					break;
				}
			}
			if (listItems.length > 0) {
				result[key] = listItems;
			} else {
				// No list items found; treat as empty string
				result[key] = "";
			}
		}
	}

	return result;
}

/**
 * Parse a YAML scalar value into a JS boolean or string.
 */
function parseScalar(value: string): unknown {
	const lower = value.toLowerCase();
	if (lower === "true") return true;
	if (lower === "false") return false;
	// Strip surrounding quotes if present
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Task 3.1: Load all agent definitions from a directory.
 *
 * Reads every `.md` file in `dir`, parses its YAML frontmatter, and returns
 * an array of {@link AgentDefinition} objects. Files without valid
 * frontmatter or a `name` field are silently skipped. If the directory
 * does not exist, an empty array is returned.
 *
 * @param dir - Absolute path to the agents directory.
 * @param source - Whether these are user-level or project-level agents.
 * @returns Array of agent definitions (possibly empty).
 */
export function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
): AgentDefinition[] {
	const agents: AgentDefinition[] = [];

	try {
		if (!existsSync(dir)) {
			return agents;
		}

		const stat = statSync(dir);
		if (!stat.isDirectory()) {
			return agents;
		}

		const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

		for (const file of files) {
			const filePath = join(dir, file);

			try {
				const content = readFileSync(filePath, "utf-8");
				const { frontmatter, body } = parseFrontmatter(content);

				const name = frontmatter.name as string | undefined;
				if (!name) {
					// Skip files without a name field
					continue;
				}

				const tools = Array.isArray(frontmatter.tools)
					? (frontmatter.tools as string[])
					: undefined;
				const model = frontmatter.model as string | undefined;
				const thinking = frontmatter.thinking as string | undefined;
				const isCouncil =
					frontmatter.is_council === true || frontmatter.is_council === "true";
				const locked =
					frontmatter.locked === true || frontmatter.locked === "true";
				const description =
					(frontmatter.description as string | undefined) ?? "";

				agents.push({
					name,
					description,
					tools,
					model,
					thinking,
					isCouncil,
					locked,
					systemPrompt: body.trim(),
					source: {
						type: source,
						path: filePath,
					},
				});
			} catch {}
		}
	} catch {
		// Directory read failed — return what we have (empty)
		return agents;
	}

	return agents;
}

/**
 * Task 3.2: Walk up the directory tree to find a `.pi/agents/` directory.
 *
 * Starting from `cwd`, checks each ancestor directory for a `.pi/agents/`
 * subdirectory. Returns the first match or `null` if none is found up to
 * the filesystem root.
 *
 * @param cwd - Starting directory path (absolute or relative).
 * @returns Path to the nearest `.pi/agents/` directory, or null.
 */
export function findNearestProjectAgentsDir(cwd: string): string | null {
	try {
		let current = resolve(cwd);

		// Walk up until we can't go further
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const candidate = join(current, ".pi", "agents");
			if (existsSync(candidate)) {
				const stat = statSync(candidate);
				if (stat.isDirectory()) {
					return candidate;
				}
			}

			const parent = dirname(current);
			if (parent === current) {
				// Reached filesystem root
				break;
			}
			current = parent;
		}
	} catch {
		// Any filesystem error — treat as not found
		return null;
	}

	return null;
}

/**
 * Task 3.3: Discover agents from the filesystem based on scope.
 *
 * - `"user"`: loads only from `~/.pi/agent/agents/` (user-level).
 * - `"project"`: loads only from the nearest `.pi/agents/` directory.
 * - `"both"`: loads user-level agents, then project-level agents, with
 *   project agents overriding user agents of the same name.
 *
 * Missing directories are handled gracefully (treated as empty).
 *
 * @param cwd - Current working directory (used for project-level discovery).
 * @param scope - Which agent sources to load.
 * @returns Merged array of agent definitions.
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope,
): AgentDefinition[] {
	const userAgentsDir = join(homedir(), ".pi", "agent", "agents");

	const userAgents = loadAgentsFromDir(userAgentsDir, "user");

	if (scope === "user") {
		return userAgents;
	}

	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const projectAgents = projectAgentsDir
		? loadAgentsFromDir(projectAgentsDir, "project")
		: [];

	if (scope === "project") {
		return projectAgents;
	}

	// scope === "both": merge with project overriding user by name
	const merged = new Map<string, AgentDefinition>();

	for (const agent of userAgents) {
		merged.set(agent.name, agent);
	}

	// Project agents override user agents with the same name
	for (const agent of projectAgents) {
		merged.set(agent.name, agent);
	}

	return Array.from(merged.values());
}

/**
 * Task 3.4: Format agent names and descriptions for display.
 *
 * Produces a simple list of `- name: description` lines suitable for
 * tool descriptions and error messages. If `maxItems` is provided and
 * there are more agents than that, the list is truncated and a trailing
 * `...` line is added.
 *
 * @param agents - Array of agent definitions to format.
 * @param maxItems - Optional maximum number of lines to show.
 * @returns Formatted string, one agent per line.
 */
export function formatAgentList(
	agents: AgentDefinition[],
	maxItems?: number,
): string {
	const lines = agents.map((agent) => `- ${agent.name}: ${agent.description}`);

	if (maxItems !== undefined && maxItems >= 0 && lines.length > maxItems) {
		const truncated = lines.slice(0, maxItems);
		truncated.push("...");
		return truncated.join("\n");
	}

	return lines.join("\n");
}
