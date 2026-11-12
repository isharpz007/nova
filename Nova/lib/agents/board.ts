import type { AgentId, Task, TaskStatus } from "./types";

/** Task board — the single source of truth for who owns what. */
export class TaskBoard {
  private seq = 0;
  private tasks: Task[] = [];

  constructor(private onChange?: (t: Task) => void) {}

  private emit(task: Task): void {
    this.onChange?.({ ...task, dependsOn: [...task.dependsOn] });
  }

  /**
   * Creates a task. If an identical open task already exists for the same
   * agent, returns it instead of creating a duplicate.
   */
  create(description: string, assignedTo: AgentId, dependsOn: string[] = []): Task {
    const existing = this.tasks.find(
      (t) =>
        t.assignedTo === assignedTo &&
        t.description === description &&
        t.status !== "completed" &&
        t.status !== "failed_blocked"
    );
    if (existing) return existing;

    const task: Task = {
      id: `T${++this.seq}`,
      description,
      assignedTo,
      status: "pending",
      dependsOn,
    };
    this.tasks.push(task);
    this.emit(task);
    return task;
  }

  setStatus(id: string, status: TaskStatus, result?: string, reviewNote?: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Unknown task ${id}`);
    t.status = status;
    if (result !== undefined) t.result = result;
    if (reviewNote !== undefined) t.reviewNote = reviewNote;
    this.emit(t);
  }

  get(id: string): Task | undefined {
    return this.tasks.find((x) => x.id === id);
  }

  /** Unfinished work currently owned by an agent. */
  activeFor(agent: AgentId): Task[] {
    return this.tasks.filter(
      (t) => t.assignedTo === agent && t.status !== "completed" && t.status !== "failed_blocked"
    );
  }

  all(): Task[] {
    return [...this.tasks];
  }
}
