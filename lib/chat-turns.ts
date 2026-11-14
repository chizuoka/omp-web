import { useRef, type RefObject } from "react";
import type { AgentMessage, AssistantMessage, CustomMessage, TextContent, UserMessage } from "./types";
import { countToolCallBlocks, getDisplayableAssistantBlocks, splitFinalAssistantBlocks, type DisplayOptions } from "./message-display";

/**
 * One turn of the transcript: a user prompt (or a compaction summary that
 * replaced it) and everything the agent did in reply.
 */
export interface ChatTurn {
  /** Position of the turn in the transcript, counted from the first anchored turn. */
  index: number;
  /** Index of the anchoring message: the user prompt, or the compaction summary. */
  anchorIndex: number;
  /** Index just past the turn's last message. */
  endIndex: number;
  /** The prompt the turn answers. */
  prompt: UserMessage | CustomMessage;
  /** The assistant's concluding message, as the transcript shows it. */
  answerMarkdown: string;
  /** Index of the assistant message carrying that message, or -1 when the turn has none. */
  answerIndex: number;
  /** Tool calls issued anywhere in the turn. */
  toolCount: number;
}

/**
 * A turn starts at a user prompt. Compaction replaces the prompt with a
 * summary, so a summary anchors a turn as well: without it every message
 * after a compaction would stand alone.
 */
export function isTurnAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

/** The prompt's text, without its images. */
export function getPromptPreview(message: UserMessage | CustomMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** The text an assistant message carries, whatever it is mixed with. */
function messageText(message: AssistantMessage): string {
  return (message.content ?? [])
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/**
 * The assistant message a turn ends on, the way the transcript renders it:
 * the last one that carries a final answer, else the last assistant message
 * of the turn.
 */
function findFinalAssistantIndex(
  messages: AgentMessage[],
  anchorIndex: number,
  endIndex: number,
  options: DisplayOptions,
): number {
  for (let index = endIndex - 1; index > anchorIndex; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage, options);
    const hasAnswer = answerBlocks.some((block) => (
      block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
    ));
    if (hasAnswer) return index;
  }
  for (let index = endIndex - 1; index > anchorIndex; index -= 1) {
    if (messages[index]?.role === "assistant") return index;
  }
  return -1;
}

/**
 * The turn's concluding message. omp stores an assistant's text *before* the
 * tool calls it announces, so most turns end on a tool call rather than on
 * an answer: the last message that says something is the one the reader
 * cares about, and it is what the minimap shows.
 */
function findAnswerIndex(
  messages: AgentMessage[],
  anchorIndex: number,
  endIndex: number,
  options: DisplayOptions,
): number {
  const finalIndex = findFinalAssistantIndex(messages, anchorIndex, endIndex, options);
  if (finalIndex !== -1 && messageText(messages[finalIndex] as AssistantMessage)) return finalIndex;
  for (let index = Math.min(finalIndex, endIndex - 1); index > anchorIndex; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (messageText(message as AssistantMessage)) return index;
  }
  return -1;
}

/** The answer's text, as the transcript renders it. */
export function getAnswerMarkdown(message: AssistantMessage, options: DisplayOptions = {}): string {
  const { answerBlocks } = splitFinalAssistantBlocks(message, options);
  const answerText = answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  return answerText || messageText(message);
}

/**
 * The transcript's turns, in order. Messages before the first anchor (a
 * session that starts mid-turn) belong to no turn and are skipped, which
 * keeps the turn numbers the transcript shows and the minimap lists in step.
 */
export function buildChatTurns(messages: AgentMessage[], options: DisplayOptions = {}): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let index = 0;
  let cursor = 0;
  while (cursor < messages.length) {
    if (!isTurnAnchor(messages[cursor])) {
      cursor += 1;
      continue;
    }
    const anchorIndex = cursor;
    let endIndex = anchorIndex + 1;
    while (endIndex < messages.length && !isTurnAnchor(messages[endIndex])) endIndex += 1;

    let toolCount = 0;
    for (let i = anchorIndex + 1; i < endIndex; i += 1) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      toolCount += countToolCallBlocks(getDisplayableAssistantBlocks(message as AssistantMessage, options));
    }

    const answerIndex = findAnswerIndex(messages, anchorIndex, endIndex, options);
    const answerMarkdown = answerIndex === -1
      ? ""
      : getAnswerMarkdown(messages[answerIndex] as AssistantMessage, options);

    turns.push({
      index,
      anchorIndex,
      endIndex,
      prompt: messages[anchorIndex] as UserMessage | CustomMessage,
      answerMarkdown,
      answerIndex,
      toolCount,
    });

    index += 1;
    cursor = endIndex;
  }
  return turns;
}

/**
 * A stable array of DOM node slots, one per turn. The transcript writes the
 * turn's prompt and answer into them; the minimap reads them to find where
 * each turn sits.
 */
export function useTurnRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, index) => refs.current[index] ?? null);
  return refs;
}
