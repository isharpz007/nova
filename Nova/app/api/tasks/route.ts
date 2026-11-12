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
