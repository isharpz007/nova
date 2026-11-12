import { callAgent, callJson } from "./llm";
import { devinEnabled, runDevinOrRescue } from "./devin";
import { generateFiles } from "./codegen";
import { fallbackResponse, writeResponse, type AuthorInput } from "./author";
import { needsResearch } from "./search";
import { buildBrief, gatherSources } from "./outlook_llm";
import { MessageBus } from "./bus";
import { TaskBoard } from "./board";
import type { AgentEmit, AgentId, RunResult, TaskStatus } from "./types";

const PERFORMANCE =
  "Core directives: respond quickly without sacrificing accuracy; never invent facts, sources or " +
  "claims; verify before asserting; distinguish facts from assumptions; if a request is ambiguous " +
  "ask one short clarifying question; keep answers short, direct and professional; never pretend " +
  "work is done when it is not; check calculations and names before returning them. Use only " +
  "information in the request and provided inputs — never refer to buckets, files, earlier " +
  "steps, logs, data or conversations that were not provided; if information is missing, state " +
  "a reasonable default and continue. You cannot run commands, start servers, send requests, or " +
  "access the user's systems — never claim you did; if the task needs that, say it must be done " +
  "by the user and give the exact commands or steps.";

const STYLE =
  "Response style: answer naturally like a human expert — match the shape of the request. " +
  "Greetings get a short conversational reply; simple questions get short direct answers; " +
  "explanations get clear useful detail; coding requests get the code plus a brief explanation; " +
  "complex projects get structured detail; follow-ups use conversation context without " +
  "repeating prior answers. Use Markdown only when it genuinely improves readability — never " +
  "add headings or horizontal rules to simple answers, never force bullet points into " +
  "conversational replies. Never mention agents, the team, internal workflows, or the process " +
  "behind the answer — just answer.";

const PERSONAS: Record<AgentId, string> = {
  lead:
    `${PERFORMANCE} You are the Lead Agent and central orchestrator of a multi-agent AI team. ` +
    "You manage the entire user journey, coordinate the Fast, Interviewer, Designer and Developer " +
    "agents, maintain shared context, monitor progress, resolve conflicts, and are the only agent " +
    "that speaks to the user. You must not approve incomplete or unverified work — check that the " +
    "output satisfies the original request, the requirements and the approved design before delivering. " +
    STYLE,
  interviewer:
    `${PERFORMANCE} You are the User Interaction & Information Gathering Agent. Your job is to ` +
    "understand exactly what the user wants, identify missing details, and turn requests into " +
    "structured requirements. Ask only essential questions — never unnecessary or repetitive ones.",
  designer:
    `${PERFORMANCE} You are the UI/UX Designer & Planning Agent. You analyse requirements, produce ` +
    "project plans, design user journeys, layouts and component specs, and review implementations " +
    "against your design. Do not prescribe specific UI widget types — that is the developer's " +
    "choice; if you do, screens with form controllers or loading state must be StatefulWidget.",
  developer:
    `${PERFORMANCE} You are the Development & Execution Agent. You implement approved plans into ` +
    "working results, write clean code, fix bugs, and report technical challenges to the Lead Agent. " +
    "When producing a website or app, output complete code in a single ```html fenced block. " +
    "Always return complete files — never partial snippets. Never ask the user for API keys or " +
    "credentials: use placeholder values (e.g. https://your-project.supabase.co, your-anon-key) " +
    "and note where real values go. " +
    STYLE,
  fast:
    `${PERFORMANCE} You are the Fast Response Agent. You run in parallel with the specialist ` +
    "workflow and give the user immediate conversational assistance while the team works. " +
    "Analyse the conversation context, answer what you can now, and explain what is happening. " +
    "Never claim work is finished while it is still in progress — but do not append tags like " +
    "\"(preliminary)\" to your text; the interface already marks your answer as interim. " +
    "Be fast, accurate and brief. " +
    STYLE,
  author:
    `${PERFORMANCE} You are the Author Agent — the only writer of user-facing text. ` +
    "You study the finished work from the other agents and compose the reply the user reads. " +
    "Your own prompting lives in author.ts; this persona exists for registry completeness.",
};

const MAX_REVISIONS = 2;

// --- Lead delivery gate -----------------------------------------------------
// Code checks only — the lead never rewrites the author's text. It either
// delivers it unchanged, sends it back to the author once with a note, or
// falls back to the deterministic no-AI reply.

const INTERNAL_WORDS = /\b(agents?|subtasks?|devin|rescu\w*|fallbacks?|lead agent)\b/i;
const INTERNAL_WORDS_G = new RegExp(INTERNAL_WORDS.source, "gi");

// Internal words the user used in their own goal/history are not leaks.
function allowedInternalWords(input: AuthorInput): Set<string> {
  const allowed = new Set<string>();
  for (const m of `${input.goal} ${input.history ?? ""}`.matchAll(INTERNAL_WORDS_G)) {
    allowed.add(m[0].toLowerCase());
  }
  return allowed;
}

/** Internal words are checked on prose only — fenced blocks and inline code are stripped first. */
const stripForGate = (t: string) =>
  t.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]+`/g, " ");

interface GateCheck {
  /** Empty / truncated / unclosed fence — still bad after retry -> deterministic fallback. */
  hard?: string;
  /** Internal-word leak — after retry the reply is delivered as-is with a warning. */
  soft?: string;
}

function gateCheck(text: string, truncated: boolean | undefined, allowed: Set<string>): GateCheck {
  if (!text.trim()) return { hard: "the reply was empty" };
  if (truncated) return { hard: "the reply was cut off mid-output" };
  if (((text.match(/```/g) ?? []).length % 2) !== 0) return { hard: "a code block was left unclosed" };
  for (const m of stripForGate(text).matchAll(INTERNAL_WORDS_G)) {
    if (!allowed.has(m[0].toLowerCase())) {
      return { soft: `the reply mentioned internal machinery ("${m[0]}")` };
    }
  }
  return {};
}

type AuthorResult = { text: string; usedFallback: boolean; truncated?: boolean };
type AuthorFn = (input: AuthorInput, opts: { short?: boolean }) => Promise<AuthorResult>;

/**
 * The lead's delivery step: take the author's text, run the gate, and deliver
 * it to the user UNCHANGED — never rewritten or shortened. A failed check sends
 * the text back to the author once; a second hard failure (empty, truncated or
 * unclosed code) delivers the deterministic fallback, while a lingering
 * internal-word mention is delivered as-is with a warning.
 */
export async function deliverResponse(
  input: AuthorInput,
  opts: { short?: boolean } = {},
  author: AuthorFn = writeResponse
): Promise<AuthorResult> {
  const allowed = allowedInternalWords(input);
  let w: AuthorResult;
  try {
    w = await author(input, opts);
  } catch {
    return { text: fallbackResponse(input), usedFallback: true };
  }
  let g = w.usedFallback ? {} : gateCheck(w.text, w.truncated, allowed);
  if (!g.hard && !g.soft) return w;

  const issue = g.hard ?? g.soft!;
  const note =
    `Your previous reply was rejected before delivery: ${issue}. ` +
    "Rewrite the reply fixing only that problem.";
  try {
    w = await author({ ...input, reviewNotes: [...(input.reviewNotes ?? []), note] }, opts);
  } catch {
    return { text: fallbackResponse(input), usedFallback: true };
  }
  g = w.usedFallback ? {} : gateCheck(w.text, w.truncated, allowed);

  if (g.hard) {
    console.warn(`[lead] author reply rejected twice (${g.hard}) — delivering deterministic fallback`);
    return { text: fallbackResponse(input), usedFallback: true };
  }
  if (g.soft) {
    console.warn(`[lead] author reply still mentions internal machinery (${g.soft}) — delivering as-is`);
  }
  return w;
}

interface Requirements {
  clear: boolean;
  question?: string;
  summary?: string;
}

interface DesignSpec {
  plan: string;
  spec: string;
}

interface Review {
  approved: boolean;
  feedback?: string;
}

function historyText(history: { role: string; content: string }[]): string {
  return history
    .slice(-8)
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");
}

/**
 * Runs one user request through the 4-agent pipeline:
 * Lead triages -> Interviewer structures requirements -> Designer plans/specs ->
 * Developer implements -> Lead reviews (revises up to MAX_REVISIONS) -> Lead delivers.
 */
export async function runMultiAgent(
  userRequest: string,
  history: { role: string; content: string }[],
  emit?: AgentEmit
): Promise<RunResult> {
  const bus = new MessageBus((m) => emit?.("activity", m));
  const board = new TaskBoard((t) => emit?.("task", t));
  const agentStatus = (agent: AgentId, status: TaskStatus) =>
    emit?.("agent_status", { agent, status });
  const prior = historyText(history);
  const context =
    `Today's date: ${new Date().toDateString()}.\n\n` +
    (prior ? `Conversation so far:\n${prior}\n\n` : "");

  bus.send("user", "lead", "info", userRequest);
  const triage = board.create("Triage user request and assign specialists", "lead");
  board.setStatus(triage.id, "in_progress");
  agentStatus("lead", "in_progress");

  // --- Fast Agent: runs in parallel, never blocks the main workflow -------
  const tFast = board.create("Provide immediate assistance while the workflow runs", "fast", [triage.id]);
  board.setStatus(tFast.id, "assigned");
  bus.send("lead", "fast", "task", tFast.description);
  board.setStatus(tFast.id, "in_progress");
  agentStatus("fast", "in_progress");

  // Online research: if the request needs live info, search + scrape pages in
  // parallel and inject results into every agent's context — never blocks on failure.
  const researchPromise = needsResearch(userRequest)
    ? gatherSources(userRequest, { maxResults: 6, maxPages: 3, useLlmFilter: false })
        .then((r) => buildBrief(r.sources))
        .catch(() => "")
    : Promise.resolve("");

  const fastPromise = researchPromise
    .then((research) => {
      const researchText = research
        ? `Web research (cite [n]). Use a source only if it is clearly about the task; ignore irrelevant sources.\n${research}\n\n`
        : "";
      if (research) bus.send("lead", "fast", "info", "Online research gathered");
      return callAgent("fast", [
        { role: "system", content: PERSONAS.fast },
        {
          role: "user",
          content:
            `${context}${researchText}The user just asked: "${userRequest}"\n` +
            `A specialist team is working on the full answer in the background. Give the best ` +
            `immediate answer or update you can right now — mark it clearly as preliminary. Keep it short.`,
        },
      ]);
    })
    .then((a) => {
      board.setStatus(tFast.id, "completed", a);
      agentStatus("fast", "completed");
      bus.send("fast", "team", "result", a.slice(0, 800));
      return a;
    })
    .catch((err) => {
      board.setStatus(tFast.id, "failed_blocked", undefined, String(err?.message ?? err).slice(0, 200));
      agentStatus("fast", "failed_blocked");
      bus.send("fast", "lead", "error", "Fast response failed");
      return "";
    });

  // --- Step 1: Interviewer structures the request -------------------------
  const tReq = board.create("Structure requirements from the user request", "interviewer", [triage.id]);
  board.setStatus(tReq.id, "assigned");
  bus.send("lead", "interviewer", "task", tReq.description);
  board.setStatus(tReq.id, "in_progress");
  agentStatus("interviewer", "in_progress");

  const research = await researchPromise;
  const researchText = research
    ? `Web research (cite [n]). Use a source only if it is clearly about the task; ignore irrelevant sources.\n${research}\n\n`
    : "";
  const fullContext = context + researchText;
  if (research) bus.send("lead", "interviewer", "info", "Online research injected into shared context");

  const req = await callJson<Requirements>("interviewer", [
    { role: "system", content: PERSONAS.interviewer },
    {
      role: "user",
      content:
        `${fullContext}User request: "${userRequest}"\n\n` +
        `Decide if this request is clear enough to act on. Reply with ONLY a JSON object:\n` +
        `{"clear": true, "summary": "structured requirements"} if the intent, scope and output are clear enough,\n` +
        `{"clear": false, "question": "one short essential question"} if a critical detail is missing.\n` +
        `Casual chat, questions and well-scoped tasks are clear — do not ask unnecessary questions.\n` +
        `The summary MUST restate the user's actual request faithfully — never reinterpret it as a design/build task ` +
        `unless the user explicitly asked to create or build something. For a question, summary = the question itself.`,
    },
  ]).catch((e): Requirements => {
    console.warn(
      "[orchestrator] interviewer failed — using the raw request:",
      e instanceof Error ? e.message.slice(0, 120) : e
    );
    return { clear: true, summary: userRequest };
  });

  if (!req.clear && req.question) {
    board.setStatus(tReq.id, "awaiting_information");
    agentStatus("interviewer", "awaiting_information");
    bus.send("interviewer", "lead", "clarification", req.question);
    board.setStatus(triage.id, "completed", "Paused — needs user clarification");
    const w = await deliverResponse(
      {
        goal: userRequest,
        history: prior,
        subtasks: [
          {
            id: "S1",
            agent: "interviewer",
            instruction: "clarify the request",
            status: "done",
            output: `Ask the user exactly this question: ${req.question}`,
          },
        ],
        warnings: [],
      },
      { short: true }
    );
    const fastAnswer = await fastPromise;
    return {
      reply: w.text,
      needsClarification: true,
      tasks: board.all(),
      activity: bus.log,
      preliminaryAnswer: fastAnswer || undefined,
    };
  }
  const requirements = req.summary ?? userRequest;
  board.setStatus(tReq.id, "completed", requirements);
  agentStatus("interviewer", "completed");
  bus.send("interviewer", "team", "info", `Requirements: ${requirements}`);

  // --- Step 2: Designer produces plan + spec ------------------------------
  const tDesign = board.create("Produce plan and design specification", "designer", [tReq.id]);
  board.setStatus(tDesign.id, "assigned");
  bus.send("lead", "designer", "task", tDesign.description);
  board.setStatus(tDesign.id, "in_progress");
  agentStatus("designer", "in_progress");

  const design = await callJson<DesignSpec>("designer", [
    { role: "system", content: PERSONAS.designer },
    {
      role: "user",
      content:
        `Original user request (authoritative — never reinterpret it): "${userRequest}"\n\n` +
        `Requirements from the requirements agent:\n${requirements}\n\n` +
        `Create a plan and a specification the developer can execute. Keep it short. ` +
        `If the request is a simple question or casual chat (not a build/design task), spec = "answer the user's question directly". ` +
        `Reply with ONLY a JSON object: {"plan": "ordered steps", "spec": "concrete spec for the deliverable"}`,
    },
  ]).catch(async (e): Promise<DesignSpec> => {
    console.warn(
      "[orchestrator] designer failed — rescuing with research + lead:",
      e instanceof Error ? e.message.slice(0, 120) : e
    );
    try {
      const { sources } = await gatherSources(userRequest, {
        agent: "designer",
        maxResults: 4,
        maxPages: 2,
        useLlmFilter: false,
      });
      const brief = sources.length ? buildBrief(sources) : "";
      const spec = await callAgent("lead", [
        { role: "system", content: PERSONAS.designer },
        {
          role: "user",
          content:
            `${brief ? `Web research (cite [n]). Use a source only if it is clearly about the task; ignore irrelevant sources.\n${brief}\n\n` : ""}` +
            `User request: "${userRequest}"\nRequirements:\n${requirements}\n\n` +
            `The designer failed — produce a concrete spec for the deliverable now.`,
        },
      ]);
      return { plan: "", spec };
    } catch {
      return { plan: "", spec: "answer the user's request directly" };
    }
  });
  const planText = typeof design.plan === "string" ? design.plan : JSON.stringify(design.plan);
  const specText = typeof design.spec === "string" ? design.spec : JSON.stringify(design.spec);
  board.setStatus(tDesign.id, "completed", specText);
  agentStatus("designer", "completed");
  bus.send("designer", "developer", "info", `Plan: ${planText}\nSpec: ${specText}`);

  // --- Step 3: Developer implements (with review loop) --------------------
  const tDev = board.create("Implement the approved specification", "developer", [tDesign.id]);
  board.setStatus(tDev.id, "assigned");
  bus.send("lead", "developer", "task", tDev.description);
  board.setStatus(tDev.id, "in_progress");
  agentStatus("developer", "in_progress");

  let deliverable = "";
  let feedback = "";
  let approved = false;
  let devinRescued = false;

  // Model path: one model call per file for code deliverables, single shot otherwise.
  const produceWithModel = async (devPrompt: string): Promise<string> => {
    const viaFiles = await generateFiles(devPrompt, PERSONAS.developer).catch(() => null);
    if (viaFiles) return viaFiles;
    return callAgent("developer", [
      { role: "system", content: PERSONAS.developer },
      { role: "user", content: devPrompt },
    ]);
  };

  for (let attempt = 1; attempt <= MAX_REVISIONS + 1 && !approved; attempt++) {
    bus.send("developer", "lead", "progress", `Attempt ${attempt}: implementing spec`);
    const devPrompt =
      `${fullContext}Original user request (authoritative): "${userRequest}"\n\n` +
      `Requirements:\n${requirements}\n\nPlan:\n${planText}\n\nSpec:\n${specText}\n\n` +
      (feedback ? `The Lead Agent rejected your previous output. Feedback:\n${feedback}\n\n` : "") +
      `Produce the deliverable for the user now. Respond directly to the user's request.`;

    // Devin once; after a rescue (or cooldown) revisions go through the model, not Devin.
    if (devinEnabled() && !devinRescued) {
      bus.send("developer", "lead", "progress", `Attempt ${attempt}: delegating implementation to Devin`);
      try {
        const outcome = await runDevinOrRescue(devPrompt, userRequest);
        deliverable = outcome.text;
        if (outcome.rescued) {
          devinRescued = true;
          bus.send(
            "developer",
            "lead",
            "info",
            `Devin unavailable (${(outcome.reason ?? "error").slice(0, 120)}) — completed via web research`
          );
        } else {
          bus.send("developer", "lead", "info", "Devin session completed");
        }
      } catch (err) {
        bus.send(
          "developer",
          "lead",
          "error",
          `Devin failed: ${String(err instanceof Error ? err.message : err).slice(0, 150)} — falling back to model`
        );
        deliverable = await produceWithModel(devPrompt);
      }
    } else {
      deliverable = await produceWithModel(devPrompt);
    }

    // --- Step 4: Lead reviews the actual output ---------------------------
    const tReview = board.create(`Review developer output (attempt ${attempt})`, "lead", [tDev.id]);
    board.setStatus(tReview.id, "in_progress");
    bus.send("developer", "lead", "result", deliverable.slice(0, 1500));
    bus.send("lead", "team", "progress", `Reviewing developer output (attempt ${attempt})`);
    agentStatus("lead", "under_review");

    const review = await callJson<Review>("lead", [
      { role: "system", content: PERSONAS.lead },
      {
        role: "user",
        content:
          `User request: "${userRequest}"\nSpec:\n${design.spec}\n\n` +
          `Developer's output:\n${deliverable.slice(0, 3000)}\n\n` +
          `Verify this output actually satisfies the request and spec. Reject ONLY for: ` +
          `(a) a required file is missing, (b) code that is incomplete or cut off mid-way, or ` +
          `(c) a functional bug versus the spec. Do NOT reject for style, formatting, naming, ` +
          `or widget/technology preferences. ` +
          `Reply with ONLY a JSON object: {"approved": true} or ` +
          `{"approved": false, "feedback": "short list of the concrete missing or broken items"}`,
      },
    ]).catch((e): Review => {
      console.warn(
        `[orchestrator] lead review failed on attempt ${attempt} — approving as-is:`,
        e instanceof Error ? e.message.slice(0, 120) : e
      );
      return { approved: true };
    });

    approved = review.approved;
    if (approved) {
      board.setStatus(tReview.id, "completed");
      board.setStatus(tDev.id, "completed", deliverable);
      agentStatus("developer", "completed");
      bus.send("lead", "developer", "feedback", "Output verified and approved.");
    } else {
      feedback = review.feedback ?? "Improve quality and fully satisfy the spec.";
      board.setStatus(tReview.id, "completed", undefined, feedback);
      board.setStatus(tDev.id, attempt <= MAX_REVISIONS ? "revision_required" : "failed_blocked", undefined, feedback);
      agentStatus("developer", attempt <= MAX_REVISIONS ? "revision_required" : "failed_blocked");
      bus.send("lead", "developer", "feedback", `Revision required: ${feedback}`);
    }
  }

  // --- Step 5: Author writes the reply the user sees -----------------------
  board.setStatus(triage.id, "completed", approved ? "Delivered" : "Delivered with limitations");
  agentStatus("lead", "completed");
  bus.send("lead", "author", "task", "Write the final reply for the user");
  agentStatus("author", "in_progress");

  // Author input: only the real work — requirements, spec, deliverable.
  // Triage, lead reviews and the fast preliminary answer stay internal.
  const authorSubtasks = [
    {
      id: "requirements",
      agent: "interviewer",
      instruction: "Structured requirements from the user request",
      status: "done",
      output: requirements,
    },
    {
      id: "spec",
      agent: "designer",
      instruction: "Plan and design specification",
      status: "done",
      output: `Plan:\n${planText}\n\nSpec:\n${specText}`,
    },
    {
      id: "work",
      agent: "developer",
      instruction: "Implementation output",
      status: approved ? "done" : "failed",
      output: deliverable.trim() || undefined,
      error: approved ? undefined : feedback || "implementation was not approved",
    },
  ];

  const written = await deliverResponse({
    goal: userRequest,
    history: prior,
    plan: authorSubtasks.map((t) => ({
      id: t.id,
      agent: t.agent,
      instruction: t.instruction,
      dependsOn: [],
    })),
    subtasks: authorSubtasks,
    warnings: [],
    reviewNotes: !approved && feedback ? [feedback] : [],
  });
  agentStatus("author", "completed");
  // author -> lead -> user: the lead delivers the author's text unchanged.
  bus.send("author", "lead", "result", written.text.slice(0, 1500));
  bus.send("lead", "user", "result", written.text.slice(0, 1500));

  const fastAnswer = await fastPromise;
  return {
    reply: written.text,
    needsClarification: false,
    tasks: board.all(),
    activity: bus.log,
    preliminaryAnswer: fastAnswer || undefined,
  };
}

/**
 * Fast-only mode: the user asked to talk to the Fast Agent directly.
 * One model call, no specialist workflow — the dashboard still gets real
 * task/activity/status events.
 */
export async function runFastAgent(
  userRequest: string,
  history: { role: string; content: string }[],
  emit?: AgentEmit
): Promise<RunResult> {
  const bus = new MessageBus((m) => emit?.("activity", m));
  const board = new TaskBoard((t) => emit?.("task", t));
  const agentStatus = (agent: AgentId, status: TaskStatus) =>
    emit?.("agent_status", { agent, status });
  const prior = historyText(history);
  const context =
    `Today's date: ${new Date().toDateString()}.\n\n` +
    (prior ? `Conversation so far:\n${prior}\n\n` : "");

  bus.send("user", "lead", "info", userRequest);
  const tFast = board.create("Answer the request directly (fast-only mode)", "fast");
  board.setStatus(tFast.id, "assigned");
  bus.send("lead", "fast", "task", tFast.description);
  board.setStatus(tFast.id, "in_progress");
  agentStatus("fast", "in_progress");

  const research = needsResearch(userRequest)
    ? await gatherSources(userRequest, { maxResults: 6, maxPages: 3, useLlmFilter: false })
        .then((r) => buildBrief(r.sources))
        .catch(() => "")
    : "";
  const researchText = research
    ? `Web research (cite [n]). Use a source only if it is clearly about the task; ignore irrelevant sources.\n${research}\n\n`
    : "";
  if (research) bus.send("lead", "fast", "info", "Online research gathered");

  const answer = await callAgent("fast", [
    { role: "system", content: PERSONAS.fast },
    {
      role: "user",
      content: `${context}${researchText}User request: "${userRequest}"\n\nAnswer the user's request directly and concisely.`,
    },
  ]);

  board.setStatus(tFast.id, "completed", answer);
  agentStatus("fast", "completed");
  bus.send("fast", "lead", "result", answer.slice(0, 1500));

  agentStatus("author", "in_progress");
  const written = await deliverResponse(
    {
      goal: userRequest,
      history: prior,
      subtasks: [
        { id: "S1", agent: "fast", instruction: userRequest, status: "done", output: answer },
      ],
      warnings: [],
    },
    { short: true }
  );
  agentStatus("author", "completed");
  // author -> lead -> user: delivered unchanged.
  bus.send("author", "lead", "result", written.text.slice(0, 1500));
  bus.send("lead", "user", "result", written.text.slice(0, 1500));

  return {
    reply: written.text,
    needsClarification: false,
    tasks: board.all(),
    activity: bus.log,
  };
}
