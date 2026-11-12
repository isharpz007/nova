import { NextResponse } from "next/server";
import { generateReply } from "@/lib/reply";
import { deliverResponse, runFastAgent, runMultiAgent } from "@/lib/agents/orchestrator";
import type { AgentStreamEventType } from "@/lib/agents/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function sseResponse(
  userRequest: string,
  history: { role: string; content: string }[],
  fastOnly: boolean
): Response {
  const historyText = history
    .slice(-8)
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController | null = null;

  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });

  const push = (event: AgentStreamEventType, data: unknown) => {
    try {
      controller?.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      );
    } catch {
      // Stream already closed.
    }
  };
  const close = () => {
    try {
      controller?.close();
    } catch {
      // Already closed.
    }
  };

  // Run the pipeline in the background and stream events as they happen.
  (async () => {
    try {
      const result = fastOnly
        ? await runFastAgent(userRequest, history, push)
        : await runMultiAgent(userRequest, history, push);
      push("done", result);
    } catch (err) {
      console.warn(
        "[/api/chat] multi-agent pipeline failed, falling back:",
        err instanceof Error ? err.message : err
      );
      push("error", { message: "Agent pipeline failed — falling back to the author." });
      try {
        const w = await deliverResponse({
          goal: userRequest,
          history: historyText,
          subtasks: [],
          warnings: ["agent pipeline failed"],
        });
        push("done", { reply: w.text, needsClarification: false, tasks: [], activity: [] });
      } catch (err2) {
        console.warn("[/api/chat] fallback failed:", err2 instanceof Error ? err2 : err2);
        push("done", {
          reply: generateReply(userRequest),
          needsClarification: false,
          tasks: [],
          activity: [],
        });
      }
    } finally {
      close();
    }
  })();

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(request: Request) {
  let body: { messages?: ChatMessage[]; stream?: boolean; fast?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Last message must be from the user" }, { status: 400 });
  }

  const userRequest = messages[messages.length - 1].content;
  const history = messages.slice(0, -1);

  if (body.stream === true) {
    return sseResponse(userRequest, history, body.fast === true);
  }

  // Non-streaming contract preserved.
  try {
    const result = body.fast === true
      ? await runFastAgent(userRequest, history)
      : await runMultiAgent(userRequest, history);
    return NextResponse.json({
      reply: result.reply,
      needsClarification: result.needsClarification,
      tasks: result.tasks,
      activity: result.activity,
      preliminaryAnswer: result.preliminaryAnswer,
    });
  } catch (err) {
    console.warn(
      "[/api/chat] multi-agent pipeline failed, falling back:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    const w = await deliverResponse({
      goal: userRequest,
      history: history
        .slice(-8)
        .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
        .join("\n"),
      subtasks: [],
      warnings: ["agent pipeline failed"],
    });
    return NextResponse.json({ reply: w.text });
  } catch (err) {
    console.warn("[/api/chat] all providers failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ reply: generateReply(userRequest) });
}
