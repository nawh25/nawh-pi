/**
 * Council special handling for the nawh-subagents extension.
 *
 * The council agent uses a multi-LLM consensus pattern:
 *
 * 1. Each **councillor** is spawned as a separate `pi` subprocess in
 *    parallel, using its configured model and a role-specific system
 *    prompt derived from the councillor's `prompt` field.
 * 2. Partial failures are tolerated — if some councillors fail or are
 *    aborted, synthesis proceeds with the successful ones.
 * 3. A **synthesis** subprocess (using the council agent's model and
 *    the council.md system prompt) merges all councillor responses
 *    into a single unified answer.
 * 4. The final result includes the synthesis text (capped at 100 KB)
 *    plus per-councillor details and a council summary.
 */

import type {
	AgentDefinition,
	CouncillorConfig,
	Message,
	PantheonConfig,
	SingleResult,
	SubagentDetails,
	UsageStats,
} from "./types";

import {
	runSingleAgent,
	mapWithConcurrencyLimit,
	truncateParallelOutput,
} from "./runner";
import { resolveAgentConfig } from "./config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Output cap for council synthesis (100 KB — double the parallel 50 KB cap). */
export const COUNCIL_OUTPUT_CAP = 100 * 1024;

/** Read-only tools available to councillors and the synthesis step. */
const COUNCILLOR_TOOLS = ["read", "grep", "find", "ls"];

/** Fallback model for synthesis if the council agent has no model configured. */
const DEFAULT_SYNTHESIS_MODEL = "anthropic/claude-sonnet-4-20250514";

/** Snippet length for per-councillor output previews in the result. */
const COUNCILLOR_SNIPPET_LEN = 500;

// ---------------------------------------------------------------------------
// Types (internal)
// ---------------------------------------------------------------------------

/**
 * Result of a single councillor execution.
 */
interface CouncillorResult {
	/** Councillor display name. */
	name: string;
	/** Model used by this councillor. */
	model: string;
	/** Final output text (empty if failed). */
	output: string;
	/** Error message if the councillor failed or was aborted. */
	error?: string;
	/** Usage stats (present if the councillor produced any output). */
	usage?: UsageStats;
	/** All messages from the subprocess. */
	messages: Message[];
	/** Execution status. */
	status: "completed" | "failed" | "aborted";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a councillor's system prompt.
 *
 * The councillor is told it is participating in a council of AI advisors
 * and given its specific role/perspective from the `prompt` field. It is
 * instructed to stay read-only and provide independent analysis.
 */
function buildCouncillorPrompt(councillor: CouncillorConfig): string {
	const role = councillor.prompt?.trim();

	const lines: string[] = [
		`You are **${councillor.name}**, a councillor in a council of AI advisors.`,
	];

	if (role) {
		lines.push(``, `Your role and perspective: ${role}`);
	}

	lines.push(
		``,
		`You are answering a question as part of a multi-LLM council. Provide your`,
		`best independent analysis from your assigned perspective. Do not assume`,
		`what other councillors might say — give your own honest assessment.`,
		``,
		`**Stay read-only.** Never modify, create, or delete files. You may use`,
		`read, grep, find, and ls tools to inspect the codebase if needed.`,
		``,
		`Provide a clear, well-structured response to the question.`,
	);

	return lines.join("\n");
}

/**
 * Construct the synthesis input text from the original question and
 * all councillor responses.
 *
 * Format:
 * ```
 * ## Original Question
 * <task>
 *
 * ## Councillor Responses
 *
 * ### <name> (<model>)
 * <response>
 * ...
 * ```
 */
function buildSynthesisInput(
	task: string,
	results: CouncillorResult[],
): string {
	const lines: string[] = [];

	lines.push(`## Original Question`, task, ``);

	lines.push(`## Councillor Responses`, ``);

	for (const result of results) {
		lines.push(`### ${result.name} (${result.model})`);

		if (result.error) {
			lines.push(
				`*This councillor failed and did not produce a response.*`,
				`Error: ${result.error}`,
			);
		} else {
			lines.push(result.output || `(No output produced.)`);
		}

		lines.push(``);
	}

	return lines.join("\n").trimEnd();
}

/**
 * Build a synthetic AgentDefinition for a councillor.
 *
 * This definition is passed to `runSingleAgent` so it can resolve the
 * councillor's model, tools, and system prompt. The councillor uses
 * read-only tools and its configured model.
 */
function makeCouncillorAgentDef(
	councillor: CouncillorConfig,
	councilAgentDef: AgentDefinition,
): AgentDefinition {
	return {
		name: councillor.name,
		description: `Councillor: ${councillor.name}`,
		tools: COUNCILLOR_TOOLS,
		model: councillor.model,
		thinking: councillor.variant,
		isCouncil: false,
		locked: true, // prevent preset overrides — we set model explicitly
		systemPrompt: buildCouncillorPrompt(councillor),
		source: councilAgentDef.source,
	};
}

/**
 * Build a synthetic AgentDefinition for the synthesis step.
 *
 * This uses the council agent's system prompt (from council.md body)
 * and the council agent's resolved model. Read-only tools are enforced.
 */
function makeSynthesisAgentDef(
	councilAgentDef: AgentDefinition,
	pantheonConfig: PantheonConfig,
): AgentDefinition {
	const resolved = resolveAgentConfig(councilAgentDef, pantheonConfig);

	return {
		name: "council-synthesis",
		description: "Council Synthesizer",
		tools: COUNCILLOR_TOOLS,
		model: resolved.model || DEFAULT_SYNTHESIS_MODEL,
		thinking: resolved.thinking,
		isCouncil: true,
		locked: true,
		systemPrompt: councilAgentDef.systemPrompt,
		source: councilAgentDef.source,
	};
}

// ---------------------------------------------------------------------------
// Task 7.1 + 7.2 + 7.3 — runCouncil
// ---------------------------------------------------------------------------

/**
 * Execute the council multi-LLM consensus pattern.
 *
 * 1. Prepare each councillor's prompt (prepending the councillor's
 *    `prompt` field to the task if present).
 * 2. Spawn all councillor subprocesses in parallel with a concurrency
 *    limit, each using its configured model and read-only tools.
 * 3. Tolerate partial failures — proceed with successful councillors.
 * 4. Spawn a synthesis subprocess (using the council model and the
 *    council.md system prompt) to merge all responses.
 * 5. Return a {@link SingleResult} with the synthesis output (capped at
 *    100 KB) and per-councillor details.
 *
 * @param task - The original question posed to the council.
 * @param councilConfig - Array of resolved councillor configurations.
 * @param councilAgentDef - The council agent definition (from council.md).
 * @param cwd - Working directory for subprocess execution.
 * @param pantheonConfig - The loaded pantheon configuration (for model resolution).
 * @param signal - Optional AbortSignal for cancellation.
 * @param onUpdate - Callback invoked on each subprocess event for UI refresh.
 * @param makeDetails - Factory that returns the current SubagentDetails snapshot.
 * @returns A {@link SingleResult} with synthesis output and council details.
 */
export async function runCouncil(
	task: string,
	councilConfig: CouncillorConfig[],
	councilAgentDef: AgentDefinition,
	cwd: string,
	pantheonConfig: PantheonConfig,
	signal: AbortSignal | undefined,
	onUpdate: () => void,
	makeDetails: () => SubagentDetails,
): Promise<SingleResult> {
	// --- Task 7.1: Prepare councillor prompts --------------------------------

	/**
	 * For each councillor, prepare the task text. If the councillor has a
	 * `prompt` field, it is prepended to the task to give the councillor
	 * its role/perspective context.
	 */
	const preparedCouncillors = councilConfig.map((councillor) => {
		const preparedTask = councillor.prompt
			? `${councillor.prompt}\n\n${task}`
			: task;

		return {
			councillor,
			preparedTask,
			agentDef: makeCouncillorAgentDef(councillor, councilAgentDef),
		};
	});

	// --- Task 7.2: Spawn councillor subprocesses in parallel ----------------

	const concurrency = Math.min(
		pantheonConfig.maxConcurrency || 4,
		preparedCouncillors.length,
	);

	const councillorResults = await mapWithConcurrencyLimit(
		preparedCouncillors,
		concurrency,
		async (item) => {
			const { councillor, preparedTask, agentDef } = item;

			// Each councillor gets its own details snapshot factory
			const councillorDetails: SubagentDetails = {
				name: councillor.name,
				type: `councillor/${councillor.name}`,
				task: preparedTask,
				status: "running",
				turnCount: 0,
				toolUseCount: 0,
				tokenCount: 0,
				contextPercent: 0,
				elapsedMs: 0,
				currentActivity: "starting…",
				messages: [],
			};

			const startTime = Date.now();

			const councillorMakeDetails = (): SubagentDetails => ({
				...councillorDetails,
				elapsedMs: Date.now() - startTime,
			});

			const councillorOnUpdate = (): void => {
				const d = councillorMakeDetails();
				councillorDetails.currentActivity = d.currentActivity;
				councillorDetails.toolUseCount = d.toolUseCount;
				councillorDetails.tokenCount = d.tokenCount;
				onUpdate();
			};

			const result = await runSingleAgent(
				cwd,
				[agentDef],
				councillor.name,
				preparedTask,
				undefined, // cwd override — use default
				undefined, // step label
				signal,
				councillorOnUpdate,
				councillorMakeDetails,
			);

			// Determine councillor status
			let status: CouncillorResult["status"] = "completed";
			if (result.error) {
				status = result.error.includes("aborted") ? "aborted" : "failed";
			}

			const councillorResult: CouncillorResult = {
				name: councillor.name,
				model: councillor.model,
				output: result.output,
				error: result.error,
				usage: result.usage,
				messages: result.messages,
				status,
			};

			return councillorResult;
		},
	);

	// --- Task 7.3: Partial failure handling ----------------------------------

	const successful = councillorResults.filter((r) => r.status === "completed");
	const failed = councillorResults.filter((r) => r.status !== "completed");

	// If ALL councillors failed, return an error result
	if (successful.length === 0) {
		const details = makeDetails();
		details.status = "failed";
		details.messages = [];
		details.currentActivity = "all councillors failed";

		const failureSummary = failed
			.map((r) => `- ${r.name} (${r.model}): ${r.error ?? "unknown error"}`)
			.join("\n");

		return {
			output: "",
			error: `All ${councillorResults.length} councillors failed:\n${failureSummary}`,
			details,
			messages: [],
		};
	}

	// --- Task 7.4: Synthesis step --------------------------------------------

	// Construct the synthesis input: original question + all councillor
	// responses labeled by name (including failed ones for context).
	const synthesisInput = buildSynthesisInput(task, councillorResults);

	// Build the synthesis agent definition (uses council model + council.md prompt)
	const synthesisAgentDef = makeSynthesisAgentDef(
		councilAgentDef,
		pantheonConfig,
	);

	// Synthesis subprocess details
	const synthesisDetails: SubagentDetails = {
		name: "council-synthesis",
		type: "council/synthesis",
		task: "Synthesize councillor responses",
		status: "running",
		turnCount: 0,
		toolUseCount: 0,
		tokenCount: 0,
		contextPercent: 0,
		elapsedMs: 0,
		currentActivity: "synthesizing…",
		messages: [],
	};

	const synthesisStartTime = Date.now();

	const synthesisMakeDetails = (): SubagentDetails => ({
		...synthesisDetails,
		elapsedMs: Date.now() - synthesisStartTime,
	});

	const synthesisOnUpdate = (): void => {
		const d = synthesisMakeDetails();
		synthesisDetails.currentActivity = d.currentActivity;
		synthesisDetails.toolUseCount = d.toolUseCount;
		synthesisDetails.tokenCount = d.tokenCount;
		onUpdate();
	};

	const synthesisResult = await runSingleAgent(
		cwd,
		[synthesisAgentDef],
		synthesisAgentDef.name,
		synthesisInput,
		undefined,
		undefined,
		signal,
		synthesisOnUpdate,
		synthesisMakeDetails,
	);

	// --- Task 7.5: Return synthesis result ----------------------------------

	// Cap synthesis output at 100 KB (double the standard 50 KB cap)
	const cappedOutput = truncateParallelOutput(
		synthesisResult.output,
		COUNCIL_OUTPUT_CAP,
	);

	// Build the final formatted output with synthesis + councillor details
	const formattedOutput = formatCouncilResult(cappedOutput, councillorResults);

	// Build details for the returned SingleResult
	const details = makeDetails();
	details.status = synthesisResult.error ? "failed" : "completed";
	details.output = formattedOutput;
	details.currentActivity = "council complete";
	details.messages = synthesisResult.messages;

	if (synthesisResult.usage) {
		details.usage = synthesisResult.usage;
		details.turnCount = synthesisResult.usage.turns;
		details.tokenCount = synthesisResult.usage.contextTokens;
	}

	return {
		output: formattedOutput,
		usage: synthesisResult.usage,
		error: synthesisResult.error,
		details,
		messages: synthesisResult.messages,
	};
}

// ---------------------------------------------------------------------------
// formatCouncilResult
// ---------------------------------------------------------------------------

/**
 * Format the final council output with synthesis, per-councillor details,
 * and a council summary.
 *
 * Produces:
 * ```
 * ## Council Response
 * <synthesis>
 *
 * ## Councillor Details
 * ### <name> (<model>)
 * Status: <completed/failed>
 * <output snippet or error>
 *
 * ## Council Summary
 * Consensus: <strong/weak/no consensus>
 * <participated> participated, <failed> failed
 * ```
 *
 * @param synthesis - The synthesis output text (already capped).
 * @param councillors - Array of councillor results.
 * @returns Formatted string with all sections.
 */
export function formatCouncilResult(
	synthesis: string,
	councillors: Array<{
		name: string;
		model: string;
		output: string;
		error?: string;
		usage?: UsageStats;
	}>,
): string {
	const lines: string[] = [];

	// --- Council Response ---
	lines.push(
		`## Council Response`,
		synthesis.trim() || "(No synthesis produced.)",
		``,
	);

	// --- Councillor Details ---
	lines.push(`## Councillor Details`, ``);

	for (const c of councillors) {
		lines.push(`### ${c.name} (${c.model})`);

		if (c.error) {
			lines.push(`Status: failed`);
			lines.push(`Error: ${c.error}`);
		} else {
			lines.push(`Status: completed`);

			// Include a snippet of the councillor's output
			const snippet =
				c.output.length > COUNCILLOR_SNIPPET_LEN
					? `${c.output.slice(0, COUNCILLOR_SNIPPET_LEN)}…`
					: c.output;

			if (snippet.trim()) {
				lines.push(`Output: ${snippet}`);
			}

			// Include usage stats if available
			if (c.usage) {
				lines.push(
					`Usage: ${c.usage.turns} turns, ${c.usage.inputTokens} in / ${c.usage.outputTokens} out tokens, $${c.usage.cost.toFixed(4)}`,
				);
			}
		}

		lines.push(``);
	}

	// --- Council Summary ---
	const total = councillors.length;
	const failedCount = councillors.filter((c) => c.error).length;
	const succeededCount = total - failedCount;

	// Infer consensus level from the synthesis text
	const consensus = inferConsensus(synthesis);

	lines.push(`## Council Summary`, ``);
	lines.push(`Consensus: ${consensus}`);
	lines.push(`${succeededCount} participated, ${failedCount} failed`);

	if (failedCount > 0 && succeededCount > 0) {
		lines.push(
			`(Synthesis based on ${succeededCount} of ${total} councillors — ${failedCount} failed)`,
		);
	}

	return lines.join("\n").trimEnd();
}

/**
 * Infer the consensus level from the synthesis text.
 *
 * Looks for consensus keywords in the synthesis output to classify the
 * result as "strong", "weak", or "no consensus".
 */
function inferConsensus(synthesis: string): string {
	const lower = synthesis.toLowerCase();

	// Check for explicit consensus statements in the synthesis
	if (lower.includes("no consensus") || lower.includes("none")) {
		return "no consensus";
	}

	if (lower.includes("weak consensus") || lower.includes("weak")) {
		return "weak consensus";
	}

	if (
		lower.includes("strong consensus") ||
		lower.includes("strong") ||
		lower.includes("unanimous")
	) {
		return "strong consensus";
	}

	// Default: if no explicit mention, report based on whether disagreements exist
	if (lower.includes("disagree") || lower.includes("diverg")) {
		return "weak consensus";
	}

	return "strong consensus";
}
