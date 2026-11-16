// Command-based undo/redo. Every mutation — element commits AND structural
// changes (layers, frames, properties) — is a reversible command on one stack,
// so undo order always matches user action order.

import type { DrawingElement } from "./drawing-types";
import { MAX_HISTORY } from "./drawing-types";

export interface HistoryCommand {
  undo(): void;
  redo(): void;
}

export class DrawingHistory {
  private undoStack: HistoryCommand[] = [];
  private redoStack: HistoryCommand[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get size(): number {
    return this.undoStack.length;
  }

  /** Push an arbitrary reversible command. Clears the redo stack. */
  push(command: HistoryCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Convenience: record that `element` was appended to `elements` (a layer's list). */
  recordAdd(elements: DrawingElement[], element: DrawingElement): void {
    const index = elements.indexOf(element);
    this.push({
      undo: () => {
        const i = elements.indexOf(element);
        if (i >= 0) elements.splice(i, 1);
      },
      redo: () => {
        if (!elements.includes(element)) {
          elements.splice(Math.min(index, elements.length), 0, element);
        }
      },
    });
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.redo();
    this.undoStack.push(cmd);
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
