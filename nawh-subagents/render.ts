/**
 * Rendering module for the nawh-subagents extension.
 *
 * This module handles all display formatting for subagent tool calls and
 * results: token counts, usage statistics, tool call formatting, display
 * item extraction, and collapsed/expanded rendering views. It also
 * provides output truncation for parallel and council execution modes.
 */

import type { Message, UsageStats, SingleResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single display item extracted from assistant messages for the collapsed
 * view. Each item is either a text snippet or a formatted tool call.
 */
export interface DisplayItem {
	/** Whether this item is text or a tool call. */
	type: "text" | "toolCall";
	/** Text content (for text items) or formatted tool call string. */
	content: string;
	/** Tool name (only for `type: "toolCall"`). */
	toolName?: string;
	/** Tool arguments (only for `type: "toolCall"`). */
	toolArgs?: any;
}

/**
 * Arguments passed to the `subagent` tool. Only one of the three execution
 * mode fields is populated: `agent`/`task` for single, `tasks` for parallel,
 * `chain` for sequential chain.
 */
export interface SubagentToolArgs {
	/** Single-agent mode: the agent name to invoke. */
	agent?: string;
	/** Single-agent mode: the task text. */
	task?: string;
	/** Parallel mode: array of agent/task pairs. */
	tasks?: Array<{ agent: string; task: string }>;
	/** Chain mode: ordered steps; each step's `{previous}` is substituted. */
	chain?: Array<{ agent: string; task: string }>;
	/** Agent discovery scope override. */
	agentScope?: "user" | "project" | "both";
	/** Whether to confirm before running project-level agents. */
	confirmProjectAgents?: boolean;
	/** Working directory override for the subagent. */
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default output cap for parallel mode (50 KB). */
const DEFAULT_PARALLEL_CAP = 50 * 1024;

/** Output cap for council mode (100 KB). */
const COUNCIL_CAP = 100 * 1024;

/** Maximum line/command length before truncation (characters). */
const MAX_TOOL_CALL_LEN = 60;

/** Maximum number of display items shown in the collapsed view. */
const MAX_COLLAPSED_ITEMS = 8;

/** Maximum length of a task preview in `renderCall`. */
const MAX_TASK_PREVIEW_LEN = 80;

/** Maximum length of the model name in usage stats. */
const MAX_MODEL_LEN = 30;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Shorten a filesystem path by replacing the user's home directory with `~`.
 */
function shortenHome(p: string): string {
	const home = process.env.HOME ?? "";
	if (home && p.startsWith(home)) {
		return "~" + p.slice(home.length);
	}
	return p;
}

/**
 * Truncate a string to `maxLen` characters, appending "..." if truncated.
 */
function truncateStr(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 3) + "...";
}

/**
 * Shorten a model name for display. Strips common provider prefixes
 * (e.g. "anthropic/", "openai/") and truncates to {@link MAX_MODEL_LEN}.
 */
function shortModelName(model: string): string {
	let m = model;
	const slashIdx = m.indexOf("/");
	if (slashIdx >= 0) {
		m = m.slice(slashIdx + 1);
	}
	return truncateStr(m, MAX_MODEL_LEN);
}

/**
 * Extract the line count from a write tool's content argument.
 */
function writeLineCount(args: any): number {
	if (!args) return 0;
	const content = args.content ?? args.text ?? args.data;
	if (typeof content === "string") {
		return content.split("\n").length;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Task 9.1 — formatTokens
// ---------------------------------------------------------------------------

/**
 * Format a token count for compact display.
 *
 * - 0–999: shown as-is (e.g. `"500"`)
 * - 1,000–999,999: shown as `"X.Xk"` (e.g. `1200` → `"1.2k"`,
 *   `12000` → `"12k"`)
 * - 1,000,000+: shown as `"X.XM"` (e.g. `1500000` → `"1.5M"`)
 *
 * @param count - The raw token count.
 * @returns A compact human-readable string.
 */
export function formatTokens(count: number): string {
	if (count < 1000) {
		return String(count);
	}
	if (count < 1_000_000) {
		const k = count / 1000;
		// Show one decimal place when < 10k, otherwise drop decimals
		if (k < 10) {
			return `${k.toFixed(1).replace(/\.0$/, "")}k`;
		}
		return `${Math.round(k)}k`;
	}
	const m = count / 1_000_000;
	if (m < 10) {
		return `${m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	return `${Math.round(m)}M`;
}

// ---------------------------------------------------------------------------
// Task 9.2 — formatUsageStats
// ---------------------------------------------------------------------------

/**
 * Format usage statistics into a compact single-line string.
 *
 * Example output:
 * ```
 * 3 turns ↑12k ↓5k R8k W3k $0.03 ctx:20k claude-haiku-4-5
 * ```
 *
 * All token counts are formatted via {@link formatTokens}. Fields with a
 * value of 0 are still shown (e.g. `"R0"`).
 *
 * @param usage - The usage stats object.
 * @param model - The model name to append (shortened).
 * @returns A single-line usage summary string.
 */
export function formatUsageStats(usage: UsageStats, model: string): string {
	const turns = `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`;
	const input = `↑${formatTokens(usage.inputTokens)}`;
	const output = `↓${formatTokens(usage.outputTokens)}`;
	const cacheRead = `R${formatTokens(usage.cacheReadTokens)}`;
	const cacheWrite = `W${formatTokens(usage.cacheWriteTokens)}`;
	const cost = `$${usage.cost.toFixed(2)}`;
	const ctx = `ctx:${formatTokens(usage.contextTokens)}`;
	const modelName = shortModelName(model);

	return `${turns} ${input} ${output} ${cacheRead} ${cacheWrite} ${cost} ${ctx} ${modelName}`;
}

// ---------------------------------------------------------------------------
// Task 9.3 — formatToolCall
// ---------------------------------------------------------------------------

/**
 * Format a tool call in pi's compact, human-readable style.
 *
 * Supported tool formats:
 * - `bash`  → `$ <command>` (truncated to 60 chars)
 * - `read`  → `read ~/path:offset-limit` (if offset/limit provided)
 * - `write` → `write ~/path (N lines)` (line count from content)
 * - `edit`  → `edit ~/path` (just the path)
 * - `grep`  → `grep /pattern/ in ~/path`
 * - `find`  → `find ~/path -name "*.ts"` (or pattern if provided)
 * - `ls`    → `ls ~/path`
 * - default → `toolName { ...JSON... }` (truncated to 60 chars)
 *
 * All filesystem paths have the home directory replaced with `~`.
 *
 * @param toolName - The name of the tool (e.g. "bash", "read").
 * @param args - The tool arguments object.
 * @param themeFg - Optional theme foreground color (currently unused but
 *   reserved for future ANSI color support).
 * @returns A compact formatted string representing the tool call.
 */
export function formatToolCall(
	toolName: string,
	args: any,
	themeFg?: string,
): string {
	void themeFg; // reserved for future ANSI color support

	const a = args ?? {};

	switch (toolName) {
		case "bash":
		case "shell": {
			const cmd = a.command ?? a.cmd ?? "";
			return truncateStr(`$ ${cmd}`, MAX_TOOL_CALL_LEN);
		}

		case "read": {
			const p = shortenHome(a.path ?? a.file ?? "");
			let suffix = "";
			if (a.offset != null && a.limit != null) {
				const end = a.offset + a.limit - 1;
				suffix = `:${a.offset}-${end}`;
			} else if (a.offset != null) {
				suffix = `:${a.offset}`;
			} else if (a.line != null) {
				suffix = `:${a.line}`;
			}
			return `read ${p}${suffix}`;
		}

		case "write": {
			const p = shortenHome(a.path ?? a.file ?? "");
			const lines = writeLineCount(a);
			return `write ${p} (${lines} lines)`;
		}

		case "edit": {
			const p = shortenHome(a.path ?? a.file ?? "");
			return `edit ${p}`;
		}

		case "grep": {
			const pattern = a.pattern ?? a.query ?? "";
			const p = shortenHome(a.path ?? a.glob ?? a.dir ?? "");
			return `grep /${pattern}/ in ${p}`;
		}

		case "find": {
			const p = shortenHome(a.path ?? a.dir ?? "");
			const pattern = a.pattern ?? a.glob ?? a.name ?? "";
			if (pattern) {
				return `find ${p} -name "${pattern}"`;
			}
			return `find ${p}`;
		}

		case "ls": {
			const p = shortenHome(a.path ?? a.dir ?? "");
			return `ls ${p}`;
		}

		default: {
			let jsonStr: string;
			try {
				jsonStr = JSON.stringify(a);
			} catch {
				jsonStr = "[unserializable]";
			}
			return truncateStr(`${toolName} ${jsonStr}`, MAX_TOOL_CALL_LEN);
		}
	}
}

// ---------------------------------------------------------------------------
// Task 9.4 — getDisplayItems
// ---------------------------------------------------------------------------

/**
 * Extract display items from the subagent's message stream for the
 * collapsed view.
 *
 * Iterates over `messages` in order, picking up:
 * - Assistant text messages (`type: "text"`) → `DisplayItem` of type `"text"`
 * - Tool call invocations (`type: "toolCall"`) → `DisplayItem` of type
 *   `"toolCall"` with the formatted call string
 *
 * Tool result messages are skipped (they are too verbose for the collapsed
 * view). The returned array preserves the original message order.
 *
 * @param messages - The message stream from the subagent.
 * @returns An ordered array of display items.
 */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];

	for (const msg of messages) {
		if (msg.type === "text" && msg.role === "assistant") {
			const text = (msg.content ?? "").trim();
			if (text.length === 0) continue;
			items.push({
				type: "text",
				content: text,
			});
		} else if (msg.type === "toolCall") {
			const formatted = formatToolCall(msg.toolName ?? "?", msg.toolArgs);
			items.push({
				type: "toolCall",
				content: formatted,
				toolName: msg.toolName,
				toolArgs: msg.toolArgs,
			});
		}
	}

	return items;
}

// ---------------------------------------------------------------------------
// Task 9.5 — renderCall
// ---------------------------------------------------------------------------

/**
 * Render the tool-call display shown *before* and during execution.
 *
 * - Single mode (`{ agent, task }`): `→ @explorer: "find auth files"`
 * - Parallel mode (`{ tasks: [...] }`): one line per task
 *   ```
 *   ↳ parallel (3 tasks):
 *     → @explorer: "find auth files"
 *     → @fixer: "implement login"
 *     → @oracle: "review approach"
 *   ```
 * - Chain mode (`{ chain: [...] }`): steps joined by `→`
 *   ```
 *   → @explorer: "find auth" → @oracle: "review {previous}"
 *   ```
 *
 * Task previews are truncated to {@link MAX_TASK_PREVIEW_LEN} characters.
 * Theme colors are applied to agent names if a `theme` object with a
 * `fg` or `dim` color function is provided; otherwise plain text is used.
 *
 * @param args - The tool arguments (single, parallel, or chain).
 * @param theme - Optional pi theme object (may contain color helpers).
 * @param context - Optional execution context (reserved for future use).
 * @returns A multi-line string representing the tool call display.
 */
export function renderCall(
	args: SubagentToolArgs,
	theme?: any,
	context?: any,
): string {
	void context; // reserved for future execution context
	const color = theme?.fg ?? theme?.dim;
	const colorize = (s: string): string =>
		typeof color === "function" ? color(s) : s;

	// --- Single mode -------------------------------------------------
	if (args.agent && args.task) {
		const taskPreview = truncateStr(args.task, MAX_TASK_PREVIEW_LEN);
		return `→ ${colorize(`@${args.agent}`)}: "${taskPreview}"`;
	}

	// --- Parallel mode ------------------------------------------------
	if (args.tasks && args.tasks.length > 0) {
		const lines: string[] = [];
		lines.push(`↳ parallel (${args.tasks.length} tasks):`);
		for (const t of args.tasks) {
			const taskPreview = truncateStr(t.task, MAX_TASK_PREVIEW_LEN);
			lines.push(`  → ${colorize(`@${t.agent}`)}: "${taskPreview}"`);
		}
		return lines.join("\n");
	}

	// --- Chain mode ---------------------------------------------------
	if (args.chain && args.chain.length > 0) {
		const parts = args.chain.map((step) => {
			const taskPreview = truncateStr(step.task, MAX_TASK_PREVIEW_LEN);
			return `${colorize(`@${step.agent}`)}: "${taskPreview}"`;
		});
		return `→ ${parts.join(" → ")}`;
	}

	// --- Fallback (no recognised mode) --------------------------------
	return "→ subagent (no task specified)";
}

// ---------------------------------------------------------------------------
// Task 9.6 — renderResult
// ---------------------------------------------------------------------------

/**
 * Determine the status icon from a result.
 *
 * - `✓` success (output present, no error)
 * - `✗` failure (error present)
 * - `⏳` still running (no output and no error)
 */
function statusIcon(result: SingleResult | undefined): string {
	if (!result) return "⏳";
	if (result.error) return "✗";
	if (result.output !== undefined) return "✓";
	return "⏳";
}

/**
 * Render the collapsed view of a subagent result.
 *
 * Shows:
 * 1. A status icon and agent name header line
 * 2. The last {@link MAX_COLLAPSED_ITEMS} display items (tool calls and
 *    text snippets), each indented by two spaces
 * 3. A single usage stats line
 */
function renderCollapsed(
	result: SingleResult,
	agentName: string,
	theme?: any,
): string {
	const icon = statusIcon(result);
	const color = theme?.fg ?? theme?.dim;
	const colorize = (s: string): string =>
		typeof color === "function" ? color(s) : s;

	const lines: string[] = [];
	lines.push(`${icon} ${colorize(agentName)}`);

	// Display items (tool calls and text)
	const items = getDisplayItems(result.messages);
	const recent = items.slice(-MAX_COLLAPSED_ITEMS);
	for (const item of recent) {
		if (item.type === "text") {
			// Indent and truncate text snippets
			lines.push(`  ${truncateStr(item.content, MAX_TOOL_CALL_LEN)}`);
		} else {
			lines.push(`  ${item.content}`);
		}
	}

	// Usage stats line
	if (result.usage) {
		const usageLine = formatUsageStats(result.usage, result.usage.model);
		lines.push(`  ${usageLine}`);
	} else if (result.error) {
		lines.push(`  error: ${truncateStr(result.error, MAX_TOOL_CALL_LEN)}`);
	}

	return lines.join("\n");
}

/**
 * Render the expanded view of a subagent result (shown via Ctrl+O).
 *
 * Shows:
 * 1. A header with status icon and agent name
 * 2. The full task text
 * 3. All tool calls with formatted arguments
 * 4. The final output rendered as Markdown (or error)
 * 5. For chain/parallel results, a per-task usage breakdown (if available)
 */
function renderExpanded(
	result: SingleResult,
	agentName: string,
	taskText: string,
	theme?: any,
	perTaskResults?: SingleResult[],
): string {
	const icon = statusIcon(result);
	const color = theme?.fg ?? theme?.dim;
	const colorize = (s: string): string =>
		typeof color === "function" ? color(s) : s;

	const lines: string[] = [];

	lines.push(`${icon} ${colorize(agentName)} (expanded)`);
	lines.push("");

	// Full task text
	lines.push(colorize("Task:"));
	lines.push(taskText);
	lines.push("");

	// All tool calls
	const items = getDisplayItems(result.messages);
	const toolCalls = items.filter((i) => i.type === "toolCall");
	if (toolCalls.length > 0) {
		lines.push(colorize("Tool calls:"));
		for (const tc of toolCalls) {
			lines.push(`  ${tc.content}`);
		}
		lines.push("");
	}

	// Final output as Markdown
	if (result.error) {
		lines.push(colorize("Error:"));
		lines.push(result.error);
	} else if (result.output) {
		lines.push(colorize("Output:"));
		lines.push(result.output);
	}
	lines.push("");

	// Per-task usage breakdown (for chain/parallel)
	if (perTaskResults && perTaskResults.length > 0) {
		lines.push(colorize("Per-task usage:"));
		for (let i = 0; i < perTaskResults.length; i++) {
			const r = perTaskResults[i];
			if (r?.usage) {
				lines.push(`  [${i + 1}] ${formatUsageStats(r.usage, r.usage.model)}`);
			} else if (r?.error) {
				lines.push(`  [${i + 1}] ✗ ${truncateStr(r.error, 60)}`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Render both collapsed and expanded views of a subagent tool result.
 *
 * The **collapsed** view is shown by default and contains:
 * - Status icon: `✓` (success), `✗` (failure), or `⏳` (running)
 * - Agent name
 * - Last 5–10 display items (tool calls and text)
 * - Usage stats on a single summary line
 *
 * The **expanded** view (toggled via Ctrl+O) contains:
 * - The full task text
 * - All tool calls with formatted arguments
 * - The final output rendered as Markdown
 * - Per-task usage breakdown for chain/parallel modes
 *
 * @param result - The single result (or a result-like object) to render.
 * @param theme - Optional pi theme object with color helpers.
 * @param context - Optional context containing agent name, task text, and
 *   per-task results for chain/parallel modes.
 *   Expected shape: `{ agentName?: string, task?: string, perTaskResults?: SingleResult[] }`
 * @returns An object with `collapsed` and `expanded` string views.
 */
export function renderResult(
	result: any,
	theme?: any,
	context?: any,
): { collapsed: string; expanded: string } {
	// Normalise the result — it may be a SingleResult or a higher-level
	// result object wrapping per-task results.
	const singleResult: SingleResult = {
		output: result?.output ?? "",
		usage: result?.usage,
		error: result?.error,
		details: result?.details,
		messages: result?.messages ?? [],
	};

	const agentName =
		context?.agentName ??
		result?.details?.name ??
		result?.agentName ??
		"subagent";

	const taskText = context?.task ?? result?.details?.task ?? "";

	// Per-task results for chain/parallel breakdown
	const perTaskResults: SingleResult[] | undefined =
		context?.perTaskResults ?? result?.perTaskResults;

	return {
		collapsed: renderCollapsed(singleResult, agentName, theme),
		expanded: renderExpanded(
			singleResult,
			agentName,
			taskText,
			theme,
			perTaskResults,
		),
	};
}

// ---------------------------------------------------------------------------
// Task 9.7 — truncateParallelOutput
// ---------------------------------------------------------------------------

/**
 * Truncate output to a byte limit, appending a truncation notice if cut.
 *
 * - If the output (in UTF-8 bytes) is within `cap`, it is returned as-is.
 * - If truncated, the output is cut to fit within `cap` bytes and a
 *   trailing notice is appended:
 *   ```
 *
 * [... output truncated at 50KB ...]
 *   ```
 *
 * @param output - The raw output string to potentially truncate.
 * @param cap - Maximum byte size (default: 50 KB for parallel mode).
 * @returns The original or truncated output string.
 */
export function truncateParallelOutput(
	output: string,
	cap: number = DEFAULT_PARALLEL_CAP,
): string {
	const byteLen = Buffer.byteLength(output, "utf-8");

	if (byteLen <= cap) {
		return output;
	}

	// Truncate by bytes, ensuring we don't split a multi-byte character.
	const notice = `\n\n[... output truncated at ${formatCapLabel(cap)} ...]`;

	// Reserve space for the notice
	const noticeBytes = Buffer.byteLength(notice, "utf-8");
	const availableBytes = cap - noticeBytes;

	// Slice the string to fit within availableBytes, rounding down to
	// the nearest complete UTF-8 character boundary.
	const buf = Buffer.alloc(availableBytes, 0, "utf-8");
	buf.write(output, 0, "utf-8");
	// Find the last valid UTF-8 character boundary
	let truncated = buf.toString("utf-8", 0, availableBytes);

	// Ensure no dangling replacement characters from a split codepoint
	const lastChar = truncated.charCodeAt(truncated.length - 1);
	if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
		// Trailing high surrogate — drop it
		truncated = truncated.slice(0, -1);
	}

	return truncated + notice;
}

/**
 * Format the cap value into a human-readable label (e.g. "50KB", "100KB").
 */
function formatCapLabel(cap: number): string {
	const kb = cap / 1024;
	if (Number.isInteger(kb)) {
		return `${kb}KB`;
	}
	return `${kb.toFixed(1)}KB`;
}

/**
 * The council output cap (100 KB), exported for convenience.
 */
export const COUNCIL_OUTPUT_CAP = COUNCIL_CAP;
