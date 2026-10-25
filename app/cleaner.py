"""SillyTavern chat cleanup: prune branch files, strip reasoning, drop unused swipes.

Port of the standalone st-cleaner.py script, reworked to run on top of the
in-memory index instead of rescanning the disk. Only ever touches files under
``chats/``; the routes in main.py only expose this when the chats mount is
writable.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Optional

from .stindex import Index

REASONING_KEYS = ("reasoning", "reasoning_duration", "reasoning_signature", "reasoning_type")
DEFAULT_MIN_FOLDER_MB = 25.0
DEFAULT_KEEP_RECENT = 20
ALL_ACTIONS = ("branches", "reasoning", "swipes")


@dataclass
class CleanOptions:
    actions: set = field(default_factory=lambda: set(ALL_ACTIONS))
    min_folder_mb: float = DEFAULT_MIN_FOLDER_MB
    keep_recent: int = DEFAULT_KEEP_RECENT
    skip_names: set = field(default_factory=set)


def parse_options(
    actions: str = "",
    min_folder_mb: float = DEFAULT_MIN_FOLDER_MB,
    keep_recent: int = DEFAULT_KEEP_RECENT,
    skip_names: str = "",
) -> CleanOptions:
    acts = {a.strip().lower() for a in (actions or ",".join(ALL_ACTIONS)).split(",") if a.strip()}
    bad = acts - set(ALL_ACTIONS)
    if bad:
        raise ValueError(f"unknown actions: {', '.join(sorted(bad))}")
    if min_folder_mb < 0:
        raise ValueError("min_folder_mb must be >= 0")
    if keep_recent < 0:
        raise ValueError("keep_recent must be >= 0")
    return CleanOptions(
        actions=acts or set(ALL_ACTIONS),
        min_folder_mb=min_folder_mb,
        keep_recent=keep_recent,
        skip_names={s.strip() for s in skip_names.split(",") if s.strip()},
    )


def _strip_reasoning(extra) -> bool:
    if not isinstance(extra, dict):
        return False
    removed = False
    for key in REASONING_KEYS:
        if key in extra:
            extra.pop(key, None)
            removed = True
    return removed


def clean_file(path: str, actions: set, apply: bool) -> dict:
    """Strip reasoning / unused swipes from one .jsonl file.

    Returns {"saved": bytes, "modified": bool, "error": str|None}.
    Measures savings exactly as original size minus post-rewrite size.
    """
    stats = {"saved": 0, "modified": False, "error": None}
    if "reasoning" not in actions and "swipes" not in actions:
        return stats
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        stats["error"] = str(e)
        return stats
    orig_size = len(raw)
    out: list[bytes] = []
    changed = False
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except Exception:
            out.append(line)
            continue
        if not isinstance(msg, dict):
            out.append(line)
            continue
        if "reasoning" in actions:
            if _strip_reasoning(msg.get("extra")):
                changed = True
            for si in msg.get("swipe_info") or []:
                if isinstance(si, dict) and _strip_reasoning(si.get("extra")):
                    changed = True
        if "swipes" in actions and isinstance(msg.get("swipes"), list):
            swipes = msg["swipes"]
            swipe_info = msg.get("swipe_info")
            swipe_id = msg.get("swipe_id", 0)
            if not isinstance(swipe_id, int) or not (0 <= swipe_id < len(swipes)):
                swipe_id = 0
            if len(swipes) > 1:
                changed = True
                msg["swipes"] = [swipes[swipe_id]]
                if isinstance(swipe_info, list) and swipe_id < len(swipe_info):
                    msg["swipe_info"] = [swipe_info[swipe_id]]
                else:
                    msg["swipe_info"] = []
                msg["swipe_id"] = 0
        if changed:
            out.append(json.dumps(msg, ensure_ascii=False).encode("utf-8"))
        else:
            out.append(line)
    if not changed:
        return stats
    new_content = b"\n".join(out) + b"\n"
    stats["saved"] = max(orig_size - len(new_content), 0)
    stats["modified"] = True
    if apply:
        try:
            with open(path, "wb") as f:
                f.write(new_content)
        except OSError as e:
            stats["error"] = str(e)
            stats["saved"] = 0
    return stats


def clean_folder(index: Index, avatar: str, opts: CleanOptions, apply: bool) -> Optional[dict]:
    chats = index.chats.get(avatar, [])
    if not chats:
        return None
    folder_size = sum(c.size for c in chats)
    if folder_size < opts.min_folder_mb * 1024 * 1024:
        return None
    deleted = []
    cleaned = []
    freed = 0

    sessions: dict[str, list] = {}
    for c in chats:
        sessions.setdefault(c.base_name, []).append(c)

    for base, files in sorted(sessions.items()):
        if base in opts.skip_names:
            continue
        files = sorted(files, key=lambda c: c.mtime, reverse=True)
        branches = [c for c in files if c.is_branch]
        kept_files = {c.file for c in files}
        if "branches" in opts.actions and branches:
            kept_branches = branches[: opts.keep_recent]
            pruned = branches[opts.keep_recent:]
            kept_files = {c.file for c in kept_branches} | {c.file for c in files if not c.is_branch}
            for c in pruned:
                path = index.chat_path(avatar, c.file)
                if path and apply:
                    try:
                        os.remove(path)
                    except OSError as e:
                        cleaned.append({"file": c.file, "error": str(e)})
                        continue
                deleted.append({"file": c.file, "size": c.size})
                freed += c.size
        if "reasoning" in opts.actions or "swipes" in opts.actions:
            for c in files:
                if c.file not in kept_files:
                    continue
                path = index.chat_path(avatar, c.file)
                if not path:
                    continue
                r = clean_file(path, opts.actions, apply)
                if r.get("error"):
                    cleaned.append({"file": c.file, "error": r["error"]})
                elif r["modified"]:
                    cleaned.append({"file": c.file, "saved": r["saved"]})
                    freed += r["saved"]

    return {
        "avatar": avatar,
        "size": folder_size,
        "bytes_freed": freed,
        "deleted": deleted,
        "cleaned": cleaned,
        "files_deleted": len(deleted),
        "files_modified": sum(1 for c in cleaned if not c.get("error")),
        "errors": [c for c in cleaned if c.get("error")],
    }


def run(index: Index, opts: CleanOptions, apply: bool, writable: Optional[set] = None) -> dict:
    folders = []
    for avatar in sorted(index.chats):
        if writable is not None and avatar not in writable:
            continue
        rep = clean_folder(index, avatar, opts, apply)
        if rep:
            folders.append(rep)
    total_freed = sum(f["bytes_freed"] for f in folders)
    total_deleted = sum(f["files_deleted"] for f in folders)
    total_modified = sum(f["files_modified"] for f in folders)
    return {
        "applied": apply,
        "folders": folders,
        "totals": {
            "bytes_freed": total_freed,
            "files_deleted": total_deleted,
            "files_modified": total_modified,
            "folders": len(folders),
        },
    }
