/**
 * Placeholder assistant reply used until a real model endpoint is wired up.
 * Keeps the chat UX functional without external API keys.
 */
export function generateReply(userMessage: string): string {
  const q = userMessage.trim();
  if (!q) return "Say something and I'll do my best to help.";
  if (q.toLowerCase().startsWith("hello") || q.toLowerCase().startsWith("hi")) {
    return "Hello! How can I help you today?";
  }
  if (q.endsWith("?")) {
    return `Good question. Here's a quick take on "${q.replace(/\?$/, "")}": break it into smaller parts, gather the key facts, and compare your options. Want me to go deeper on any part?`;
  }
  return `Got it — I've noted: "${q.slice(0, 120)}${q.length > 120 ? "…" : ""}". This is a demo assistant, so I'm keeping responses simple for now.`;
}
