export function cleanTraeCliText(value) {
  return String(value || "")
    .replace(/<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi, "")
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, "")
    .trim();
}

export function buildTraeCliTurns(input = {}, state = {}) {
  return [
    { role: "user", content: cleanTraeCliText(input.prompt || state.pendingPrompt?.prompt) },
    { role: "assistant", content: cleanTraeCliText(input.last_assistant_message || input.text_content) },
  ].filter((turn) => turn.content);
}
