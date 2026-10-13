"""ST Chat Explorer - read-only SillyTavern chat browser and search.

The SillyTavern data directory is mounted read-only; this app never writes
inside it. All writes (none persistent) go to temp files for zip assembly.
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import time
import zipfile
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import search as searchmod
from .stindex import Index

DATA_ROOT = os.environ.get("DATA_ROOT", "/data")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
MAX_ZIP_FILES = 2000

app = FastAPI(title="ST Chat Explorer", docs_url=None, redoc_url=None)
index = Index(DATA_ROOT)
build_thread = None


def _start_build():
    global build_thread
    index.progress = {"done": 0, "total": 0, "phase": "starting", "ready": False}
    build_thread = threading.Thread(target=index.build, daemon=True)
    build_thread.start()


@app.on_event("startup")
def on_startup():
    _start_build()


def require_ready():
    if not index.progress.get("ready"):
        raise HTTPException(status_code=503, detail="index is still building")


def _get_avatar_path(avatar: str) -> str:
    require_ready()
    if not avatar or "/" in avatar or "\\" in avatar or avatar in (".", ".."):
        raise HTTPException(400, "bad avatar")
    path = os.path.join(index.characters_dir, avatar + ".png")
    if not os.path.isfile(path):
        raise HTTPException(404, "avatar not found")
    return path


def _get_chat_path(avatar: str, fname: str) -> str:
    require_ready()
    path = index.chat_path(avatar, fname)
    if not path:
        raise HTTPException(404, "chat not found")
    return path


# ---------------- API ----------------

@app.get("/api/status")
def api_status():
    return index.status()


@app.get("/api/characters")
def api_characters():
    require_ready()
    return {"groups": index.groups()}


@app.get("/api/character/{avatar}")
def api_character(avatar: str):
    require_ready()
    card = index.cards.get(avatar)
    chats = [c.to_api() for c in sorted(index.chats.get(avatar, []), key=lambda c: (c.base_name.lower(), c.branch_no or 0))]
    if card is None and not chats:
        raise HTTPException(404, "character not found")
    card_api = card.to_api() if card else {"avatar": avatar, "name": avatar, "has_card": False, "creator_notes": ""}
    if card:
        card_api["texts"] = card.texts
        card_api["size"] = card.size
    return {
        "card": card_api,
        "chats": chats,
        "totals": {
            "chats": len(chats),
            "messages": sum(c.msgs for c in index.chats.get(avatar, [])),
            "branches": sum(1 for c in index.chats.get(avatar, []) if c.is_branch),
        },
    }


@app.get("/api/chat/{avatar}/{fname}")
def api_chat(avatar: str, fname: str):
    require_ready()
    path = _get_chat_path(avatar, fname)
    info = index.find_chat(avatar, fname)
    if info is None:
        raise HTTPException(404, "chat not in index")
    siblings = [
        c.to_api() for c in index.chats.get(avatar, [])
        if c.base_name == info.base_name and c.file != fname
    ]
    return {
        "info": info.to_api(),
        "siblings": siblings,
        "messages": searchmod.parse_chat_full(path),
    }


@app.get("/api/search")
def api_search(
    q: str = Query(""),
    scope: str = Query("all"),
    targets: str = Query("messages"),
    branches: str = Query("all"),
    case: str = Query(""),
    word: str = Query(""),
    regex: str = Query(""),
    avatar: str = Query(""),
    role: str = Query("any"),
    model: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    limit: int = Query(1000, ge=1, le=5000),
    per_chat: int = Query(40, ge=1, le=200),
):
    require_ready()
    if scope not in searchmod.SCOPES:
        raise HTTPException(400, f"scope must be one of {searchmod.SCOPES}")
    if branches not in ("all", "exclude", "only"):
        raise HTTPException(400, "branches must be all|exclude|only")
    if role not in ("any", "user", "ai"):
        raise HTTPException(400, "role must be any|user|ai")
    tgt = tuple(t for t in targets.split(",") if t)
    for t in tgt:
        if t not in searchmod.TARGETS:
            raise HTTPException(400, f"target must be one of {searchmod.TARGETS}")
    if avatar and avatar not in index.chats and avatar not in index.cards:
        raise HTTPException(400, "unknown avatar")
    opts = searchmod.SearchOptions(
        q=q,
        scope=scope,
        targets=tgt or ("messages",),
        branches=branches,
        case_sensitive=bool(case),
        whole_word=bool(word),
        regex=bool(regex),
        avatar=avatar or None,
        role=role,
        model=model,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        per_chat=per_chat,
    )
    try:
        return searchmod.run_search(index, opts)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/download/{avatar}/{fname}")
def api_download(avatar: str, fname: str):
    path = _get_chat_path(avatar, fname)
    return FileResponse(
        path,
        media_type="application/jsonl",
        filename=fname,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"},
    )


@app.post("/api/download-zip")
def api_download_zip(body: dict):
    require_ready()
    items = body.get("items") or []
    if not items:
        raise HTTPException(400, "no items")
    if len(items) > MAX_ZIP_FILES:
        raise HTTPException(400, f"too many files (max {MAX_ZIP_FILES})")
    # validate first, so we never stream a partial zip
    paths = []
    for it in items:
        avatar = it.get("avatar") or ""
        fname = it.get("file") or ""
        path = index.chat_path(avatar, fname)
        if not path:
            raise HTTPException(404, f"chat not found: {avatar}/{fname}")
        paths.append((avatar, fname, path))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for avatar, fname, path in paths:
            with open(path, "rb") as f:
                zf.writestr(zipfile.ZipInfo(f"{avatar}/{fname}"), f.read())
    buf.seek(0)
    ts = time.strftime("%Y%m%d-%H%M%S")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="st-chats-{ts}.zip"'},
    )


@app.get("/api/avatar/{avatar}")
def api_avatar(avatar: str, w: int = Query(96, ge=16, le=512)):
    path = _get_avatar_path(avatar)
    try:
        img = Image.open(path)
        img.load()
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        ratio = w / img.width
        if ratio < 1:
            img = img.resize((w, max(1, round(img.height * ratio))), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, "PNG")
        return Response(content=out.getvalue(), media_type="image/png")
    except Exception:
        return FileResponse(path, media_type="image/png")


# ---------------- static frontend ----------------

if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
