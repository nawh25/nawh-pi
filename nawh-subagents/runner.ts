/**
 * Subagent execution core for the nawh-subagents extension.
 *
 * This module handles spawning `pi` subprocesses for each subagent,
 * parsing their JSON-mode stdout line by line, accumulating messages
 * and usage statistics, and supporting three execution modes:
 *
 * - **single**: one agent, one task
 * - **parallel**: multiple independent tasks with a concurrency limit
 * - **chain**: sequential steps where each step can reference the
 *   previous step's output via `{previous}`
 *
 * Abort propagation sends SIGTERM to the subprocess and SIGKILL after
 * a 5-second grace period.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
	AgentDefinition,
	AgentScope,
	Message,
	PantheonConfig,
	SingleResult,
	SubagentDetails,
	UsageStats,
} from "./types";

import { formatAgentList } from "./agents";
import { resolveAgentConfig } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by the subagent tool.
 */
export interface SubagentToolArgs {
	/** Single agent name for single-mode execution. */
	agent?: string;
	/** Single task text for single-mode execution. */
	task?: string;
	/** Parallel tasks array for parallel-mode execution. */
	tasks?: Array<{ agent: string; task: string; cwd?: string }>;
	/** Chain steps array for chain-mode execution. */
	chain?: Array<{ agent: string; task: string; cwd?: string }>;
	/** Which agent sources to discover (user / project / both). */
	agentScope?: AgentScope;
	/** Whether to confirm with the user before running project-level agents. */
	confirmProjectAgents?: boolean;
	/** Working directory override for single-mode execution. */
	cwd?: string;
}

/**
 * Result returned by the `execute()` function.
 */
export interface ToolResult {
	/** Main output text. */
	output: string;
	/** Per-subagent details (for UI rendering). */
	details?: SubagentDetails[];
	/** Error message (if execution failed). */
	error?: string;
}

/**
 * Options for {@link runSingleAgent}.
 *
 * Bundles the pantheon config, process registration callback, idle
 * timeout, and stderr cap so the signature stays manageable.
 */
export interface RunSingleAgentOptions {
	/** Loaded pantheon config (for preset resolution). */
	pantheonConfig: PantheonConfig;
	/** Optional callback to register/unregister the spawned child process. */
	registerProcess?: (child: ChildProcess) => () => void;
	/** Inactivity timeout in ms; 0 disables. */
	idleTimeoutMs?: number;
	/** Maximum accumulated stderr in bytes. */
	stderrCapBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of parallel tasks allowed. */
const MAX_PARALLEL_TASKS = 8;

/** Default concurrency for parallel execution. */
const DEFAULT_CONCURRENCY = 4;

/** Output cap per parallel task (50 KB). */
const PARALLEL_OUTPUT_CAP = 50 * 1024;

/** Grace period (ms) between SIGTERM and SIGKILL on abort. */
const ABORT_GRACE_PERIOD_MS = 5_000;

// ---------------------------------------------------------------------------
// Task 6.1 — getPiInvocation
// ---------------------------------------------------------------------------

/**
 * Resolve how to invoke `pi` for subprocess execution.
 *
 * If the extension is running under a bundled pi (detected via
 * `PI_SCRIPT_PATH` environment variable or a `process.execPath` that
 * looks like a pi binary), the function uses `process.execPath` plus
 * the script path. Otherwise it falls back to the bare `pi` command.
 *
 * The returned `args` array includes only the base flags — task-specific
 * flags (model, tools, system-prompt, task text) are appended by callers.
 *
 * @param args - Additional base arguments to append (e.g. `["--mode", "json"]`).
 * @returns An object with the `command` to execute and the `args` array.
 */
export function getPiInvocation(args: string[]): {
	command: string;
	args: string[];
} {
	const scriptPath = process.env.PI_SCRIPT_PATH;

	if (scriptPath) {
		// Running under a bundled pi — use the Node/bun executable + script
		return {
			command: process.execPath,
			args: [scriptPath, ...args],
		};
	}

	// Check if process.execPath itself looks like a pi binary
	const execName = path.basename(process.execPath).toLowerCase();
	if (execName === "pi" || execName === "pi.exe") {
		return {
			command: process.execPath,
			args: [...args],
		};
	}

	// Fallback: bare `pi` command (must be on PATH)
	return {
		command: "pi",
		args: [...args],
	};
}

// ---------------------------------------------------------------------------
// Task 6.2 — writePromptToTempFile
// ---------------------------------------------------------------------------

/**
 * Write an agent's system prompt to a temporary file for use with
 * `--append-system-prompt`.
 *
 * The file is created in the OS temp directory with a unique name
 * derived from the agent name. A cleanup function is returned that
 * deletes the temp file; it is safe to call multiple times.
 *
 * @param agentName - Name of the agent (used for the temp file name).
 * @param prompt - The system prompt content to write.
 * @returns An object with the file `path` and a `cleanup` function.
 */
export function writePromptToTempFile(
	agentName: string,
	prompt: string,
): { path: string; cleanup: () => void } {
	const tmpDir = os.tmpdir();
	const uniqueId = `${agentName}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const filePath = path.join(tmpDir, `nawh-subagent-${uniqueId}.txt`);

	try {
		fs.writeFileSync(filePath, prompt, "utf-8");
	} catch (err) {
		throw new Error(
			`Failed to write system prompt temp file for agent "${agentName}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		try {
			fs.unlinkSync(filePath);
		} catch {
			// Best-effort cleanup — ignore errors
		}
	};

	return { path: filePath, cleanup };
}

// ---------------------------------------------------------------------------
// Task 6.3 — runSingleAgent
// ---------------------------------------------------------------------------

/**
 * Extract text content from an assistant message in a `message_end` event.
 *
 * The `message.content` array may contain objects of type `text`,
 * `thinking`, or `toolCall`. We concatenate all `text` entries.
 */
function extractAssistantText(message: any): string {
	if (!message || !Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter(
			(block: any) => block.type === "text" && typeof block.text === "string",
		)
		.map((block: any) => block.text)
		.join("\n");
}

/**
 * Extract tool-call blocks from an assistant message.
 */
function extractToolCalls(message: any): Message[] {
	if (!message || !Array.isArray(message.content)) {
		return [];
	}
	return message.content
		.filter((block: any) => block.type === "toolCall")
		.map((block: any) => ({
			role: "assistant" as const,
			type: "toolCall" as const,
			toolName: block.name as string,
			toolArgs: block.arguments,
		}));
}

/**
 * Build a {@link UsageStats} object from a `message_end` event's usage data.
 */
function buildUsageStats(usage: any, model: string): UsageStats {
	return {
		turns: 1, // incremented by caller per message_end
		inputTokens: usage?.input ?? 0,
		outputTokens: usage?.output ?? 0,
		cacheReadTokens: usage?.cacheRead ?? 0,
		cacheWriteTokens: usage?.cacheWrite ?? 0,
		cost: usage?.cost?.total ?? 0,
		contextTokens: usage?.totalTokens ?? 0,
		model,
	};
}

/**
 * Merge a new usage event into an accumulator.
 */
function mergeUsageStats(
	acc: UsageStats | undefined,
	newStats: UsageStats,
): UsageStats {
	if (!acc) {
		return { ...newStats, turns: 1 };
	}
	return {
		turns: acc.turns + 1,
		inputTokens: acc.inputTokens + newStats.inputTokens,
		outputTokens: acc.outputTokens + newStats.outputTokens,
		cacheReadTokens: acc.cacheReadTokens + newStats.cacheReadTokens,
		cacheWriteTokens: acc.cacheWriteTokens + newStats.cacheWriteTokens,
		cost: acc.cost + newStats.cost,
		contextTokens: newStats.contextTokens || acc.contextTokens,
		model: newStats.model || acc.model,
	};
}

/**
 * Infer a short human-readable activity description from the latest messages.
 */
function inferActivity(messages: Message[]): string {
	const lastToolCall = [...messages]
		.reverse()
		.find((m) => m.type === "toolCall");
	if (lastToolCall?.toolName) {
		return `using ${lastToolCall.toolName}…`;
	}
	const lastText = [...messages].reverse().find((m) => m.type === "text");
	if (lastText?.content) {
		const snippet = lastText.content.slice(0, 60);
		return snippet.length < lastText.content.length ? `${snippet}…` : snippet;
	}
	return "working…";
}

/**
 * Core function for executing a single subagent.
 *
 * Resolves the agent config, writes its system prompt to a temp file,
 * spawns a `pi` subprocess in JSON mode, parses stdout line by line,
 * accumulates messages and usage statistics, and returns a
 * {@link SingleResult}.
 *
 * @param defaultCwd - Default working directory if `cwd` is not provided.
 * @param agents - Array of discovered agent definitions.
 * @param agentName - Name of the agent to run.
 * @param task - Task text to pass to the agent.
 * @param cwd - Optional working directory override.
 * @param step - Optional step label (for chain mode display).
 * @param signal - Optional AbortSignal for cancellation.
 * @param onUpdate - Callback invoked on each parsed event for UI refresh.
 * @param makeDetails - Factory that returns the current SubagentDetails snapshot.
 * @param options - Execution options (pantheon config, process registration, idle timeout, stderr cap).
 * @returns A {@link SingleResult} with output, usage, messages, and details.
 */
export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentDefinition[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: () => void,
	makeDetails: () => SubagentDetails,
	options: RunSingleAgentOptions,
): Promise<SingleResult> {
	// 1. Find the agent by name
	const agentDef = agents.find((a) => a.name === agentName);
	if (!agentDef) {
		return {
			output: "",
			error: `Unknown agent "${agentName}". Available agents:\n${formatAgentList(agents)}`,
			messages: [],
		};
	}

	// 2. Resolve the agent configuration (merge frontmatter with preset)
	const config = resolveAgentConfig(agentDef, options.pantheonConfig);

	// 3. Write system prompt to a temp file
	const tempFile = writePromptToTempFile(agentName, config.systemPrompt);

	// 4. Build the pi command
	const baseArgs = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		config.model,
		"--tools",
		config.tools.join(","),
		"--append-system-prompt",
		tempFile.path,
	];

	// Add thinking flag if configured
	if (config.thinking) {
		baseArgs.push("--thinking", config.thinking);
	}

	// Add the task text as the final argument
	const taskText = step ? `[${step}] Task: ${task}` : `Task: ${task}`;
	baseArgs.push(taskText);

	const invocation = getPiInvocation(baseArgs);

	// 5. Spawn the pi process
	const workingDir = cwd || defaultCwd;

	const child: ChildProcess = spawn(invocation.command, invocation.args, {
		cwd: workingDir,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});

	// Register the spawned process for lifecycle tracking
	const unregisterProcess = options.registerProcess?.(child);

	// 6. Set up accumulators
	const messages: Message[] = [];
	let usage: UsageStats | undefined;
	let lastAssistantText = "";
	let aborted = false;
	let timedOut = false;
	let stderrTruncated = false;
	let exitCode: number | null = null;

	// 7. Handle abort signal
	let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Kill the child process: SIGTERM → 5s grace → SIGKILL.
	 * Used by both the abort handler and the idle timeout.
	 */
	const killProcess = (): void => {
		if (!child.killed && child.pid) {
			child.kill("SIGTERM");
			sigkillTimer = setTimeout(() => {
				if (!child.killed && child.pid) {
					child.kill("SIGKILL");
				}
			}, ABORT_GRACE_PERIOD_MS);
		}
	};

	const onAbort = (): void => {
		aborted = true;
		killProcess();
	};

	if (signal) {
		if (signal.aborted) {
			// Already aborted before we started
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	// 7b. Idle timeout timer
	const idleTimeoutMs = options.idleTimeoutMs ?? 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const resetIdleTimer = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		if (idleTimeoutMs > 0 && !aborted && !timedOut) {
			idleTimer = setTimeout(() => {
				timedOut = true;
				killProcess();
			}, idleTimeoutMs);
		}
	};

	if (idleTimeoutMs > 0) {
		resetIdleTimer();
	}

	// 8. Parse stdout line by line as JSON
	let stdoutBuffer = "";

	child.stdout?.on("data", (chunk: Buffer) => {
		resetIdleTimer();
		stdoutBuffer += chunk.toString("utf-8");
		const lines = stdoutBuffer.split("\n");
		// Keep the last (possibly incomplete) line in the buffer
		stdoutBuffer = lines.pop() || "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === "") continue;

			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				// Not valid JSON — skip
				continue;
			}

			// Handle message_end events
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = extractAssistantText(event.message);
				if (text) {
					lastAssistantText = text;
					messages.push({ role: "assistant", type: "text", content: text });
				}

				// Extract tool calls from the same message
				const toolCalls = extractToolCalls(event.message);
				messages.push(...toolCalls);

				// Merge usage stats
				if (event.usage) {
					const newStats = buildUsageStats(event.usage, config.model);
					usage = mergeUsageStats(usage, newStats);
				}

				onUpdate();
			}

			// Handle tool_result_end events
			if (event.type === "tool_result_end") {
				const toolResultText =
					typeof event.result === "string"
						? event.result
						: JSON.stringify(event.result);
				messages.push({
					role: "tool",
					type: "toolResult",
					toolName: event.tool_name as string,
					toolResult: toolResultText,
				});
				onUpdate();
			}

			// Handle tool_call events (for real-time activity tracking)
			if (
				event.type === "tool_call" ||
				(event.type === "message_start" &&
					event.message?.content?.some?.((b: any) => b.type === "toolCall"))
			) {
				onUpdate();
			}
		}
	});

	// Capture stderr for error reporting
	let stderrText = "";
	const stderrCapBytes = options.stderrCapBytes ?? 65536;
	child.stderr?.on("data", (chunk: Buffer) => {
		resetIdleTimer();
		if (!stderrTruncated) {
			stderrText += chunk.toString("utf-8");
			if (Buffer.byteLength(stderrText) > stderrCapBytes) {
				stderrTruncated = true;
			}
		}
	});

	// 9. Wait for process to exit
	await new Promise<void>((resolve) => {
		child.on("close", (code: number | null) => {
			exitCode = code;
			unregisterProcess?.();
			resolve();
		});
		child.on("error", (err: Error) => {
			stderrText += `\nSpawn error: ${err.message}`;
			exitCode = -1;
			unregisterProcess?.();
			resolve();
		});
	});

	// Clean up abort listener, timers, and idle timer
	if (idleTimer) clearTimeout(idleTimer);
	if (signal) {
		signal.removeEventListener("abort", onAbort);
	}
	if (sigkillTimer) {
		clearTimeout(sigkillTimer);
	}

	// 10. Clean up temp file
	tempFile.cleanup();

	// 11. Build result
	const details = makeDetails();
	details.messages = messages;
	details.usage = usage;
	details.currentActivity = inferActivity(messages);
	details.toolUseCount = messages.filter((m) => m.type === "toolCall").length;
	details.tokenCount = usage?.contextTokens ?? 0;

	if (aborted) {
		details.status = "aborted";
		return {
			output: lastAssistantText,
			usage,
			error: "Subagent was aborted",
			details,
			messages,
		};
	}

	if (timedOut) {
		details.status = "failed";
		return {
			output: lastAssistantText,
			usage,
			error: `subagent timed out (idle for ${idleTimeoutMs}ms)`,
			details,
			messages,
		};
	}

	if (stderrTruncated) {
		stderrText += `... [stderr truncated at ${stderrCapBytes} bytes]`;
	}

	if (exitCode !== null && exitCode !== 0) {
		details.status = "failed";
		const errMsg =
			stderrText.trim() || `pi process exited with code ${exitCode}`;
		return {
			output: lastAssistantText,
			usage,
			error: errMsg,
			details,
			messages,
		};
	}

	details.status = "completed";
	details.output = lastAssistantText;
	return {
		output: lastAssistantText,
		usage,
		details,
		messages,
	};
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is permanent (should not be retried).
 *
 * Returns `true` for errors that indicate a fundamental problem with
 * the request or user cancellation — retrying would produce the same
 * result.
 */
export function isPermanentError(error: string): boolean {
	const lower = error.toLowerCase();
	return (
		lower.includes("unknown agent") ||
		lower.includes("invalid arguments") ||
		lower.includes("aborted") ||
		lower.includes("cancelled")
	);
}

/**
 * Wrap {@link runSingleAgent} with retry-with-exponential-backoff.
 *
 * Loops up to `maxRetries + 1` attempts. After each failed attempt that
 * is NOT classified as permanent by {@link isPermanentError}, the
 * function sleeps for `retryBackoffBaseMs * 2^(attempt-1)` milliseconds
 * before the next try. The sleep is abortable — if the signal fires
 * during the backoff, the loop exits immediately.
 *
 * @param maxRetries - Maximum number of retry attempts (0 = no retry).
 * @param retryBackoffBaseMs - Base delay for exponential backoff.
 * @returns The last {@link SingleResult} (success or final failure).
 */
export async function runSingleAgentWithRetry(
	defaultCwd: string,
	agents: AgentDefinition[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: () => void,
	makeDetails: () => SubagentDetails,
	options: RunSingleAgentOptions,
	maxRetries: number = 0,
	retryBackoffBaseMs: number = 2000,
): Promise<SingleResult> {
	let lastResult: SingleResult | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// Check if aborted before each attempt
		if (signal?.aborted) {
			return (
				lastResult ?? {
					output: "",
					error: "Subagent was aborted",
					messages: [],
				}
			);
		}

		lastResult = await runSingleAgent(
			defaultCwd,
			agents,
			agentName,
			task,
			cwd,
			step,
			signal,
			onUpdate,
			makeDetails,
			options,
		);

		// Success — return immediately
		if (!lastResult.error) return lastResult;

		// Permanent error — no retry
		if (isPermanentError(lastResult.error)) return lastResult;

		// Last attempt exhausted — return the failure
		if (attempt === maxRetries) return lastResult;

		// Sleep with exponential backoff (abortable)
		const sleepMs = retryBackoffBaseMs * 2 ** attempt;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, sleepMs);
			if (signal) {
				const onAbortSleep = (): void => {
					clearTimeout(timer);
					resolve();
				};
				signal.addEventListener("abort", onAbortSleep, { once: true });
			}
		});

		// Check abort after sleep
		if (signal?.aborted) {
			return lastResult;
		}
	}

	return lastResult!;
}

// ---------------------------------------------------------------------------
// Task 6.4 — mapWithConcurrencyLimit
// ---------------------------------------------------------------------------

/**
 * Run async mappings over an array with a concurrency limit.
 *
 * Up to `concurrency` tasks run simultaneously. As one completes, the
 * next pending item is started. Results are returned in the same order
 * as the input items. If an individual task throws, the error is
 * captured in the result array (as a rejected promise) rather than
 * failing the entire batch.
 *
 * @param items - Input items to map over.
 * @param concurrency - Maximum number of simultaneous tasks.
 * @param fn - Async function applied to each item.
 * @returns Array of results (or rejected promises) in input order.
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function runNext(): Promise<void> {
		while (nextIndex < items.length) {
			const myIndex = nextIndex++;
			try {
				results[myIndex] = await fn(items[myIndex], myIndex);
			} catch (err) {
				// Store error sentinel so other workers continue
				(results as any[])[myIndex] = { __retryError: err };
			}
		}
	}

	// Start up to `concurrency` workers
	const workers: Promise<void>[] = [];
	const workerCount = Math.min(concurrency, items.length);

	for (let i = 0; i < workerCount; i++) {
		workers.push(runNext());
	}

	await Promise.allSettled(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Task 6.7 — truncateParallelOutput
// ---------------------------------------------------------------------------

/**
 * Truncate an output string to a byte limit, appending a truncation notice.
 *
 * @param output - The output string to truncate.
 * @param cap - Maximum byte length (default 50 KB for parallel tasks).
 * @returns The truncated string with a notice if truncation occurred.
 */
export function truncateParallelOutput(
	output: string,
	cap: number = PARALLEL_OUTPUT_CAP,
): string {
	const bytes = Buffer.byteLength(output, "utf-8");
	if (bytes <= cap) {
		return output;
	}

	// Truncate at the character boundary that fits within the cap
	// (leaving room for the truncation notice)
	const notice = `\n... [output truncated: ${bytes} bytes > ${cap} byte cap]`;
	const noticeBytes = Buffer.byteLength(notice, "utf-8");
	const availableBytes = cap - noticeBytes;

	// Walk through the string to find a safe UTF-8 boundary
	let truncated = "";
	let currentBytes = 0;
	for (const char of output) {
		const charBytes = Buffer.byteLength(char, "utf-8");
		if (currentBytes + charBytes > availableBytes) break;
		truncated += char;
		currentBytes += charBytes;
	}

	return truncated + notice;
}

// ---------------------------------------------------------------------------
// Task 6.5, 6.6, 6.7 — execute()
// ---------------------------------------------------------------------------

/**
 * Main entry point for subagent execution.
 *
 * Dispatches to one of three modes based on the arguments:
 * - `tasks` → parallel mode (concurrent execution)
 * - `chain` → chain mode (sequential with `{previous}` substitution)
 * - `agent` + `task` → single mode (one agent)
 *
 * @param args - The parsed tool arguments.
 * @param ctx - The pi extension context (provides cwd, signal, etc.).
 * @param agents - Array of discovered agent definitions.
 * @param config - The loaded pantheon configuration.
 * @param signal - Optional abort signal (from ctx.signal or passed explicitly).
 * @returns A {@link ToolResult} with output and optional details.
 */
export async function execute(
	args: SubagentToolArgs,
	ctx: {
		cwd: string;
		signal: AbortSignal | undefined;
		ui?: { setWidget: (key: string, content: string[] | undefined) => void };
		registerProcess?: (child: ChildProcess) => () => void;
	},
	agents: AgentDefinition[],
	config: PantheonConfig,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const defaultCwd = ctx.cwd;

	// --- Parallel mode ----------------------------------------------------
	if (args.tasks && args.tasks.length > 0) {
		return executeParallel(args.tasks, defaultCwd, agents, config, signal, ctx);
	}

	// --- Chain mode -------------------------------------------------------
	if (args.chain && args.chain.length > 0) {
		return executeChain(args.chain, defaultCwd, agents, config, signal, ctx);
	}

	// --- Single mode ------------------------------------------------------
	if (args.agent && args.task !== undefined) {
		return executeSingle(
			args.agent,
			args.task,
			args.cwd,
			defaultCwd,
			agents,
			config,
			signal,
			ctx,
		);
	}

	// No valid mode
	return {
		output: "",
		error:
			"Invalid arguments: provide either { agent, task }, { tasks: [...] }, or { chain: [...] }",
	};
}

/**
 * Execute a single agent.
 */
async function executeSingle(
	agentName: string,
	task: string,
	cwd: string | undefined,
	defaultCwd: string,
	agents: AgentDefinition[],
	config: PantheonConfig,
	signal: AbortSignal | undefined,
	ctx: {
		ui?: { setWidget: (key: string, content: string[] | undefined) => void };
		registerProcess?: (child: ChildProcess) => () => void;
	},
): Promise<ToolResult> {
	const startTime = Date.now();
	let updateCounter = 0;

	// Mutable details object that makeDetails returns a snapshot of
	const detailsBase: SubagentDetails = {
		name: agentName,
		type: agentName,
		task,
		status: "running",
		turnCount: 0,
		toolUseCount: 0,
		tokenCount: 0,
		contextPercent: 0,
		elapsedMs: 0,
		currentActivity: "starting…",
		messages: [],
	};

	const makeDetails = (): SubagentDetails => {
		// Return a shallow copy with updated elapsed time
		return {
			...detailsBase,
			elapsedMs: Date.now() - startTime,
		};
	};

	const onUpdate = (): void => {
		updateCounter++;
		// Refresh the widget if available
		ctx.ui?.setWidget?.("subagents", [
			`${agentName}: ${makeDetails().currentActivity} (${updateCounter} updates)`,
		]);
	};

	const result = await runSingleAgentWithRetry(
		defaultCwd,
		agents,
		agentName,
		task,
		cwd,
		undefined,
		signal,
		onUpdate,
		makeDetails,
		{
			pantheonConfig: config,
			registerProcess: ctx.registerProcess,
			idleTimeoutMs: config.idleTimeoutMs,
			stderrCapBytes: config.stderrCapBytes,
		},
		config.maxRetries,
		config.retryBackoffBaseMs,
	);

	// Clear widget
	ctx.ui?.setWidget?.("subagents", undefined);

	const details = makeDetails();
	details.status = result.error ? "failed" : "completed";
	details.output = result.output;
	details.error = result.error;
	details.messages = result.messages;
	if (result.usage) {
		details.usage = result.usage;
		details.turnCount = result.usage.turns;
		details.tokenCount = result.usage.contextTokens;
	}

	if (result.error) {
		return {
			output: result.output || "",
			error: result.error,
			details: [details],
		};
	}

	return {
		output: result.output,
		details: [details],
	};
}

/**
 * Execute tasks in parallel with a concurrency limit.
 */
async function executeParallel(
	tasks: Array<{ agent: string; task: string; cwd?: string }>,
	defaultCwd: string,
	agents: AgentDefinition[],
	config: PantheonConfig,
	signal: AbortSignal | undefined,
	ctx: {
		ui?: { setWidget: (key: string, content: string[] | undefined) => void };
		registerProcess?: (child: ChildProcess) => () => void;
	},
): Promise<ToolResult> {
	// Validate max 8 tasks
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			output: "",
			error: `Too many parallel tasks: ${tasks.length} (max ${MAX_PARALLEL_TASKS}). Reduce the number of tasks.`,
		};
	}

	const concurrency = Math.min(
		config.maxConcurrency || DEFAULT_CONCURRENCY,
		tasks.length,
	);

	// Initialize placeholder details
	const allDetails: SubagentDetails[] = tasks.map((t) => ({
		name: t.agent,
		type: t.agent,
		task: t.task,
		status: "running",
		turnCount: 0,
		toolUseCount: 0,
		tokenCount: 0,
		contextPercent: 0,
		elapsedMs: 0,
		currentActivity: "queued…",
		messages: [],
	}));

	let completedCount = 0;
	let runningCount = 0;

	const updateWidget = (): void => {
		const runningAgents = allDetails.filter((d) => d.status === "running");
		const lines = [
			`Parallel: ${completedCount}/${tasks.length} done, ${runningAgents.length} running`,
			...allDetails
				.filter((d) => d.status === "running")
				.map((d) => `  ${d.name}: ${d.currentActivity}`),
		];
		ctx.ui?.setWidget?.("subagents", lines);
	};

	const results = await mapWithConcurrencyLimit(
		tasks,
		concurrency,
		async (taskItem, index) => {
			const startTime = Date.now();
			runningCount++;
			allDetails[index].status = "running";
			allDetails[index].currentActivity = "starting…";
			updateWidget();

			const makeDetails = (): SubagentDetails => {
				return {
					...allDetails[index],
					elapsedMs: Date.now() - startTime,
				};
			};

			const onUpdate = (): void => {
				const d = makeDetails();
				allDetails[index].currentActivity = d.currentActivity;
				allDetails[index].toolUseCount = d.toolUseCount;
				allDetails[index].tokenCount = d.tokenCount;
				updateWidget();
			};

			const result = await runSingleAgentWithRetry(
				defaultCwd,
				agents,
				taskItem.agent,
				taskItem.task,
				taskItem.cwd,
				undefined,
				signal,
				onUpdate,
				makeDetails,
				{
					pantheonConfig: config,
					registerProcess: ctx.registerProcess,
					idleTimeoutMs: config.idleTimeoutMs,
					stderrCapBytes: config.stderrCapBytes,
				},
				config.maxRetries,
				config.retryBackoffBaseMs,
			);

			runningCount--;
			completedCount++;

			const details = makeDetails();
			details.messages = result.messages;
			details.usage = result.usage;
			details.output = result.output;
			details.error = result.error;
			details.status = result.error ? "failed" : "completed";
			if (result.usage) {
				details.turnCount = result.usage.turns;
				details.tokenCount = result.usage.contextTokens;
			}
			allDetails[index] = details;

			updateWidget();
			return result;
		},
	);

	// Clear widget
	ctx.ui?.setWidget?.("subagents", undefined);

	// Check for error sentinels from mapWithConcurrencyLimit and convert
	for (let i = 0; i < results.length; i++) {
		const r = results[i] as any;
		if (r && typeof r === "object" && "__retryError" in r) {
			const err = r.__retryError;
			const errMsg = err instanceof Error ? err.message : String(err);
			allDetails[i].status = "failed";
			allDetails[i].error = errMsg;
			results[i] = {
				output: "",
				error: errMsg,
				messages: [],
			} as any;
		}
	}

	// Build output from results, capped at 50KB each
	const outputParts: string[] = [];
	const errors: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const taskItem = tasks[i];
		const header = `### Task ${i + 1}: ${taskItem.agent}`;

		if (result.error) {
			errors.push(`Task ${i + 1} (${taskItem.agent}): ${result.error}`);
			outputParts.push(`${header}\n**Error:** ${result.error}`);
		} else {
			const cappedOutput = truncateParallelOutput(
				result.output,
				PARALLEL_OUTPUT_CAP,
			);
			outputParts.push(`${header}\n${cappedOutput}`);
		}
	}

	const output = outputParts.join("\n\n");
	const error = errors.length > 0 ? errors.join("\n") : undefined;

	return {
		output,
		details: allDetails,
		error,
	};
}

/**
 * Execute chain steps sequentially, substituting `{previous}` with the
 * prior step's output.
 */
async function executeChain(
	chain: Array<{ agent: string; task: string; cwd?: string }>,
	defaultCwd: string,
	agents: AgentDefinition[],
	config: PantheonConfig,
	signal: AbortSignal | undefined,
	ctx: {
		ui?: { setWidget: (key: string, content: string[] | undefined) => void };
		registerProcess?: (child: ChildProcess) => () => void;
	},
): Promise<ToolResult> {
	const allDetails: SubagentDetails[] = [];
	const outputParts: string[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];

		// Substitute {previous} with the prior step's output
		let taskText = step.task;
		if (taskText.includes("{previous}") && i > 0) {
			taskText = taskText.replaceAll("{previous}", previousOutput);
		}

		const stepLabel = `Step ${i + 1}/${chain.length}`;
		const startTime = Date.now();

		const detailsBase: SubagentDetails = {
			name: step.agent,
			type: step.agent,
			task: taskText,
			status: "running",
			turnCount: 0,
			toolUseCount: 0,
			tokenCount: 0,
			contextPercent: 0,
			elapsedMs: 0,
			currentActivity: "starting…",
			messages: [],
		};

		const makeDetails = (): SubagentDetails => {
			return {
				...detailsBase,
				elapsedMs: Date.now() - startTime,
			};
		};

		const onUpdate = (): void => {
			const d = makeDetails();
			ctx.ui?.setWidget?.("subagents", [
				`Chain: ${stepLabel} — ${step.agent}: ${d.currentActivity}`,
			]);
		};

		const result = await runSingleAgentWithRetry(
			defaultCwd,
			agents,
			step.agent,
			taskText,
			step.cwd,
			stepLabel,
			signal,
			onUpdate,
			makeDetails,
			{
				pantheonConfig: config,
				registerProcess: ctx.registerProcess,
				idleTimeoutMs: config.idleTimeoutMs,
				stderrCapBytes: config.stderrCapBytes,
			},
			config.maxRetries,
			config.retryBackoffBaseMs,
		);

		const details = makeDetails();
		details.messages = result.messages;
		details.usage = result.usage;
		details.output = result.output;
		details.error = result.error;
		details.status = result.error ? "failed" : "completed";
		if (result.usage) {
			details.turnCount = result.usage.turns;
			details.tokenCount = result.usage.contextTokens;
		}
		allDetails.push(details);

		if (result.error) {
			// Stop on first failure
			ctx.ui?.setWidget?.("subagents", undefined);
			return {
				output: outputParts.join("\n\n"),
				details: allDetails,
				error: `${stepLabel} (${step.agent}) failed: ${result.error}`,
			};
		}

		previousOutput = result.output;
		outputParts.push(`### ${stepLabel}: ${step.agent}\n${result.output}`);
	}

	// Clear widget
	ctx.ui?.setWidget?.("subagents", undefined);

	return {
		output: outputParts.join("\n\n"),
		details: allDetails,
	};
}
