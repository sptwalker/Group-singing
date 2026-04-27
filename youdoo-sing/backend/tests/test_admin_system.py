import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

TEST_DB = Path(__file__).parent / "admin_system_test.sqlite3"
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ.setdefault("ADMIN_PASSWORD_SALT", "youdoo-sing-test")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.api.routes import ADMIN_TOKENS, router
from app.core.database import Base, SessionLocal, engine
from app.core.multitenant import bootstrap_multitenant, hash_password
from app.models import AdminUser, AuditLog, Recording, Segment, Song


@pytest.fixture()
def client():
    ADMIN_TOKENS.clear()
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    bootstrap_multitenant()
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as c:
        yield c
    ADMIN_TOKENS.clear()
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(client: TestClient, username: str, password: str) -> dict:
    res = client.post("/api/admin/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["token"]
    return data


def test_super_admin_seed_login_and_check(client):
    res = client.post("/api/admin/login", json={"username": "administrator", "password": "888888"})
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["role"] == "super_admin"
    assert data["username"] == "administrator"

    check = client.get("/api/admin/check", headers=auth_header(data["token"]))
    assert check.status_code == 200
    assert check.json()["data"]["role"] == "super_admin"

    bad = client.post("/api/admin/login", json={"username": "administrator", "password": "bad"})
    assert bad.status_code == 401


def test_registration_settings_invite_code_and_audit_log(client):
    status = client.get("/api/admin/register-status")
    assert status.status_code == 200
    assert status.json()["data"] == {"enabled": False, "invite_required": True}

    super_admin = login(client, "administrator", "888888")
    settings = client.put(
        "/api/super/settings",
        headers=auth_header(super_admin["token"]),
        json={
            "admin_registration_enabled": True,
            "admin_registration_invite_required": True,
            "default_song_limit": 7,
        },
    )
    assert settings.status_code == 200

    code_res = client.post("/api/super/invite-codes", headers=auth_header(super_admin["token"]))
    assert code_res.status_code == 200
    code = code_res.json()["data"]["code"]

    register = client.post(
        "/api/admin/register",
        json={
            "username": "tenant_a",
            "password": "abcdef",
            "email": "tenant_a@example.com",
            "display_name": "Tenant A",
            "invite_code": code,
        },
    )
    assert register.status_code == 200, register.text
    admin = register.json()["data"]
    assert admin["role"] == "admin"
    assert admin["song_limit"] == 7

    reused = client.post(
        "/api/admin/register",
        json={
            "username": "tenant_b",
            "password": "abcdef",
            "email": "tenant_b@example.com",
            "invite_code": code,
        },
    )
    assert reused.status_code == 400

    with SessionLocal() as db:
        invite_logs = db.query(AuditLog).filter(AuditLog.action == "super_create_invite_code").count()
        register_logs = db.query(AuditLog).filter(AuditLog.action == "admin_register").count()
    assert invite_logs == 1
    assert register_logs == 1


def test_freeze_unfreeze_and_reset_password(client):
    super_admin = login(client, "administrator", "888888")
    with SessionLocal() as db:
        admin = AdminUser(
            id="admin_freeze_test",
            username="freeze_test",
            password_hash=hash_password("oldpass"),
            display_name="Freeze Test",
            email="freeze@example.com",
            email_confirmed=True,
            role="admin",
            status="active",
            song_limit=5,
        )
        db.add(admin)
        db.commit()

    tenant = login(client, "freeze_test", "oldpass")

    freeze = client.post(
        "/api/super/admins/admin_freeze_test/freeze",
        headers=auth_header(super_admin["token"]),
        json=True,
    )
    assert freeze.status_code == 200
    assert freeze.json()["data"]["status"] == "frozen"
    assert freeze.json()["data"]["freeze_tasks"] is True

    old_check = client.get("/api/admin/check", headers=auth_header(tenant["token"]))
    assert old_check.status_code == 401
    frozen_login = client.post("/api/admin/login", json={"username": "freeze_test", "password": "oldpass"})
    assert frozen_login.status_code == 403

    unfreeze = client.post(
        "/api/super/admins/admin_freeze_test/unfreeze",
        headers=auth_header(super_admin["token"]),
    )
    assert unfreeze.status_code == 200

    reset = client.post(
        "/api/super/admins/admin_freeze_test/reset-password",
        headers=auth_header(super_admin["token"]),
    )
    assert reset.status_code == 200
    assert client.post("/api/admin/login", json={"username": "freeze_test", "password": "oldpass"}).status_code == 401
    assert client.post("/api/admin/login", json={"username": "freeze_test", "password": "123456"}).status_code == 200


def test_admin_song_tenant_isolation_and_super_visibility(client):
    super_admin = login(client, "administrator", "888888")
    with SessionLocal() as db:
        db.add_all([
            AdminUser(id="tenant_a", username="tenant_a", password_hash=hash_password("abcdef"), role="admin", status="active", song_limit=5),
            AdminUser(id="tenant_b", username="tenant_b", password_hash=hash_password("abcdef"), role="admin", status="active", song_limit=5),
            Song(id="song_a", owner_admin_id="tenant_a", title="Song A", artist="A", duration=10, audio_url="/api/uploads/a.mp3", task_published=True),
            Song(id="song_b", owner_admin_id="tenant_b", title="Song B", artist="B", duration=10, audio_url="/api/uploads/b.mp3", task_published=True),
            Segment(id="song_a-01", owner_admin_id="tenant_a", song_id="song_a", index=1, start_time=0, end_time=5),
            Segment(id="song_b-01", owner_admin_id="tenant_b", song_id="song_b", index=1, start_time=0, end_time=5),
            Recording(id="rec_a", owner_admin_id="tenant_a", song_id="song_a", segment_id="song_a-01", user_id="u1", user_name="U1", submitted=True),
            Recording(id="rec_b", owner_admin_id="tenant_b", song_id="song_b", segment_id="song_b-01", user_id="u2", user_name="U2", submitted=True),
        ])
        db.commit()

    tenant_a = login(client, "tenant_a", "abcdef")
    tenant_b = login(client, "tenant_b", "abcdef")

    a_songs = client.get("/api/admin/songs", headers=auth_header(tenant_a["token"]))
    assert a_songs.status_code == 200
    assert [s["id"] for s in a_songs.json()["data"]] == ["song_a"]

    b_songs = client.get("/api/admin/songs", headers=auth_header(tenant_b["token"]))
    assert b_songs.status_code == 200
    assert [s["id"] for s in b_songs.json()["data"]] == ["song_b"]

    cross = client.get("/api/admin/songs/song_b", headers=auth_header(tenant_a["token"]))
    assert cross.status_code == 404

    super_songs = client.get("/api/admin/songs", headers=auth_header(super_admin["token"]))
    assert super_songs.status_code == 200
    assert {s["id"] for s in super_songs.json()["data"]} == {"song_a", "song_b"}
