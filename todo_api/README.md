# Todo API

A small FastAPI todo API with an in-memory store and pytest tests.

## Endpoints

| Method | Path              | Description                        |
| ------ | ----------------- | ---------------------------------- |
| GET    | `/health`         | Health check                       |
| GET    | `/todos`          | List todos (`?completed=true/false` filter) |
| POST   | `/todos`          | Create a todo (`title` required)   |
| GET    | `/todos/{id}`     | Get one todo                       |
| PATCH  | `/todos/{id}`     | Update fields                      |
| DELETE | `/todos/{id}`     | Delete a todo                      |

## Setup

```bash
pip install -r requirements.txt
```

## Run

```bash
uvicorn todo_api.main:app --reload
```

API docs: http://localhost:8000/docs

## Test

```bash
pytest todo_api/tests
```
