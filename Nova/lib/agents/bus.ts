import type { AgentMessage, MessageType, ParticipantId } from "./types";

/** Shared message log — every agent-to-agent communication is recorded here. */
export class MessageBus {
  private seq = 0;
  readonly log: AgentMessage[] = [];

  constructor(private onMessage?: (m: AgentMessage) => void) {}

  send(from: ParticipantId, to: ParticipantId | "team", type: MessageType, content: string): AgentMessage {
    const msg: AgentMessage = {
      id: `M${++this.seq}`,
      from,
      to,
      type,
      content: content.slice(0, 4000),
      at: new Date().toISOString(),
    };
    this.log.push(msg);
    this.onMessage?.(msg);
    return msg;
  }
}
