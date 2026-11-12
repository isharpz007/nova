export type AgentId = "lead" | "interviewer" | "designer" | "developer" | "fast" | "author";
export type ParticipantId = AgentId | "user";

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "awaiting_information"
  | "under_review"
  | "revision_required"
  | "completed"
  | "rescued"
  | "failed_blocked";

export interface Task {
  id: string;
  description: string;
  assignedTo: AgentId;
  status: TaskStatus;
  dependsOn: string[];
  result?: string;
  reviewNote?: string;
}

export type MessageType =
  | "task"
  | "info"
  | "clarification"
  | "feedback"
  | "result"
  | "error"
  | "progress";

export interface AgentMessage {
  id: string;
  from: ParticipantId;
  to: ParticipantId | "team";
  type: MessageType;
  content: string;
  at: string;
}

export interface RunResult {
  reply: string;
  needsClarification: boolean;
  tasks: Task[];
  activity: AgentMessage[];
  /** Immediate answer from the Fast Agent, produced in parallel with the workflow. */
  preliminaryAnswer?: string;
}

export interface AgentStatusEvent {
  agent: AgentId;
  status: TaskStatus;
}

export type AgentStreamEventType =
  | "activity"
  | "task"
  | "agent_status"
  | "preliminary"
  | "done"
  | "error";

export type AgentEmit = (event: AgentStreamEventType, data: unknown) => void;
