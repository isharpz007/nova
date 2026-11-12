import { NextResponse } from "next/server";
import { recentCalls, summary } from "@/lib/agents/metrics";
import { agentAssignments } from "@/lib/agents/llm";

/** Model performance stats — server-side only, no user data or keys. */
export async function GET() {
  const s = summary();
  return NextResponse.json({
    ...s,
    assignments: agentAssignments(),
    recentCalls: recentCalls(50),
  });
}
