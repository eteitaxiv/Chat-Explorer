"""Byte-level search engine over the chat archive.

Strategy: per query, every candidate file is read once as raw bytes and
checked for a cheap needle presence (C-speed byte find / regex). Only files
that pass the prefilter get their matching lines parsed as JSON; matching
itself always runs on decoded message text, so JSON escaping never produces
false positives, and prefilter variants make sure escaped text is not missed.
"""
from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from typing import Optional

from .stindex import Index, classify_message, iter_message_dicts

SCOPES = ("all", "visible", "hidden", "reasoning")
TARGETS = ("messages", "chats", "cards")

MAX_SNIPPETS_PER_PIECE = 3
SNIPPET_RADIUS = 130


@dataclass
class SearchOptions:
    q: str
    scope: str = "all"
    targets: tuple = ("messages",)
    branches: str = "all"  # all | exclude | only
    case_sensitive: bool = False
    whole_word: bool = False
    regex: bool = False
    avatar: Optional[str] = None  # pin search to one character folder
    role: str = "any"  # any | user | ai
    model: str = ""  # exact model name, "" = any
    date_from: str = ""  # ISO prefix, inclusive
    date_to: str = ""
    limit: int = 1000
    per_chat: int = 40


def _needle_variants(q: str) -> list[bytes]:
    """Byte strings to look for in raw file bytes (JSON-escaped variants included)."""
    variants = [q]
    if any(ch in q for ch in '\\"\n\r\t'):
        escaped = q.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t")
        variants.append(escaped)
        # ST stores newlines as \r\n escape pairs
        variants.append(escaped.replace("\\n", "\\r\\n"))
    return [v.encode("utf-8") for v in variants]


class Matcher:
    """Finds matches of the query in decoded (str) text."""

    def __init__(self, opts: SearchOptions):
        self.opts = opts
        q = opts.q
        self.re = None
        if opts.regex:
            flags = 0 if opts.case_sensitive else re.IGNORECASE
            self.re = re.compile(q, flags)
        elif opts.whole_word:
            flags = 0 if opts.case_sensitive else re.IGNORECASE
            self.re = re.compile(r"\b" + re.escape(q) + r"\b", flags)
        self._ci_needle = q.lower() if not opts.case_sensitive else None

    def find(self, text: str) -> list[tuple[int, int]]:
        """Return (start, end) spans of matches in text."""
        if self.re is not None:
            return [m.span() for m in self.re.finditer(text)]
        if self._ci_needle is not None:
            out = []
            hay = text.lower()
            n = len(self._ci_needle)
            pos = hay.find(self._ci_needle)
            while pos != -1:
                out.append((pos, pos + n))
                pos = hay.find(self._ci_needle, pos + n)
            return out
        out = []
        pos = text.find(self.opts.q)
        n = len(self.opts.q)
        while pos != -1:
            out.append((pos, pos + n))
            pos = text.find(self.opts.q, pos + n)
        return out


class BytePrefilter:
    """Fast needle-presence check over raw file bytes."""

    def __init__(self, opts: SearchOptions):
        self.regex = opts.regex
        self.case = opts.case_sensitive
        if self.regex:
            flags = 0 if self.case else re.IGNORECASE
            self.pat = re.compile(opts.q.encode("utf-8"), flags)
        elif opts.whole_word:
            flags = 0 if self.case else re.IGNORECASE
            self.pat = re.compile(rb"\b" + re.escape(opts.q.encode("utf-8")) + rb"\b", flags)
        else:
            self.pat = None
            self.needles = _needle_variants(opts.q)
            if not self.case:
                self.needles = [n.lower() for n in self.needles]

    def any_match(self, data: bytes) -> bool:
        if self.pat is not None:
            return self.pat.search(data) is not None
        hay = data if self.case else data.lower()
        for n in self.needles:
            if n and n in hay:
                return True
        return False


def make_snippets(text: str, spans: list[tuple[int, int]]) -> list[dict]:
    """Build HTML snippets with <mark> highlights around match spans."""
    if not spans:
        return []
    # merge spans that are close together
    merged = []
    for s, e in spans:
        if merged and s - merged[-1][1] < 60:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    merged = merged[:MAX_SNIPPETS_PER_PIECE]
    snippets = []
    for s, e in merged:
        a = max(0, s - SNIPPET_RADIUS)
        b = min(len(text), e + SNIPPET_RADIUS)
        prefix = "\u2026" if a > 0 else ""
        suffix = "\u2026" if b < len(text) else ""
        window = text[a:b]
        # re-locate spans within window
        parts = []
        cur = 0
        for ms, me in spans:
            ms2, me2 = ms - a, me - a
            if me2 <= 0 or ms2 >= len(window):
                continue
            ms2 = max(0, ms2)
            me2 = min(len(window), me2)
            if ms2 < cur:
                continue
            parts.append(html.escape(window[cur:ms2]))
            parts.append("<mark>" + html.escape(window[ms2:me2]) + "</mark>")
            cur = me2
        parts.append(html.escape(window[cur:]))
        snippets.append({"html": prefix + "".join(parts) + suffix})
    return snippets


@dataclass
class ChatResults:
    avatar: str
    file: str
    base_name: str
    branch_no: Optional[int]
    hits: list = field(default_factory=list)
    total_hits: int = 0
    more: bool = False


def search_messages(index: Index, opts: SearchOptions, matcher: Matcher, prefilter: BytePrefilter):
    """Scan chat files. Returns (chat_results, total_hits, truncated, files_scanned)."""
    results: list[ChatResults] = []
    total_hits = 0
    files_scanned = 0
    truncated = False

    avatars = [opts.avatar] if opts.avatar else sorted(index.chats.keys())
    for avatar in avatars:
        chats = index.chats.get(avatar)
        if not chats:
            continue
        for info in chats:
            if opts.branches == "exclude" and info.is_branch:
                continue
            if opts.branches == "only" and not info.is_branch:
                continue
            if opts.model and opts.model not in info.models:
                continue
            path = index.chat_path(avatar, info.file)
            if not path:
                continue
            files_scanned += 1
            try:
                with open(path, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            if not prefilter.any_match(data):
                continue
            msg_idx = -1
            chat_res = None
            for raw_line in data.split(b"\n"):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if not isinstance(obj, dict) or "mes" not in obj:
                    continue
                msg_idx += 1
                role, pieces = classify_message(obj)
                if opts.role != "any" and role != opts.role:
                    continue
                sd = str(obj.get("send_date") or "")
                if opts.date_from and sd < opts.date_from:
                    continue
                if opts.date_to and sd > opts.date_to:
                    continue
                name = str(obj.get("name") or ("You" if role == "user" else ""))
                for kind, swipe_i, model, text in pieces:
                    if opts.scope == "visible" and kind != "visible":
                        continue
                    if opts.scope == "hidden" and kind != "swipe":
                        continue
                    if opts.scope == "reasoning" and kind != "reasoning":
                        continue
                    if opts.scope == "all" and kind not in ("visible", "swipe"):
                        continue
                    if opts.model and model != opts.model:
                        continue
                    spans = matcher.find(text)
                    if not spans:
                        continue
                    if chat_res is None:
                        chat_res = ChatResults(
                            avatar=avatar, file=info.file,
                            base_name=info.base_name, branch_no=info.branch_no,
                        )
                    if len(chat_res.hits) < opts.per_chat:
                        chat_res.hits.append({
                            "msg_index": msg_idx,
                            "name": name,
                            "role": role,
                            "date": sd,
                            "kind": kind,
                            "swipe_index": swipe_i,
                            "model": model,
                            "swipe_count": len(obj.get("swipes") or []),
                            "snippets": make_snippets(text, spans),
                            "count": len(spans),
                        })
                    chat_res.total_hits += len(spans)
                    total_hits += len(spans)
                    if total_hits >= opts.limit:
                        truncated = True
            if chat_res is not None:
                results.append(chat_res)
                if truncated:
                    break
        if truncated:
            break
    return results, total_hits, truncated, files_scanned


def search_chat_names(index: Index, opts: SearchOptions, matcher: Matcher):
    """Match chat base names / file names. Returns list of matches."""
    out = []
    avatars = [opts.avatar] if opts.avatar else sorted(index.chats.keys())
    for avatar in avatars:
        for info in index.chats.get(avatar, []):
            if opts.branches == "exclude" and info.is_branch:
                continue
            if opts.branches == "only" and not info.is_branch:
                continue
            for field_name, text in (("name", info.base_name), ("file", info.file)):
                spans = matcher.find(text)
                if spans:
                    out.append({
                        "avatar": avatar,
                        "file": info.file,
                        "base_name": info.base_name,
                        "branch_no": info.branch_no,
                        "msgs": info.msgs,
                        "last_date": info.last_date,
                        "field": field_name,
                        "snippets": make_snippets(text, spans),
                    })
    return out


def search_cards(index: Index, opts: SearchOptions, matcher: Matcher):
    """Match character card fields. Returns list of matches."""
    out = []
    avatars = [opts.avatar] if opts.avatar else sorted(index.cards.keys())
    for avatar in avatars:
        card = index.cards.get(avatar)
        if card is None or not card.has_card:
            continue
        for fld, text in card.texts.items():
            spans = matcher.find(text)
            if spans:
                out.append({
                    "avatar": avatar,
                    "name": card.name,
                    "creator_notes": card.creator_notes,
                    "field": fld,
                    "snippets": make_snippets(text, spans),
                    "count": len(spans),
                })
    return out


def run_search(index: Index, opts: SearchOptions) -> dict:
    if not opts.q:
        return {"totals": {}, "groups": [], "chat_names": [], "cards": []}
    try:
        matcher = Matcher(opts)
        prefilter = BytePrefilter(opts)
    except re.error as e:
        raise ValueError(f"invalid regex: {e}")
    resp = {
        "totals": {"hits": 0, "chats": 0, "files_scanned": 0, "truncated": False},
        "groups": [],
        "chat_names": [],
        "cards": [],
    }
    if "messages" in opts.targets:
        try:
            results, total, truncated, scanned = search_messages(index, opts, matcher, prefilter)
        except re.error as e:
            raise ValueError(f"invalid regex: {e}")
        resp["totals"].update({"hits": total, "chats": len(results), "files_scanned": scanned, "truncated": truncated})
        # group by character
        by_avatar: dict[str, list[ChatResults]] = {}
        for r in results:
            by_avatar.setdefault(r.avatar, []).append(r)
        card_of = {}
        for avatar, lst in by_avatar.items():
            card = index.cards.get(avatar)
            card_of[avatar] = card.name if card and card.has_card else avatar
            lst.sort(key=lambda c: -c.total_hits)
            for c in lst:
                c.more = c.total_hits > len(c.hits)
        groups = [
            {
                "avatar": avatar,
                "name": card_of[avatar],
                "creator_notes": (index.cards[avatar].creator_notes if avatar in index.cards and index.cards[avatar].has_card else ""),
                "chats": [
                    {
                        "file": c.file,
                        "base_name": c.base_name,
                        "branch_no": c.branch_no,
                        "is_branch": c.branch_no is not None,
                        "total_hits": c.total_hits,
                        "more": c.more,
                        "hits": c.hits,
                    }
                    for c in lst
                ],
                "total_hits": sum(c.total_hits for c in lst),
            }
            for avatar, lst in by_avatar.items()
        ]
        groups.sort(key=lambda g: -g["total_hits"])
        resp["groups"] = groups
    if "chats" in opts.targets:
        resp["chat_names"] = search_chat_names(index, opts, matcher)
    if "cards" in opts.targets:
        resp["cards"] = search_cards(index, opts, matcher)
    return resp


def parse_chat_full(path: str) -> list[dict]:
    """Parse a chat file for the viewer (all swipes + reasoning included)."""
    msgs = []
    for i, obj in enumerate(iter_message_dicts(path)):
        ex = obj.get("extra") or {}
        ex = ex if isinstance(ex, dict) else {}
        swipes = [s for s in (obj.get("swipes") or []) if isinstance(s, str)]
        sid = obj.get("swipe_id", 0)
        if not isinstance(sid, int) or not (0 <= sid < len(swipes)):
            sid = 0
        sinfo = [s for s in (obj.get("swipe_info") or []) if isinstance(s, dict)]
        swipe_meta = []
        for j, si in enumerate(sinfo):
            siex = si.get("extra") or {}
            siex = siex if isinstance(siex, dict) else {}
            swipe_meta.append({
                "date": str(si.get("send_date") or ""),
                "gen_started": str(si.get("gen_started") or ""),
                "gen_finished": str(si.get("gen_finished") or ""),
                "model": str(siex.get("model") or ""),
                "reasoning": str(siex.get("reasoning") or ""),
            })
        msgs.append({
            "idx": i,
            "name": str(obj.get("name") or ""),
            "is_user": bool(obj.get("is_user")),
            "date": str(obj.get("send_date") or ""),
            "mes": str(obj.get("mes") or ""),
            "model": str(ex.get("model") or ""),
            "reasoning": str(ex.get("reasoning") or ""),
            "token_count": ex.get("token_count") if isinstance(ex.get("token_count"), (int, float)) else None,
            "swipe_id": sid,
            "swipes": swipes,
            "swipe_meta": swipe_meta,
        })
    return msgs
