import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildChatTurns, getPromptPreview, isTurnAnchor } = await jiti.import("./chat-turns.ts");

function user(text) {
  return { role: "user", content: text };
}

function assistant(...blocks) {
  return { role: "assistant", content: blocks, model: "m", provider: "p" };
}

function text(value) {
  return { type: "text", text: value };
}

function toolCall(name) {
  return { type: "toolCall", toolCallId: name, toolName: name, input: {} };
}

test("a user prompt anchors a turn and the turn ends at the next prompt", () => {
  const turns = buildChatTurns([
    user("first"),
    assistant(text("working"), toolCall("read")),
    assistant(text("done")),
    user("second"),
    assistant(text("ok")),
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].index, 0);
  assert.equal(turns[0].anchorIndex, 0);
  assert.equal(turns[0].endIndex, 3);
  assert.equal(turns[1].index, 1);
  assert.equal(turns[1].anchorIndex, 3);
  assert.equal(turns[1].endIndex, 5);
});

test("a compaction summary anchors a turn like a prompt does", () => {
  const turns = buildChatTurns([
    { role: "custom", customType: "compaction", content: "summary", display: true },
    assistant(text("after compaction")),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].anchorIndex, 0);
  assert.equal(getPromptPreview(turns[0].prompt), "summary");
});

test("messages before the first prompt belong to no turn", () => {
  const turns = buildChatTurns([
    assistant(text("orphan")),
    user("first"),
    assistant(text("done")),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].anchorIndex, 1);
  assert.equal(turns[0].index, 0);
});

test("tool calls are counted across the whole turn", () => {
  const turns = buildChatTurns([
    user("go"),
    assistant(text("checking"), toolCall("read"), toolCall("grep")),
    assistant(toolCall("bash")),
  ]);

  assert.equal(turns[0].toolCount, 3);
});

test("the turn's answer is the last message that says something", () => {
  // omp stores an assistant's text before the tool calls it announces, so a
  // turn usually ends on a tool call rather than on an answer.
  const turns = buildChatTurns([
    user("go"),
    assistant(text("I will check the file."), toolCall("read")),
    assistant(toolCall("grep")),
  ]);

  assert.equal(turns[0].answerIndex, 1);
  assert.equal(turns[0].answerMarkdown, "I will check the file.");
});

test("a turn that ends on a text-only message uses that message", () => {
  const turns = buildChatTurns([
    user("go"),
    assistant(text("Working."), toolCall("read")),
    assistant(text("All done.")),
  ]);

  assert.equal(turns[0].answerIndex, 2);
  assert.equal(turns[0].answerMarkdown, "All done.");
});

test("a turn without any spoken answer has none", () => {
  const turns = buildChatTurns([
    user("go"),
    assistant(toolCall("read")),
  ]);

  assert.equal(turns[0].answerIndex, -1);
  assert.equal(turns[0].answerMarkdown, "");
});

test("the prompt preview drops images and keeps the text", () => {
  const turns = buildChatTurns([
    { role: "user", content: [{ type: "image", source: { type: "url", url: "x" } }, text("look at this")] },
    assistant(text("ok")),
  ]);

  assert.equal(getPromptPreview(turns[0].prompt), "look at this");
});

test("a custom message that is not a compaction does not anchor a turn", () => {
  assert.equal(isTurnAnchor({ role: "custom", customType: "command", content: "x", display: true }), false);
  assert.equal(isTurnAnchor({ role: "custom", customType: "compaction", content: "x", display: true }), true);
  assert.equal(isTurnAnchor(user("x")), true);
});
