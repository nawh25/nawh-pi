/**
 * Configuration loading and agent config resolution for nawh-subagents.
 *
 * This module handles:
 * - Loading the user-level JSON config from `~/.pi/agent/nawh-subagents.json`
 * - Validating and normalising config fields with fallback defaults
 * - Resolving per-agent configurations by merging `.md` frontmatter with
 *   the active preset (respecting `locked: true` frontmatter)
 * - Resolving the council agent's councillor list
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
	AgentConfig,
	AgentDefinition,
	CouncillorConfig,
	PantheonConfig,
	Preset,
} from "./types";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"nawh-subagents.json",
);

const DEFAULT_PRESET = "default";

const DEFAULT_MAX_PARALLEL = 8;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_CONFIRM_PROJECT_AGENTS = true;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 2000;
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_STDERR_CAP_BYTES = 65536;

/** Default councillor set used when no valid councillors are configured. */
const DEFAULT_COUNCILLORS: CouncillorConfig[] = [
	{
		name: "strategist",
		model: "anthropic/claude-sonnet-4-20250514",
		prompt: "Focus on long-term architecture and strategy",
	},
	{
		name: "skeptic",
		model: "openai/gpt-4o",
		prompt: "Challenge assumptions and find edge cases",
	},
	{
		name: "pragmatist",
		model: "anthropic/claude-haiku-4-5",
		prompt: "Focus on practical implementation concerns",
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warn(message: string): void {
	process.stderr.write(`[nawh-subagents] ${message}\n`);
}

/**
 * Clamp an integer-like value to the inclusive range `[min, max]`.
 * Returns `undefined` when the value is not a valid integer in range.
 */
function clampInt(
	value: unknown,
	min: number,
	max: number,
): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	if (value < min || value > max) return undefined;
	return value;
}

// ---------------------------------------------------------------------------
// Task 4.1 — loadConfig
// ---------------------------------------------------------------------------

/**
 * Load and validate the user-level pantheon config from
 * `~/.pi/agent/nawh-subagents.json`.
 *
 * If the file is missing or malformed, hardcoded defaults are returned
 * with a warning to stderr. Individual invalid fields are dropped with a
 * warning and replaced by their default values.
 */
export function loadConfig(): PantheonConfig {
	// Start with defaults
	const config: PantheonConfig = {
		preset: DEFAULT_PRESET,
		presets: {},
		disabledAgents: [],
		maxParallel: DEFAULT_MAX_PARALLEL,
		maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		confirmProjectAgents: DEFAULT_CONFIRM_PROJECT_AGENTS,
		maxRetries: DEFAULT_MAX_RETRIES,
		retryBackoffBaseMs: DEFAULT_RETRY_BACKOFF_BASE_MS,
		idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
		stderrCapBytes: DEFAULT_STDERR_CAP_BYTES,
	};

	// Attempt to read the config file
	let raw: string;
	try {
		raw = fs.readFileSync(CONFIG_PATH, "utf-8");
	} catch {
		warn(`Config file not found at ${CONFIG_PATH}; using defaults.`);
		return config;
	}

	// Parse JSON
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warn(`Config file at ${CONFIG_PATH} is malformed JSON; using defaults.`);
		return config;
	}

	if (typeof parsed !== "object" || parsed === null) {
		warn(`Config file at ${CONFIG_PATH} is not a JSON object; using defaults.`);
		return config;
	}

	// --- preset ----------------------------------------------------------
	if (typeof parsed.preset === "string" && parsed.preset.length > 0) {
		config.preset = parsed.preset;
	} else if (parsed.preset !== undefined) {
		warn(
			`Invalid "preset" value in config (expected non-empty string); using default "${DEFAULT_PRESET}".`,
		);
	}

	// --- presets ---------------------------------------------------------
	if (
		parsed.presets !== undefined &&
		(typeof parsed.presets !== "object" || parsed.presets === null)
	) {
		warn(
			`Invalid "presets" value in config (expected object); using empty presets.`,
		);
	} else if (typeof parsed.presets === "object") {
		// Shallow-clone the presets record; we trust the structure
		config.presets = parsed.presets as Record<string, Preset>;
	}

	// Warn if the active preset doesn't exist in presets (but keep it)
	if (config.preset !== DEFAULT_PRESET && !(config.preset in config.presets)) {
		warn(
			`Active preset "${config.preset}" not found in presets; agents will use frontmatter defaults.`,
		);
	}

	// --- disabledAgents --------------------------------------------------
	if (Array.isArray(parsed.disabledAgents)) {
		const valid = parsed.disabledAgents.every(
			(a: unknown) => typeof a === "string",
		);
		if (valid) {
			config.disabledAgents = parsed.disabledAgents as string[];
		} else {
			warn(
				`Invalid "disabledAgents" value in config (expected array of strings); using empty array.`,
			);
		}
	} else if (parsed.disabledAgents !== undefined) {
		warn(
			`Invalid "disabledAgents" value in config (expected array of strings); using empty array.`,
		);
	}

	// --- maxParallel -----------------------------------------------------
	const maxParallel = clampInt(parsed.maxParallel, 1, 20);
	if (maxParallel !== undefined) {
		config.maxParallel = maxParallel;
	} else if (parsed.maxParallel !== undefined) {
		warn(
			`Invalid "maxParallel" value in config (expected integer 1-20); using default ${DEFAULT_MAX_PARALLEL}.`,
		);
	}

	// --- maxConcurrency --------------------------------------------------
	const maxConcurrency = clampInt(parsed.maxConcurrency, 1, 20);
	if (maxConcurrency !== undefined) {
		config.maxConcurrency = maxConcurrency;
	} else if (parsed.maxConcurrency !== undefined) {
		warn(
			`Invalid "maxConcurrency" value in config (expected integer 1-20); using default ${DEFAULT_MAX_CONCURRENCY}.`,
		);
	}

	// --- confirmProjectAgents -------------------------------------------
	if (typeof parsed.confirmProjectAgents === "boolean") {
		config.confirmProjectAgents = parsed.confirmProjectAgents;
	} else if (parsed.confirmProjectAgents !== undefined) {
		warn(
			`Invalid "confirmProjectAgents" value in config (expected boolean); using default ${DEFAULT_CONFIRM_PROJECT_AGENTS}.`,
		);
	}

	// --- maxRetries -----------------------------------------------------
	const maxRetries = clampInt(parsed.maxRetries, 0, 10);
	if (maxRetries !== undefined) {
		config.maxRetries = maxRetries;
	} else if (parsed.maxRetries !== undefined) {
		warn(
			`Invalid "maxRetries" value in config (expected integer 0-10); using default ${DEFAULT_MAX_RETRIES}.`,
		);
	}

	// --- retryBackoffBaseMs ---------------------------------------------
	const retryBackoffBaseMs = clampInt(parsed.retryBackoffBaseMs, 100, 60000);
	if (retryBackoffBaseMs !== undefined) {
		config.retryBackoffBaseMs = retryBackoffBaseMs;
	} else if (parsed.retryBackoffBaseMs !== undefined) {
		warn(
			`Invalid "retryBackoffBaseMs" value in config (expected integer 100-60000); using default ${DEFAULT_RETRY_BACKOFF_BASE_MS}.`,
		);
	}

	// --- idleTimeoutMs --------------------------------------------------
	const idleTimeoutMs = clampInt(parsed.idleTimeoutMs, 0, 600000);
	if (idleTimeoutMs !== undefined) {
		config.idleTimeoutMs = idleTimeoutMs;
	} else if (parsed.idleTimeoutMs !== undefined) {
		warn(
			`Invalid "idleTimeoutMs" value in config (expected integer 0-600000); using default ${DEFAULT_IDLE_TIMEOUT_MS}.`,
		);
	}

	// --- stderrCapBytes -------------------------------------------------
	const stderrCapBytes = clampInt(parsed.stderrCapBytes, 1024, 1048576);
	if (stderrCapBytes !== undefined) {
		config.stderrCapBytes = stderrCapBytes;
	} else if (parsed.stderrCapBytes !== undefined) {
		warn(
			`Invalid "stderrCapBytes" value in config (expected integer 1024-1048576); using default ${DEFAULT_STDERR_CAP_BYTES}.`,
		);
	}

	return config;
}

// ---------------------------------------------------------------------------
// Task 4.2 — resolveAgentConfig
// ---------------------------------------------------------------------------

/**
 * Merge an agent's `.md` frontmatter definition with the active preset.
 *
 * Resolution rules:
 * 1. Start with the AgentDefinition (frontmatter) values.
 * 2. Look up the agent name in the active preset.
 * 3. If the agent is `locked: true`, the preset cannot override
 *    model, thinking, or tools.
 * 4. Otherwise the preset overrides model, thinking, and tools when
 *    those fields are provided.
 * 5. For the council agent, councillors are resolved separately via
 *    {@link resolveCouncilConfig} (called by the caller, not here).
 *
 * @returns A fully-resolved {@link AgentConfig}.
 */
export function resolveAgentConfig(
	agentDef: AgentDefinition,
	presetConfig: PantheonConfig,
): AgentConfig {
	// Look up the preset override for this agent
	const presetOverride =
		presetConfig.presets[presetConfig.preset]?.[agentDef.name];

	// Determine effective values
	const canOverride = !agentDef.locked;

	const model =
		canOverride && presetOverride?.model
			? presetOverride.model
			: (agentDef.model ?? "");

	const thinking =
		canOverride && presetOverride?.thinking !== undefined
			? presetOverride.thinking
			: agentDef.thinking;

	const tools =
		canOverride && presetOverride?.tools !== undefined
			? presetOverride.tools
			: (agentDef.tools ?? []);

	return {
		name: agentDef.name,
		description: agentDef.description,
		tools,
		model,
		thinking,
		isCouncil: agentDef.isCouncil,
		locked: agentDef.locked,
		systemPrompt: agentDef.systemPrompt,
		source: agentDef.source,
	};
}

// ---------------------------------------------------------------------------
// Task 4.3 — resolveCouncilConfig
// ---------------------------------------------------------------------------

/**
 * Resolve the councillor list for the council agent from the active preset.
 *
 * - Extracts the `councillors` array from the preset override for the
 *   "council" agent.
 * - Validates each councillor has a required `name` (string) and `model`
 *   (string); optional `variant` and `prompt` are passed through.
 * - Councillors with missing/invalid `name` or `model` are dropped with a
 *   stderr warning.
 * - If no valid councillors remain, a default set is returned.
 *
 * @returns An array of validated {@link CouncillorConfig}.
 */
export function resolveCouncilConfig(
	agentDef: AgentDefinition,
	presetConfig: PantheonConfig,
): CouncillorConfig[] {
	const presetOverride =
		presetConfig.presets[presetConfig.preset]?.[agentDef.name];

	const rawCouncillors = presetOverride?.councillors;

	if (!Array.isArray(rawCouncillors) || rawCouncillors.length === 0) {
		// No councillors configured — use defaults
		return DEFAULT_COUNCILLORS.map((c) => ({ ...c }));
	}

	const valid: CouncillorConfig[] = [];

	for (const raw of rawCouncillors) {
		if (typeof raw !== "object" || raw === null) {
			warn("Skipping invalid councillor entry (not an object).");
			continue;
		}

		const name = raw.name;
		const model = raw.model;

		if (typeof name !== "string" || name.length === 0) {
			warn('Skipping councillor with missing or invalid "name".');
			continue;
		}

		if (typeof model !== "string" || model.length === 0) {
			warn(`Skipping councillor "${name}" with missing or invalid "model".`);
			continue;
		}

		const councillor: CouncillorConfig = { name, model };

		if (typeof raw.variant === "string" && raw.variant.length > 0) {
			councillor.variant = raw.variant;
		}

		if (typeof raw.prompt === "string" && raw.prompt.length > 0) {
			councillor.prompt = raw.prompt;
		}

		valid.push(councillor);
	}

	if (valid.length === 0) {
		warn("No valid councillors found in config; using default councillors.");
		return DEFAULT_COUNCILLORS.map((c) => ({ ...c }));
	}

	return valid;
}
