from fastapi import Depends, FastAPI, HTTPException, Query, status

from .schemas import Todo, TodoCreate, TodoUpdate
from .store import TodoStore

app = FastAPI(title="Todo API", version="1.0.0")


def get_store() -> TodoStore:
    return store


store = TodoStore()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/todos", response_model=list[Todo])
def list_todos(
    completed: bool | None = Query(default=None),
    store: TodoStore = Depends(get_store),
) -> list[Todo]:
    return store.list(completed=completed)


@app.post("/todos", response_model=Todo, status_code=status.HTTP_201_CREATED)
def create_todo(payload: TodoCreate, store: TodoStore = Depends(get_store)) -> Todo:
    return store.create(
        title=payload.title,
        description=payload.description,
        completed=payload.completed,
    )


@app.get("/todos/{todo_id}", response_model=Todo)
def get_todo(todo_id: int, store: TodoStore = Depends(get_store)) -> Todo:
    todo = store.get(todo_id)
    if todo is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    return todo


@app.patch("/todos/{todo_id}", response_model=Todo)
def update_todo(
    todo_id: int, payload: TodoUpdate, store: TodoStore = Depends(get_store)
) -> Todo:
    todo = store.update(
        todo_id=todo_id,
        title=payload.title,
        description=payload.description,
        completed=payload.completed,
    )
    if todo is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    return todo


@app.delete("/todos/{todo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_todo(todo_id: int, store: TodoStore = Depends(get_store)) -> None:
    if not store.delete(todo_id):
        raise HTTPException(status_code=404, detail="Todo not found")
