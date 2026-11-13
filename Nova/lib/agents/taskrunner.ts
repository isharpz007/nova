import { callAgent, callJson } from "./llm";
import { agentRunner, runDeveloperSubtask } from "./agents";
import { gatherSources, buildBrief, detectStack, type Source } from "./outlook_llm";
import { generateFiles } from "./codegen";
import { deliverResponse } from "./orchestrator";
import type { AgentId } from "./types";

// ---------------------------------------------------------------------------
// Multi-agent task orchestrator with Outlook research + rescue.
//   lead plans -> subtasks run in dependency order (parallel, cap 3)
//   -> failures rescued via Outlook + lead model -> lead merges, citing [n].
// ---------------------------------------------------------------------------

export type SubtaskStatus = "pending" | "running" | "done" | "rescued" | "failed";

export interface Subtask {
  id: string;
  agent: AgentId;
  instruction: string;
  dependsOn: string[];
  status: SubtaskStatus;
  output?: string;
  error?: string;
}

export interface TaskRun {
  id: string;
  goal: string;
  subtasks: Subtask[];
  brief: string;
  sources: Source[];
  final?: string;
  warnings: string[];
}

export type TaskEvent =
  | { type: "plan"; subtasks: Subtask[]; warnings: string[] }
  | { type: "subtask_started"; id: string }
  | { type: "subtask_done"; id: string }
  | { type: "subtask_rescued"; id: string; reason: string }
  | { type: "subtask_failed"; id: string; error: string }
  | { type: "author_started" }
  | { type: "author_done" }
  | { type: "delivered" }
  | { type: "final"; text: string; rescuedCount: number };

const AGENT_IDS: AgentId[] = ["lead", "fast", "interviewer", "designer", "developer"];
const MAX_SUBTASKS = 6;
const CONCURRENCY = 3;
const SUBTASK_TIMEOUT_MS = 5 * 60_000;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
  ]);

interface RawPlan {
  subtasks?: Array<{ id?: string; agent?: string; instruction?: string; dependsOn?: string[] | string }>;
}

interface PlanCheck {
  subs: Subtask[] | null;
  /** Why validation failed — fed back to the planner on retry. */
  reason: string;
}

/** Validate plan: <=6 subtasks, valid agents, deps exist, no cycles. Normalizes first. */
function validatePlan(plan: RawPlan, goal: string): PlanCheck {
  try {
    const raw = (plan.subtasks ?? []).slice(0, MAX_SUBTASKS);
    if (!raw.length) return { subs: null, reason: "empty subtask list" };

    const subs: Subtask[] = [];
    const ids = new Set<string>();
    for (const [i, s] of raw.entries()) {
      const id = s.id?.trim() || `S${i + 1}`;
      const agent = String(s.agent ?? "developer")
        .trim()
        .toLowerCase()
        .replace(/\s*agent$/, "") as AgentId;
      const dependsOn = Array.isArray(s.dependsOn)
        ? s.dependsOn
        : typeof s.dependsOn === "string"
          ? [s.dependsOn]
          : [];
      if (ids.has(id)) return { subs: null, reason: `duplicate subtask id '${id}'` };
      if (!AGENT_IDS.includes(agent)) return { subs: null, reason: `unknown agent '${s.agent}'` };
      ids.add(id);
      subs.push({
        id,
        agent,
        instruction: String(s.instruction ?? "").trim() || goal,
        dependsOn: dependsOn.filter((d) => typeof d === "string"),
        status: "pending",
      });
    }
    for (const s of subs) {
      s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id);
    }

    // Cycle check (DFS)
    const byId = new Map(subs.map((s) => [s.id, s]));
    const state = new Map<string, number>(); // 0=unvisited 1=visiting 2=done
    const visit = (id: string): boolean => {
      const st = state.get(id) ?? 0;
      if (st === 1) return false; // cycle
      if (st === 2) return true;
      state.set(id, 1);
      for (const d of byId.get(id)?.dependsOn ?? []) if (!visit(d)) return false;
      state.set(id, 2);
      return true;
    };
    for (const s of subs) {
      if (!visit(s.id)) return { subs: null, reason: `dependency cycle at '${s.id}'` };
    }
    return { subs, reason: "" };
  } catch (e) {
    return { subs: null, reason: e instanceof Error ? e.message : "plan validation error" };
  }
}

const fallbackPlan = (goal: string): Subtask[] => [
  {
    id: "S1",
    agent: "designer",
    instruction: `Produce a plan and spec for: ${goal}`,
    dependsOn: [],
    status: "pending",
  },
  { id: "S2", agent: "developer", instruction: goal, dependsOn: ["S1"], status: "pending" },
];

// A subtask "waiting" for the user is a stall — there is no user round-trip.
// Detect question-shaped outputs and have the lead resolve them with defaults.
const QUESTIONY =
  /(could you|can you|would you|please (provide|share|tell|clarify|let)|let me know|what (is|are|would)|which (one|option|platform|color|font)|do you (want|need|prefer|have|require))/i;

function looksLikeClarification(text: string): boolean {
  const head = text.slice(0, 1500);
  return QUESTIONY.test(head) && (head.match(/\?/g) ?? []).length >= 2;
}

async function resolveQuestions(st: Subtask, output: string, goal: string): Promise<string> {
  const resolved = await callAgent("lead", [
    {
      role: "system",
      content:
        "A subtask returned questions for the user instead of doing its work. The user cannot " +
        "answer mid-run — resolve every question with a sensible default and produce the actual " +
        "deliverable. State the defaults you chose briefly; do not ask the user anything.",
    },
    {
      role: "user",
      content: `Goal: ${goal}\n\nSubtask: ${st.instruction}\n\nQuestion-filled output:\n${output}`,
    },
  ]).catch(() => output);
  return resolved;
}

/** Outlook + lead model rescue for a failed subtask, pinned to the goal's stack. */
async function rescue(st: Subtask, brief: string, goal: string): Promise<string> {
  const stack = detectStack(`${goal} ${st.instruction}`);
  const query = [goal || st.instruction, ...stack].join(" ").slice(0, 380);
  const { sources } = await gatherSources(query, {
    agent: "fast",
    maxResults: 6,
    maxPages: 3,
    useLlmFilter: false,
  });
  const research = sources.length ? buildBrief(sources) : brief;

  const stackRule = stack.length
    ? ` Required stack: ${stack.join(", ")} — the output MUST use this stack; if the ` +
      `research suggests a different framework, ignore it and stay on this stack.`
    : "";
  const system =
    "A specialist agent failed its subtask. You are the rescue: complete the subtask " +
    "using the web research plus your own knowledge. Be concrete; cite sources as [n]; " +
    "use a source only if it is clearly about the task and ignore irrelevant sources. " +
    "Never pretend work was executed when it was only researched. You cannot run commands, " +
    "start servers, send requests, or access the user's systems — never claim you did; if the " +
    "task needs that, say it must be done by the user and give the exact commands or steps. " +
    "Use only the provided inputs; if information is missing, state a reasonable default and " +
    "continue." +
    stackRule;
  const user =
    `Original goal: ${goal}\n\nFailed ${st.agent} subtask:\n${st.instruction}\n\n` +
    `Research:\n${research || "(none available)"}`;

  // Rescued developer work still gets per-file generation + truncation retry.
  if (st.agent === "developer") {
    const viaFiles = await generateFiles(user, system).catch(() => null);
    if (viaFiles) return viaFiles;
  }
  return callAgent("lead", [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
}

const LEAD_PLAN_PROMPT = (goal: string, context = "") => [
  {
    role: "system" as const,
    content:
      "You are the Lead Agent planner. Break the user's goal into at most 6 subtasks for these " +
      "agents: fast (quick answers/research), interviewer (requirements), designer (plans/specs), " +
      "developer (implementation/code). Order dependencies via dependsOn (list of subtask ids). " +
      "Keep independent work parallel. The user cannot answer questions mid-run — every subtask " +
      "must produce output; never create a subtask that only asks the user for clarification, " +
      "use sensible defaults instead. Use only information in the user's goal and the provided " +
      "inputs — never refer to buckets, files, earlier steps, logs, data or conversations that " +
      "were not provided; if information is missing, state a reasonable default and continue. " +
      "You cannot run commands, start servers, send requests, or access the user's systems — " +
      "if the goal is mainly a request to execute or test something the system cannot do, " +
      "create a single subtask whose output is the instructions the user should follow. " +
      "Reply with a single JSON object only: " +
      '{"subtasks":[{"id":"S1","agent":"designer","instruction":"...","dependsOn":[]}]}',
  },
  { role: "user" as const, content: `${context}Goal: ${goal}` },
];

export interface RunTaskOptions {
  /** Prior conversation text — prepended to the planner and merge prompts. */
  context?: string;
}

export async function runTask(
  goal: string,
  onEvent: (e: TaskEvent) => void,
  opts: RunTaskOptions = {}
): Promise<TaskRun> {
  const contextBlock = opts.context ? `Conversation context:\n${opts.context}\n\n` : "";
  const run: TaskRun = {
    id: `task_${Date.now().toString(36)}`,
    goal,
    subtasks: [],
    brief: "",
    sources: [],
    warnings: [],
  };

  // 1. Plan + research in parallel.
  const [planResult, researchResult] = await Promise.all([
    callJson<RawPlan>("lead", LEAD_PLAN_PROMPT(goal, contextBlock)).catch((e) => {
      const msg = `Planning failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`;
      console.warn(`[planner] ${msg}`);
      run.warnings.push(msg);
      return null;
    }),
    gatherSources(goal, { agent: "fast", maxResults: 8, maxPages: 4 }).catch(() => ({
      sources: [] as Source[],
      warnings: ["research unavailable"],
    })),
  ]);
  run.sources = researchResult.sources;
  run.brief = buildBrief(researchResult.sources);
  run.warnings.push(...researchResult.warnings);

  let plan: Subtask[] | null = null;
  if (planResult) {
    let check = validatePlan(planResult, goal);
    if (!check.subs) {
      console.warn(`[planner] plan rejected (${check.reason}) — retrying once`);
      const retry = await callJson<RawPlan>("lead", [
        ...LEAD_PLAN_PROMPT(goal, contextBlock),
        { role: "assistant" as const, content: JSON.stringify(planResult).slice(0, 3000) },
        {
          role: "user" as const,
          content: `That plan was invalid: ${check.reason}. Fix it and reply with a single JSON object only.`,
        },
      ]).catch((e) => {
        console.warn(`[planner] retry call failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
        return null;
      });
      if (retry) {
        check = validatePlan(retry, goal);
        if (!check.subs) {
          console.warn(`[planner] retry plan rejected (${check.reason})`);
          run.warnings.push(`Plan invalid after retry: ${check.reason}`);
        }
      } else {
        run.warnings.push(`Plan invalid (${check.reason}); planner retry unavailable`);
      }
    }
    plan = check.subs;
  }

  run.subtasks = plan ?? fallbackPlan(goal);
  if (!plan) {
    console.warn("[planner] using fallback designer->developer plan");
    run.warnings.push("Planning used a fallback plan (designer -> developer)");
  }
  onEvent({ type: "plan", subtasks: run.subtasks, warnings: [...run.warnings] });

  // 2. Execute in dependency order, independent subtasks in parallel (cap 3).
  const byId = new Map(run.subtasks.map((s) => [s.id, s]));
  const outputs = new Map<string, string>();

  const depOutputs = (s: Subtask) =>
    s.dependsOn
      .map((d) => `--- ${d} output ---\n${outputs.get(d) ?? "(no output)"}`)
      .join("\n\n");

  const execOne = async (s: Subtask) => {
    s.status = "running";
    onEvent({ type: "subtask_started", id: s.id });
    try {
      if (s.agent === "developer") {
        const outcome = await withTimeout(
          runDeveloperSubtask(s.instruction, depOutputs(s), run.brief, run.goal),
          SUBTASK_TIMEOUT_MS,
          "developer subtask"
        );
        let text = outcome.text;
        if (looksLikeClarification(text)) text = await resolveQuestions(s, text, run.goal);
        s.output = text;
        outputs.set(s.id, text);
        if (outcome.rescued) {
          s.status = "rescued";
          onEvent({ type: "subtask_rescued", id: s.id, reason: outcome.reason ?? "Devin unavailable" });
        } else {
          s.status = "done";
          onEvent({ type: "subtask_done", id: s.id });
        }
        return;
      }
      let out = await withTimeout(
        agentRunner(s.agent)(s.instruction, depOutputs(s), run.brief),
        SUBTASK_TIMEOUT_MS,
        `${s.agent} subtask`
      );
      if (looksLikeClarification(out)) out = await resolveQuestions(s, out, run.goal);
      s.output = out;
      s.status = "done";
      outputs.set(s.id, out);
      onEvent({ type: "subtask_done", id: s.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "failed";
      // Rescue: Outlook + lead model.
      try {
        let out = await withTimeout(rescue(s, run.brief, run.goal), SUBTASK_TIMEOUT_MS, "rescue");
        if (looksLikeClarification(out)) out = await resolveQuestions(s, out, run.goal);
        s.output = out;
        s.status = "rescued";
        outputs.set(s.id, out);
        onEvent({ type: "subtask_rescued", id: s.id, reason: msg });
      } catch (rerr) {
        s.status = "failed";
        s.error = rerr instanceof Error ? `${msg}; rescue: ${rerr.message}` : msg;
        onEvent({ type: "subtask_failed", id: s.id, error: s.error });
      }
    }
  };

  const settled = new Set<SubtaskStatus>(["done", "rescued", "failed"]);
  const running = new Set<Promise<void>>();
  const pending = new Set(run.subtasks.map((s) => s.id));
  while (pending.size) {
    const ready = [...pending]
      .map((id) => byId.get(id)!)
      .filter((s) => s.dependsOn.every((d) => settled.has(byId.get(d)!.status)));

    for (const s of ready) {
      if (running.size >= CONCURRENCY) break;
      pending.delete(s.id);
      const p = execOne(s).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size) await Promise.race(running);
    else if (pending.size) break; // nothing runnable left
  }
  await Promise.all(running);

  // 3. Author writes the reply; the lead gates and delivers it unchanged.
  const rescued = run.subtasks.filter((s) => s.status === "rescued");
  onEvent({ type: "author_started" });
  const written = await deliverResponse({
    goal,
    history: opts.context,
    plan: run.subtasks.map((s) => ({
      id: s.id,
      agent: s.agent,
      instruction: s.instruction,
      dependsOn: s.dependsOn,
    })),
    subtasks: run.subtasks,
    sources: run.sources,
    warnings: run.warnings,
  });
  onEvent({ type: "author_done" });
  run.final = written.text;
  if (written.usedFallback) run.warnings.push("Author unavailable — deterministic reply used");

  onEvent({ type: "delivered" });
  onEvent({ type: "final", text: run.final, rescuedCount: rescued.length });
  return run;
}
