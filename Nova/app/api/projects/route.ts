import { NextRequest, NextResponse } from "next/server";
import { getAuthedClient, validateProjectInput, DEFAULT_DOCUMENT } from "@/lib/projects";

const LIST_COLUMNS =
  "id,user_id,title,width,height,background,fps,created_at,updated_at";

export async function GET(request: NextRequest) {
  const auth = await getAuthedClient(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await auth.supabase
    .from("projects")
    .select(LIST_COLUMNS)
    .eq("user_id", auth.user.id)
    .order("updated_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ projects: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await getAuthedClient(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fields, error } = validateProjectInput(
    (body ?? {}) as Record<string, unknown>,
    ["width", "height"]
  );
  if (error) return NextResponse.json({ error }, { status: 400 });

  const { data, error: dbError } = await auth.supabase
    .from("projects")
    .insert({
      user_id: auth.user.id,
      title: fields!.title ?? "Untitled project",
      width: fields!.width,
      height: fields!.height,
      background: fields!.background ?? "#ffffff",
      fps: fields!.fps ?? 12,
      document: fields!.document ?? DEFAULT_DOCUMENT,
    })
    .select()
    .single();

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  return NextResponse.json({ project: data }, { status: 201 });
}
