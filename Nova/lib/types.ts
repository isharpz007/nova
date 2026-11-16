export interface Profile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  created_at: string;
}

export type MessageRole = "user" | "assistant";

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  user_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  read: boolean;
  created_at: string;
}

export interface NotificationPreferences {
  email_updates: boolean;
  email_digest: boolean;
  push_updates: boolean;
  push_digest: boolean;
}

// ---------- Studio (Phase 0) ----------

export interface ProjectDocument {
  version: number;
  layers: unknown[];
  frames: unknown[];
  [key: string]: unknown;
}

export interface Project {
  id: string;
  user_id: string;
  title: string;
  width: number;
  height: number;
  background: string;
  fps: number;
  document: ProjectDocument;
  created_at: string;
  updated_at: string;
}

export type ProjectSummary = Omit<Project, "document">;
