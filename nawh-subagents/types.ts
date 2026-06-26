/**
 * Core type definitions for the nawh-subagents extension.
 *
 * This module defines all TypeScript interfaces and types used throughout
 * the extension, including agent configuration, pantheon configuration,
 * presets, usage statistics, and rendering data structures.
 */

/**
 * Routing rules for a single agent, used by the orchestrator prompt.
 *
 * Describes when the main LLM should delegate to this agent, when
 * it should not, and a quick decision heuristic.
 */
export interface AgentRouting {
	/** Situations where delegating to this agent is beneficial. */
	delegateWhen: string[];
	/** Situations where delegating to this agent is NOT recommended. */
	dontDelegateWhen: string[];
	/** A one-line heuristic for quick delegation decisions. */
	ruleOfThumb: string;
}

/**
 * Which agents to discover from the filesystem.
 *
 * - `"user"`    — only user-level agents (~/.pi/agents/*.md)
 * - `"project"` — only project-level agents (.pi/agents/*.md)
 * - `"both"`    — merge user and project agents (project overrides user)
 */
export type AgentScope = "user" | "project" | "both";

/**
 * Where an agent definition was discovered.
 */
export interface AgentSource {
	/** Whether this is a user-level or project-level agent. */
	type: "user" | "project";
	/** The filesystem path of the `.md` file. */
	path: string;
}

/**
 * Resolved configuration for an agent after preset merging.
 *
 * This is the fully-resolved configuration that the runner uses to
 * spawn a subagent subprocess.
 */
export interface AgentConfig {
	/** Agent name (e.g. "explorer", "oracle", "council"). */
	name: string;
	/** Human-readable description shown in agent listings. */
	description: string;
	/** Tools available to this agent (e.g. ["read", "grep", "find", "ls", "bash"]). */
	tools: string[];
	/** Model identifier (e.g. "anthropic/claude-haiku-4-5"). */
	model: string;
	/** Thinking budget: "low", "medium", or "high" (or undefined). */
	thinking?: string;
	/** True for the council agent which uses multi-LLM consensus. */
	isCouncil: boolean;
	/** If true, the preset cannot override this agent's settings. */
	locked: boolean;
	/** The full system prompt (body of the `.md` file, in English). */
	systemPrompt: string;
	/** Where the agent was discovered from. */
	source: AgentSource;
}

/**
 * Raw agent definition parsed from a `.md` file, before preset merging.
 *
 * Tools/model/thinking are optional here because they may be overridden
 * by the active preset during resolution.
 */
export interface AgentDefinition {
	/** Agent name. */
	name: string;
	/** Human-readable description. */
	description: string;
	/** Tools available (optional; may be overridden by preset). */
	tools?: string[];
	/** Model identifier (optional; may be overridden by preset). */
	model?: string;
	/** Thinking budget (optional; may be overridden by preset). */
	thinking?: string;
	/** True for the council agent. */
	isCouncil: boolean;
	/** If true, preset overrides are disallowed. */
	locked: boolean;
	/** Full system prompt text. */
	systemPrompt: string;
	/** Where this definition was discovered. */
	source: AgentSource;
}

/**
 * A named configuration preset that provides per-agent overrides.
 *
 * Each key is an agent name; the value is an {@link AgentOverride}.
 * For the "council" agent, the override may also include a
 * `councillors` array of {@link CouncillorConfig}.
 */
export interface Preset {
	[agentName: string]: AgentOverride | undefined;
}

/**
 * Per-agent override applied by a preset.
 *
 * Any field left undefined retains the agent's default value.
 */
export interface AgentOverride {
	/** Override the agent's model. */
	model?: string;
	/** Override the agent's thinking budget. */
	thinking?: string;
	/** Override the agent's tool list. */
	tools?: string[];
	/** Councillor list (only valid for the "council" agent). */
	councillors?: CouncillorConfig[];
}

/**
 * Configuration for a single councillor in a council agent.
 */
export interface CouncillorConfig {
	/** Councillor display name (required). */
	name: string;
	/** Model identifier for this councillor (required). */
	model: string;
	/** Optional thinking variant ("low", "medium", "high"). */
	variant?: string;
	/** Optional role/guidance prompt prepended to the task. */
	prompt?: string;
}

/**
 * The full pantheon configuration loaded from JSON.
 */
export interface PantheonConfig {
	/** The active preset name. */
	preset: string;
	/** All preset definitions keyed by name. */
	presets: Record<string, Preset>;
	/** Agent names to exclude from discovery. */
	disabledAgents: string[];
	/** Maximum number of parallel tasks the orchestrator may launch (default 8). */
	maxParallel: number;
	/** Maximum simultaneous subagent subprocesses (default 4). */
	maxConcurrency: number;
	/** Whether to confirm with the user before running project-level agents (default true). */
	confirmProjectAgents: boolean;
}

/**
 * Usage statistics collected from a completed subagent subprocess.
 */
export interface UsageStats {
	/** Number of turns the subagent took. */
	turns: number;
	/** Input tokens consumed. */
	inputTokens: number;
	/** Output tokens generated. */
	outputTokens: number;
	/** Cache-read tokens. */
	cacheReadTokens: number;
	/** Cache-write tokens. */
	cacheWriteTokens: number;
	/** Estimated cost in USD. */
	cost: number;
	/** Total tokens currently in context. */
	contextTokens: number;
	/** Model used by the subagent. */
	model: string;
}

/**
 * A single message emitted by the subprocess on stdout.
 */
export interface Message {
	/** Who emitted the message. */
	role: "assistant" | "tool";
	/** The kind of message. */
	type: "text" | "toolCall" | "toolResult";
	/** Text content (for `type: "text"`). */
	content?: string;
	/** Tool name (for `type: "toolCall"`). */
	toolName?: string;
	/** Tool arguments (for `type: "toolCall"`). */
	toolArgs?: any;
	/** Tool result text (for `type: "toolResult"`). */
	toolResult?: string;
}

/**
 * Detailed information about a running or completed subagent.
 */
export interface SubagentDetails {
	/** Agent name. */
	name: string;
	/** Agent type (explorer, oracle, etc.). */
	type: string;
	/** The task text assigned to this agent. */
	task: string;
	/** Current execution status. */
	status: "running" | "completed" | "failed" | "aborted";
	/** Number of turns completed so far. */
	turnCount: number;
	/** Number of tool invocations so far. */
	toolUseCount: number;
	/** Total tokens used so far. */
	tokenCount: number;
	/** Percentage of context window used (0-100). */
	contextPercent: number;
	/** Elapsed wall-clock time in milliseconds. */
	elapsedMs: number;
	/** Short human-readable activity description (e.g. "searching…", "editing 2 files…"). */
	currentActivity: string;
	/** Accumulated messages from the subprocess. */
	messages: Message[];
	/** Final usage stats (present after completion). */
	usage?: UsageStats;
	/** Final output text (present after completion). */
	output?: string;
	/** Error message if the subagent failed. */
	error?: string;
}

/**
 * Result of a single agent execution.
 */
export interface SingleResult {
	/** The agent's output text. */
	output: string;
	/** Usage stats (if the agent completed). */
	usage?: UsageStats;
	/** Error message (if the agent failed). */
	error?: string;
	/** Detailed execution info. */
	details?: SubagentDetails;
	/** All messages emitted by the subagent. */
	messages: Message[];
}

/**
 * Tracks a currently running agent for widget display.
 *
 * This is a lightweight snapshot used by the live widget to render
 * real-time status without exposing full message history.
 */
export interface RunningAgent {
	/** Agent name. */
	name: string;
	/** Agent type. */
	type: string;
	/** The task text. */
	task: string;
	/** Start time (epoch milliseconds). */
	startTime: number;
	/** Number of turns completed. */
	turnCount: number;
	/** Number of tool invocations. */
	toolUseCount: number;
	/** Total tokens used. */
	tokenCount: number;
	/** Percentage of context window used (0-100). */
	contextPercent: number;
	/** Short human-readable activity description. */
	currentActivity: string;
}
