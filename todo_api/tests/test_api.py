import pytest
from fastapi.testclient import TestClient

from todo_api.main import app, store


@pytest.fixture
def client():
    store._items.clear()
    store._next_id = 1
    return TestClient(app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_create_and_get_todo(client):
    r = client.post("/todos", json={"title": "Buy milk", "description": "2L"})
    assert r.status_code == 201
    todo = r.json()
    assert todo["id"] == 1
    assert todo["completed"] is False

    r = client.get("/todos/1")
    assert r.status_code == 200
    assert r.json()["title"] == "Buy milk"


def test_create_validation_empty_title(client):
    r = client.post("/todos", json={"title": ""})
    assert r.status_code == 422


def test_list_todos_filter_completed(client):
    client.post("/todos", json={"title": "a"})
    client.post("/todos", json={"title": "b", "completed": True})

    assert len(client.get("/todos").json()) == 2
    done = client.get("/todos", params={"completed": "true"}).json()
    assert len(done) == 1 and done[0]["title"] == "b"
    pending = client.get("/todos", params={"completed": "false"}).json()
    assert len(pending) == 1 and pending[0]["title"] == "a"


def test_update_todo(client):
    client.post("/todos", json={"title": "a"})
    r = client.patch("/todos/1", json={"completed": True, "title": "a2"})
    assert r.status_code == 200
    body = r.json()
    assert body["completed"] is True and body["title"] == "a2"


def test_get_missing_returns_404(client):
    assert client.get("/todos/999").status_code == 404


def test_delete_todo(client):
    client.post("/todos", json={"title": "a"})
    assert client.delete("/todos/1").status_code == 204
    assert client.get("/todos/1").status_code == 404
    assert client.delete("/todos/1").status_code == 404
