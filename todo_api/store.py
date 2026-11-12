from datetime import datetime, timezone
from threading import Lock
from typing import Dict, Optional

from .schemas import Todo


class TodoStore:
    """Thread-safe in-memory todo store."""

    def __init__(self) -> None:
        self._items: Dict[int, Todo] = {}
        self._next_id = 1
        self._lock = Lock()

    def list(self, completed: Optional[bool] = None) -> list[Todo]:
        with self._lock:
            items = list(self._items.values())
        if completed is not None:
            items = [t for t in items if t.completed == completed]
        return sorted(items, key=lambda t: t.id)

    def get(self, todo_id: int) -> Optional[Todo]:
        with self._lock:
            return self._items.get(todo_id)

    def create(self, title: str, description: Optional[str], completed: bool) -> Todo:
        with self._lock:
            todo = Todo(
                id=self._next_id,
                title=title,
                description=description,
                completed=completed,
                created_at=datetime.now(timezone.utc),
            )
            self._items[todo.id] = todo
            self._next_id += 1
            return todo

    def update(
        self, todo_id: int, title: Optional[str], description: Optional[str], completed: Optional[bool]
    ) -> Optional[Todo]:
        with self._lock:
            todo = self._items.get(todo_id)
            if todo is None:
                return None
            data = todo.model_dump()
            if title is not None:
                data["title"] = title
            if description is not None:
                data["description"] = description
            if completed is not None:
                data["completed"] = completed
            updated = Todo(**data)
            self._items[todo_id] = updated
            return updated

    def delete(self, todo_id: int) -> bool:
        with self._lock:
            return self._items.pop(todo_id, None) is not None
