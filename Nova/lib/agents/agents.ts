import { callAgent, type ChatMessage } from "./llm";
import { devinEnabled, runDevinOrRescue, type DevinOutcome } from "./devin";
import { generateFiles } from "./codegen";
import { withResearch } from "./outlook_llm";
import type { AgentId } from "./types";

// ---------------------------------------------------------------------------
// Agent runners — one system prompt + runner per specialist agent.
// Signature: (instruction, dependencyOutputs, brief) => Promise<string>
// ---------------------------------------------------------------------------

const ROLES: Record<Exclude<AgentId, "lead" | "author">, string> = {
  fast:
    "You are the Fast Response Agent: quick, accurate, concise. Answer the subtask " +
    "directly using the shared research and your knowledge. Never invent facts.",
  interviewer:
    "You are the Requirements Agent: turn instructions into structured functional and " +
    "technical requirements. Identify ambiguity, list decisions needed, keep it tight.",
  designer:
    "You are the Designer Agent: produce concrete plans and specs — user flows, layouts, " +
    "components, structure — that a developer can execute without guessing. Do not prescribe " +
    "specific UI widget types; if you do, screens with form controllers or loading state " +
    "must be StatefulWidget.",
  developer:
    "You are the Developer Agent: implement the instruction into working output — code, " +
    "config, steps — following any upstream specs exactly. Be concrete and correct. " +
    "Always return complete files, never partial snippets. Never ask the user for API keys " +
    "or credentials — use placeholder values (e.g. https://your-project.supabase.co, " +
    "your-anon-key) and note where real values go.",
};

export type AgentRunner = (
  instruction: string,
  dependencyOutputs: string,
  brief: string
) => Promise<string>;

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/**
 * Developer path. With Devin enabled: Devin first, Outlook+model rescue on failure
 * (outcome.rescued decides done vs rescued upstream; the rescue gets the original
 * goal so it stays on the required stack). Without Devin: the developer model
 * produces the work itself, one file per call for code deliverables.
 */
export async function runDeveloperSubtask(
  instruction: string,
  dependencyOutputs: string,
  brief: string,
  goal?: string
): Promise<DevinOutcome> {
  const prompt =
    `${brief ? `Shared web research:\n${brief}\n\n` : ""}` +
    `${dependencyOutputs ? `Upstream outputs:\n${dependencyOutputs}\n\n` : ""}` +
    `Your subtask:\n${instruction}`;

  if (devinEnabled()) return runDevinOrRescue(prompt, goal ?? instruction);

  const viaFiles = await generateFiles(prompt, ROLES.developer).catch(() => null);
  const text =
    viaFiles ??
    (await callAgent("developer", [
      { role: "system", content: ROLES.developer },
      { role: "user", content: prompt },
    ]));
  return { text, rescued: false, sources: [] };
}

const RULES =
  " Use only information in the goal and provided inputs — never refer to buckets, files, " +
  "earlier steps, logs, data or conversations that were not provided; if information is " +
  "missing, state a reasonable default and continue. You cannot run commands, start servers, " +
  "send requests, or access the user's systems — never claim you did; if the task needs that, " +
  "say it must be done by the user and give the exact commands or steps.";

export function agentRunner(agent: AgentId): AgentRunner {
  const role =
    (agent === "lead"
      ? "You are the Lead Agent: synthesize and deliver."
      : ROLES[agent as Exclude<AgentId, "lead" | "author">]) + RULES;
  return async (instruction, dependencyOutputs, brief) => {
    const messages: ChatMessage[] = [
      { role: "system", content: role },
      {
        role: "user",
        content:
          `${dependencyOutputs ? `Outputs from earlier subtasks:\n${dependencyOutputs}\n\n` : ""}` +
          `Your subtask:\n${instruction}`,
      },
    ];
    return callAgent(agent, withResearch(messages, brief));
  };
}
