/**
 * Live widget rendering for the nawh-subagents extension.
 *
 * Provides real-time status updates for running subagents via
 * `ctx.ui.setWidget("subagents", lines)`. Each running agent is
 * displayed on a single line with type, task, turn/tool/token counts,
 * context utilization, elapsed time, and current activity.
 */

import type { RunningAgent, SubagentDetails } from "./types.js";

/**
 * Format a millisecond duration into a compact human-readable string.
 *
 * - < 1000 ms  → "0s"
 * - < 60 s     → "12s"
 * - < 60 m     → "1m23s"
 * - >= 60 m    → "5m"
 *
 * @param startTime Epoch millisecond timestamp when the agent started.
 * @returns Compact elapsed time string (e.g. "12s", "1m23s", "5m").
 */
export function formatElapsed(startTime: number): string {
	const elapsedMs = Date.now() - startTime;
	const totalSeconds = Math.floor(elapsedMs / 1000);

	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes < 60) {
		return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	}

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

/**
 * Format a raw token count into a compact human-readable string.
 *
 * - < 1000        → "823"
 * - < 1_000_000   → "1.2k", "50k"
 * - >= 1_000_000  → "1.5M"
 *
 * @param count Raw token count.
 * @returns Compact token count string.
 */
export function formatTokens(count: number): string {
	if (count < 1000) {
		return String(count);
	}

	if (count < 1_000_000) {
		// Format with up to 1 decimal place, dropping trailing ".0"
		const formatted = (count / 1000).toFixed(1);
		const trimmed = formatted.endsWith(".0")
			? formatted.slice(0, -2)
			: formatted;
		return `${trimmed}k`;
	}

	const formatted = (count / 1_000_000).toFixed(1);
	const trimmed = formatted.endsWith(".0") ? formatted.slice(0, -2) : formatted;
	return `${trimmed}M`;
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if shortened.
 *
 * @param text  The string to truncate.
 * @param maxLen Maximum character length (including ellipsis).
 * @returns Truncated string.
 */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.substring(0, maxLen - 3) + "...";
}

/**
 * Map an agent type to a spinner/status emoji.
 *
 * Different agent types get distinct icons for quick visual scanning.
 *
 * @param type Agent type (explorer, oracle, etc.).
 * @returns Emoji status indicator.
 */
function spinnerForType(type: string): string {
	switch (type) {
		case "explorer":
			return "🔍";
		case "oracle":
			return "🔮";
		case "librarian":
			return "📚";
		case "fixer":
			return "🔧";
		case "designer":
			return "🎨";
		case "council":
			return "🏛️";
		case "observer":
			return "👁️";
		default:
			return "🔄";
	}
}

/**
 * Render the live subagents widget.
 *
 * Formats each running agent into a single display line and passes the
 * array to `ctx.ui.setWidget("subagents", lines)`. When no agents are
 * running, the widget is cleared (empty array).
 *
 * Each line shows: spinner, agent type, truncated task, turn count,
 * tool use count, token count, context utilization %, elapsed time,
 * and current activity.
 *
 * @param ctx    Extension API context (must support `ctx.ui.setWidget`).
 * @param agents Currently running agents to display.
 */
export function updateWidget(ctx: any, agents: RunningAgent[]): void {
	if (!ctx?.ui?.setWidget) return;

	if (agents.length === 0) {
		ctx.ui.setWidget("subagents", []);
		return;
	}

	const lines = agents.map((agent) => {
		const spinner = spinnerForType(agent.type);
		const elapsed = formatElapsed(agent.startTime);
		const tokens = formatTokens(agent.tokenCount);
		const task = truncate(agent.task, 40);
		return `${spinner} ${agent.type} | "${task}" | ${agent.turnCount} turns, ${agent.toolUseCount} tools, ${tokens} tokens, ${agent.contextPercent}% ctx, ${elapsed} | ${agent.currentActivity}`;
	});

	ctx.ui.setWidget("subagents", lines);
}

/**
 * Create an `onUpdate` callback for a single running agent.
 *
 * The returned function is suitable for passing to `runSingleAgent` (or
 * similar runner). Each time the runner emits a {@link SubagentDetails}
 * update, the corresponding entry in the `runningAgents` array is
 * updated with the latest status, and the widget is refreshed.
 *
 * @param ctx          Extension API context.
 * @param runningAgents The shared array of running agents.
 * @param agentIndex   Index into `runningAgents` for this particular agent.
 * @returns Callback `(details: SubagentDetails) => void`.
 */
export function createWidgetUpdater(
	ctx: any,
	runningAgents: RunningAgent[],
	agentIndex: number,
): (details: SubagentDetails) => void {
	return (details: SubagentDetails): void => {
		// Guard against out-of-bounds index (e.g. agent was removed).
		if (agentIndex < 0 || agentIndex >= runningAgents.length) return;

		const slot = runningAgents[agentIndex];

		// Update the running agent snapshot with latest details.
		slot.name = details.name;
		slot.type = details.type;
		slot.task = details.task;
		slot.turnCount = details.turnCount;
		slot.toolUseCount = details.toolUseCount;
		slot.tokenCount = details.tokenCount;
		slot.contextPercent = details.contextPercent;
		slot.currentActivity = details.currentActivity;

		// If the agent has finished, remove it from the running list.
		if (
			details.status === "completed" ||
			details.status === "failed" ||
			details.status === "aborted"
		) {
			runningAgents.splice(agentIndex, 1);
		}

		updateWidget(ctx, runningAgents);
	};
}

/**
 * Clear the subagents widget.
 *
 * Removes all lines from the widget by setting an empty array.
 *
 * @param ctx Extension API context (must support `ctx.ui.setWidget`).
 */
export function clearWidget(ctx: any): void {
	if (!ctx?.ui?.setWidget) return;
	ctx.ui.setWidget("subagents", []);
}
