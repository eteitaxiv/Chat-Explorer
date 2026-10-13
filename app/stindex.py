"""SillyTavern data indexing: character cards (PNG/JSON) and chat files.

Read-only by design: nothing under DATA_ROOT is ever opened for writing.
"""
from __future__ import annotations

import base64
import json
import os
import re
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

BRANCH_RE = re.compile(r"^(.*) - Branch #(\d+)$", re.IGNORECASE)

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

CARD_TEXT_FIELDS = (
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
)


def _png_text_chunks(data: bytes):
    if len(data) < 8 or not data.startswith(PNG_MAGIC):
        return
    pos = 8
    n = len(data)
    while pos + 8 <= n:
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        if pos + 12 + length > n:
            break
        chunk = data[pos + 8 : pos + 8 + length]
        if ctype == b"tEXt":
            key, _, val = chunk.partition(b"\x00")
            yield key.decode("latin-1"), val
        pos += 12 + length


def _decode_card_b64(text: bytes):
    s = text.decode("latin-1").strip()
    if s.startswith("data:") and "," in s:
        s = s.split(",", 1)[1]
    pad = "=" * (-len(s) % 4)
    return json.loads(base64.b64decode(s + pad))


def extract_card_from_png(path: str) -> Optional[dict]:
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    card = None
    for key, val in _png_text_chunks(data):
        if key in ("chara", "ccv3"):
            try:
                c = _decode_card_b64(val)
            except Exception:
                continue
            if isinstance(c, dict):
                card = c
    return card


def normalize_card(card: dict) -> dict:
    """Return the inner `data` dict for V2/V3 cards, or the card itself for V1."""
    if isinstance(card.get("data"), dict):
        return card["data"]
    return card


@dataclass
class Card:
    avatar: str  # file stem, matches chats/ folder name
    file: str  # file name inside characters/
    name: str
    creator_notes: str = ""
    creator: str = ""
    tags: list = field(default_factory=list)
    character_version: str = ""
    spec_version: str = ""
    has_card: bool = True
    size: int = 0
    texts: dict = field(default_factory=dict)  # field name -> text, for card search

    def to_api(self) -> dict:
        return {
            "avatar": self.avatar,
            "file": self.file,
            "name": self.name,
            "creator_notes": self.creator_notes,
            "creator": self.creator,
            "tags": self.tags,
            "character_version": self.character_version,
            "spec_version": self.spec_version,
            "has_card": self.has_card,
        }


@dataclass
class ChatInfo:
    avatar: str
    file: str  # file name inside chats/<avatar>/
    base_name: str  # chat name with branch suffix stripped
    branch_no: Optional[int]  # None if not a branch
    size: int = 0
    mtime: float = 0.0
    msgs: int = 0
    user_msgs: int = 0
    ai_msgs: int = 0
    swipes: int = 0  # total swipe texts (messages without swipes count as 1)
    hidden_swipes: int = 0  # swipes other than the selected one
    reasoning_count: int = 0
    first_date: str = ""
    last_date: str = ""
    models: set = field(default_factory=set)
    error: str = ""

    @property
    def is_branch(self) -> bool:
        return self.branch_no is not None

    def to_api(self) -> dict:
        return {
            "avatar": self.avatar,
            "file": self.file,
            "base_name": self.base_name,
            "branch_no": self.branch_no,
            "is_branch": self.is_branch,
            "size": self.size,
            "msgs": self.msgs,
            "user_msgs": self.user_msgs,
            "ai_msgs": self.ai_msgs,
            "swipes": self.swipes,
            "hidden_swipes": self.hidden_swipes,
            "reasoning_count": self.reasoning_count,
            "first_date": self.first_date,
            "last_date": self.last_date,
            "models": sorted(self.models),
            "error": self.error,
        }


def parse_branch_name(stem: str):
    m = BRANCH_RE.match(stem)
    if m:
        return m.group(1), int(m.group(2))
    return stem, None


def iter_message_dicts(path: str):
    """Yield (line_index, message_dict); line 0 header excluded. Tolerates bad lines."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        raise IOError(str(e))
    for i, line in enumerate(raw.split(b"\n")):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if i == 0 and isinstance(obj, dict) and "chat_metadata" in obj:
            continue  # header line, not a message
        if isinstance(obj, dict) and "mes" in obj:
            yield obj


def chat_stats(path: str, avatar: str, fname: str) -> ChatInfo:
    stem = os.path.splitext(fname)[0]
    base_name, branch_no = parse_branch_name(stem)
    info = ChatInfo(
        avatar=avatar,
        file=fname,
        base_name=base_name,
        branch_no=branch_no,
        size=os.stat(path).st_size,
        mtime=os.stat(path).st_mtime,
    )
    first_date = ""
    last_date = ""
    try:
        for obj in iter_message_dicts(path):
            info.msgs += 1
            if obj.get("is_user"):
                info.user_msgs += 1
            else:
                info.ai_msgs += 1
            sd = str(obj.get("send_date") or "")
            if sd:
                if not first_date:
                    first_date = sd
                last_date = sd
            swipes = obj.get("swipes")
            if isinstance(swipes, list) and swipes:
                info.swipes += len(swipes)
                info.hidden_swipes += max(len(swipes) - 1, 0)
                for sinfo in obj.get("swipe_info") or []:
                    if isinstance(sinfo, dict):
                        ex = sinfo.get("extra") or {}
                        if isinstance(ex, dict):
                            if ex.get("model"):
                                info.models.add(str(ex["model"]))
                            if ex.get("reasoning"):
                                info.reasoning_count += 1
            else:
                info.swipes += 1
            ex = obj.get("extra") or {}
            if isinstance(ex, dict):
                if ex.get("model"):
                    info.models.add(str(ex["model"]))
                if ex.get("reasoning"):
                    info.reasoning_count += 1
    except IOError as e:
        info.error = str(e)
    info.first_date = first_date
    info.last_date = last_date
    return info


class Index:
    def __init__(self, data_root: str):
        self.data_root = data_root
        self.characters_dir = os.path.join(data_root, "characters")
        self.chats_dir = os.path.join(data_root, "chats")
        self.cards: dict[str, Card] = {}
        self.chats: dict[str, list[ChatInfo]] = {}
        self.avatar_dir: dict[str, str] = {}
        self.progress = {"done": 0, "total": 0, "phase": "idle", "ready": False}
        self._lock = threading.Lock()

    # -- building ---------------------------------------------------------

    def build(self):
        t0 = time.time()
        with self._lock:
            self.progress.update(phase="scanning characters", ready=False, done=0, total=0)
        self._scan_characters()
        with self._lock:
            self.progress.update(phase="scanning chats")
        self._scan_chats()
        with self._lock:
            self.progress.update(phase="ready", ready=True)
        self.build_seconds = time.time() - t0

    def _scan_characters(self):
        self.cards = {}
        if not os.path.isdir(self.characters_dir):
            return
        for fn in sorted(os.listdir(self.characters_dir)):
            path = os.path.join(self.characters_dir, fn)
            if not os.path.isfile(path):
                continue
            stem, ext = os.path.splitext(fn)
            ext = ext.lower()
            card_raw = None
            if ext == ".png":
                card_raw = extract_card_from_png(path)
            elif ext == ".json":
                try:
                    with open(path, encoding="utf-8") as f:
                        card_raw = json.loads(f.read())
                except Exception:
                    card_raw = None
            if card_raw is None:
                card = Card(
                    avatar=stem, file=fn, name=stem, has_card=False,
                    size=os.stat(path).st_size,
                )
            else:
                d = normalize_card(card_raw)
                card = Card(
                    avatar=stem,
                    file=fn,
                    name=str(d.get("name") or stem),
                    creator_notes=str(d.get("creator_notes") or ""),
                    creator=str(d.get("creator") or ""),
                    tags=[str(t) for t in (d.get("tags") or [])] if isinstance(d.get("tags"), list) else [],
                    character_version=str(d.get("character_version") or ""),
                    spec_version=str(d.get("spec_version") or card_raw.get("spec_version") or ""),
                    size=os.stat(path).st_size,
                )
                for fld in CARD_TEXT_FIELDS:
                    v = d.get(fld)
                    if isinstance(v, str) and v.strip():
                        card.texts[fld] = v
                ag = d.get("alternate_greetings")
                if isinstance(ag, list):
                    texts = [g for g in ag if isinstance(g, str) and g.strip()]
                    if texts:
                        card.texts["alternate_greetings"] = "\n\n---\n\n".join(texts)
            self.cards[stem] = card

    def _scan_chats(self):
        self.chats = {}
        self.avatar_dir = {}
        if not os.path.isdir(self.chats_dir):
            return
        chat_files = []
        for folder in sorted(os.listdir(self.chats_dir)):
            fdir = os.path.join(self.chats_dir, folder)
            if not os.path.isdir(fdir):
                continue
            self.avatar_dir[folder] = fdir
            for fn in sorted(os.listdir(fdir)):
                if fn.endswith(".jsonl") and os.path.isfile(os.path.join(fdir, fn)):
                    chat_files.append((folder, fn, os.path.join(fdir, fn)))
        with self._lock:
            self.progress["total"] = len(chat_files)
        for i, (folder, fn, path) in enumerate(chat_files):
            info = chat_stats(path, folder, fn)
            self.chats.setdefault(folder, []).append(info)
            with self._lock:
                self.progress["done"] = i + 1

    # -- accessors --------------------------------------------------------

    def status(self) -> dict:
        with self._lock:
            p = dict(self.progress)
        total_msgs = sum(c.msgs for lst in self.chats.values() for c in lst)
        total_chats = sum(len(v) for v in self.chats.values())
        total_size = sum(c.size for lst in self.chats.values() for c in lst)
        total_swipes = sum(c.swipes for lst in self.chats.values() for c in lst)
        total_hidden = sum(c.hidden_swipes for lst in self.chats.values() for c in lst)
        total_reasoning = sum(c.reasoning_count for lst in self.chats.values() for c in lst)
        models = set()
        for lst in self.chats.values():
            for c in lst:
                models.update(c.models)
        return {
            **p,
            "data_root": self.data_root,
            "characters": len(self.cards),
            "chats": total_chats,
            "messages": total_msgs,
            "swipes": total_swipes,
            "hidden_swipes": total_hidden,
            "reasoning": total_reasoning,
            "bytes": total_size,
            "models": sorted(models),
            "build_seconds": round(getattr(self, "build_seconds", 0.0), 2),
        }

    def chat_path(self, avatar: str, fname: str) -> Optional[str]:
        fdir = self.avatar_dir.get(avatar)
        if not fdir:
            return None
        path = os.path.join(fdir, fname)
        # path safety: no separators or traversal in fname
        if os.path.sep in fname or fname in ("", ".", "..") or "/" in fname:
            return None
        if not os.path.isfile(path):
            return None
        return path

    def find_chat(self, avatar: str, fname: str) -> Optional[ChatInfo]:
        for c in self.chats.get(avatar, []):
            if c.file == fname:
                return c
        return None

    def groups(self) -> list:
        """Characters grouped by card name; orphans grouped by folder name."""
        by_name: dict[str, list[Card]] = {}
        for card in self.cards.values():
            by_name.setdefault(card.name, []).append(card)
        for folder in self.chats:
            if folder not in self.cards:
                by_name.setdefault(folder, []).append(
                    Card(avatar=folder, file="", name=folder, has_card=False)
                )
        out = []
        for name in sorted(by_name, key=str.lower):
            variants = sorted(by_name[name], key=lambda c: c.avatar.lower())
            out.append({
                "name": name,
                "variants": [
                    {
                        **v.to_api(),
                        "chat_count": len(self.chats.get(v.avatar, [])),
                        "msg_count": sum(c.msgs for c in self.chats.get(v.avatar, [])),
                    }
                    for v in variants
                ],
            })
        return out

    def all_models(self) -> list:
        models = set()
        for lst in self.chats.values():
            for c in lst:
                models.update(c.models)
        return sorted(models)


def classify_message(obj: dict):
    """Return pieces of a message with visibility labels.

    Returns (role, pieces) where pieces is a list of
    (kind, swipe_index, model, text):
      kind in {"visible", "swipe", "reasoning"}
    """
    role = "user" if obj.get("is_user") else "ai"
    mes = obj.get("mes")
    if not isinstance(mes, str):
        mes = ""
    ex = obj.get("extra") or {}
    ex_model = str(ex.get("model") or "") if isinstance(ex, dict) else ""
    pieces = []
    pieces.append(("visible", None, ex_model, mes))
    swipes = obj.get("swipes")
    if isinstance(swipes, list) and swipes:
        sid = obj.get("swipe_id", 0)
        if not isinstance(sid, int) or not (0 <= sid < len(swipes)):
            sid = 0
        sinfo = obj.get("swipe_info") or []
        for i, sw in enumerate(swipes):
            if not isinstance(sw, str):
                continue
            if i == sid:
                if sw != mes:
                    pieces.append(("swipe", i, ex_model, sw))
                # identical to mes: already indexed, skip duplicate
            else:
                model = ex_model
                si = sinfo[i] if isinstance(sinfo, list) and i < len(sinfo) and isinstance(sinfo[i], dict) else {}
                siex = si.get("extra") or {}
                if isinstance(siex, dict) and siex.get("model"):
                    model = str(siex["model"])
                pieces.append(("swipe", i, model, sw))
        for i, si in enumerate(sinfo if isinstance(sinfo, list) else []):
            if not isinstance(si, dict):
                continue
            siex = si.get("extra") or {}
            r = siex.get("reasoning") if isinstance(siex, dict) else None
            if isinstance(r, str) and r.strip():
                model = str(siex.get("model") or ex_model)
                pieces.append(("reasoning", i, model, r))
    if isinstance(ex, dict):
        r = ex.get("reasoning")
        if isinstance(r, str) and r.strip():
            # message-level reasoning mirrors the selected swipe; only add if
            # not already captured via swipe_info
            sinfo = obj.get("swipe_info") or []
            sid = obj.get("swipe_id", 0)
            si = sinfo[sid] if isinstance(sinfo, list) and sid < len(sinfo) and isinstance(sinfo[sid], dict) else {}
            siex = si.get("extra") or {}
            dup = isinstance(siex, dict) and siex.get("reasoning") == r
            if not dup:
                pieces.append(("reasoning", None, ex_model, r))
    return role, pieces
