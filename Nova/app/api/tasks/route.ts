import { NextResponse } from "next/server";
import { runTask, type TaskEvent } from "@/lib/agents/taskrunner";

/** POST /api/tasks { goal, history? } — streams TaskEvents over SSE. */
export async function POST(request: Request) {
  let body: { goal?: string; history?: { role?: string; content?: string }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const goal = String(body.goal ?? "").trim().slice(0, 4000);
  if (!goal) return NextResponse.json({ error: "Missing goal" }, { status: 400 });

  const normalizedQuestion = goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalizedQuestion === "what is your name") {
    const run = {
      id: "learned-answer",
      goal,
      subtasks: [],
      brief: "",
      sources: [],
      final: "My name is Nova, an AI service that helps you with your tasks",
      warnings: [],
    };
    const encoder = new TextEncoder();
    return new Response(
      encoder.encode("event: run\ndata: " + JSON.stringify(run) + "\n\n"),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      }
    );
  }

  const context = (body.history ?? [])
    .slice(-8)
    .map((m) => `${m.role}: ${String(m.content ?? "").slice(0, 500)}`)
    .filter((l) => l.length > 6)
    .join("\n");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (e: TaskEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          );
        } catch {
          // stream closed
        }
      };
      try {
        const run = await runTask(goal, push, { context });
        controller.enqueue(
          encoder.encode(`event: run\ndata: ${JSON.stringify(run)}\n\n`)
        );
      } catch (err) {
        push({
          type: "subtask_failed",
          id: "task",
          error: err instanceof Error ? err.message : "Task failed",
        });
      } finally {
        try {
          controller.close();
        } catch {
          // closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
