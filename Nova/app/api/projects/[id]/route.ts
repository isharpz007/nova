import { NextRequest, NextResponse } from "next/server";
import { getAuthedClient, validateProjectInput } from "@/lib/projects";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

async function getOwnedProject(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) {
    return { error: NextResponse.json({ error: "Invalid project id" }, { status: 400 }) };
  }
  const auth = await getAuthedClient(request);
  if (!auth) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const { data, error } = await auth.supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error) {
    return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  }
  if (!data) {
    return { error: NextResponse.json({ error: "Project not found" }, { status: 404 }) };
  }
  return { auth, id };
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const check = await getOwnedProject(request, ctx);
  if ("error" in check) return check.error;

  const { data, error } = await check.auth.supabase
    .from("projects")
    .select("*")
    .eq("id", check.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

export async function PATCH(request: NextRequest, ctx: Ctx) {
  const check = await getOwnedProject(request, ctx);
  if ("error" in check) return check.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fields, error } = validateProjectInput(
    (body ?? {}) as Record<string, unknown>,
    []
  );
  if (error) return NextResponse.json({ error }, { status: 400 });
  if (!fields || Object.keys(fields).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data, error: dbError } = await check.auth.supabase
    .from("projects")
    .update(fields)
    .eq("id", check.id)
    .eq("user_id", check.auth.user.id)
    .select()
    .single();

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  const check = await getOwnedProject(request, ctx);
  if ("error" in check) return check.error;

  const { error } = await check.auth.supabase
    .from("projects")
    .delete()
    .eq("id", check.id)
    .eq("user_id", check.auth.user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
