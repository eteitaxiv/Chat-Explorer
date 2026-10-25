# ST Chat Explorer

A fast, read-only web app for browsing and searching SillyTavern characters and
chats — built for large archives where SillyTavern's own search is too slow and
too shallow.

It mounts your SillyTavern character folder **read-only** into a Docker container;
the chats folder can be mounted read-only too (the app is then a pure viewer) or
writable, which additionally enables the built-in Cleaner.

## Why

SillyTavern's built-in search only looks at the visible text of the currently
loaded chat. Everything else — the swipes you swiped away, the model's
reasoning traces, your branch files, character cards, chats from months ago —
is effectively invisible. On top of that, it can only search one chat at a
time, which makes finding "that one conversation where she mentioned X"
practically impossible.

ST Chat Explorer indexes the whole archive once at startup (a 700 MB archive
takes roughly 10-30 seconds), then searches everything in a fraction of a
second:

- **Visible main line** — the swipe you actually kept on each message
- **Hidden swipes** — every alternative you swiped away
- **Reasoning traces** — what the model actually thought
- **Branch files** — the full copies ST makes when you branch a chat
- **Chat names and character cards** — descriptions, personalities,
  scenarios, greetings, creator's notes, everything on the card

## Run it

```bash
# point the volumes at your ST characters/ and chats/ folders
docker compose up -d --build
```

Then open http://localhost:10008. Replace `./characters` and `./chats` in
`docker-compose.yml` with your SillyTavern paths, e.g.:

```yaml
    volumes:
      - /home/you/SillyTavern/data/default-user/characters:/data/characters:ro
      - /home/you/SillyTavern/data/default-user/chats:/data/chats
```

No Docker? Local dev works the same way:

```bash
pip install -r requirements.txt
DATA_ROOT=/path/to/st/data python -m uvicorn app.main:app --port 8000
```

The first start indexes the archive; afterwards everything is instant. A
**Reindex** button in the top bar rescans the folder without restarting, so
new chats show up without taking the app down.

### Cleaner (optional)

If the `chats/` mount is writable by the container user, a **Cleaner** button
appears in the top bar. It prunes old branch files (keeping the N most recently
modified per chat), strips model reasoning traces, and drops unused swipes.
Everything is previewed as a dry-run first; nothing is touched until you press
Apply. If the mount is read-only (or the container user can't write to it), the
Cleaner stays hidden and its API returns 403 — the app remains a pure viewer.

For the Cleaner to work, set `user:` in `docker-compose.yml` to the `uid:gid`
that owns your SillyTavern chats folder on the host (check with `id -u` / `id -g`,
e.g. `1000:1000`). Nothing is hardcoded, so `0:0` or `100999:100999` work too —
whatever matches your SillyTavern setup.

## What it shows

- **Characters grouped by name.** When several card files share the same
  internal name (your `Aria_1`, `Aria` style duplicates), each variant is
  listed with its **Creator's Notes** underneath — the way you tell them apart.
- **Chats under each character**, including branch files, with message counts,
  swipe counts, reasoning trace counts, date ranges and file sizes. Sort by
  name, recently updated, most messages or largest.
- **Recently updated chats** right on the home screen — jump back into
  whatever you were last writing.
- **The full chat viewer**: every message with all its swipes (the selected
  one marked, the alternatives you swiped away included), per-swipe reasoning
  traces, model names, and a find-in-chat bar.
- **Full character cards**, rendered field by field, with a one-click download
  of the original card file (PNG or JSON).

## Search

Two entry points: the global bar in the top bar (press `/` to focus it), and
the "Search within <character>" box on a character's page.

Search options cover every layer of the archive:

| Option | Meaning |
|---|---|
| Everywhere | Visible text plus every hidden swipe |
| Visible main line only | Only the swipe you actually kept on each message |
| Hidden swipes only | Only the alternatives you swiped away |
| Reasoning traces only | Only the model's reasoning output |
| Branches: include / exclude / only | Branch files are full copies ST makes when you branch a chat; search them or skip them |
| Role | User messages vs AI messages |
| Model | Restrict to one model (the archive records which model wrote each message) |
| Match case / whole word / regex | Text matching modes |
| Also search chat names / character cards | Covers chat file names and card fields (description, personality, scenario, greetings, creator's notes, ...) |
| From / To date | Filters by message send date |

Results are grouped by character and chat, with highlighted snippets. Click a
hit to jump straight to that message in the viewer — including into the exact
hidden swipe or reasoning trace it was found in, with the panel opened for you.

Messages that your summary-injection extension ghosted out of context are
ordinary user/assistant messages and are always searched normally.

## Downloads

- Per chat: the **Download** button serves the original file unchanged
  (byte-for-byte identical, same file name, `.jsonl`).
- Multi-select chats in a character's list and grab them as a zip, or download
  every chat of a character in one zip. The zip keeps `character-name/file.jsonl`
  structure; extract and import into SillyTavern as usual.
- Character cards download in their original format (PNG card stays a valid
  PNG card, JSON stays JSON).

## Notes

- Only `characters/` and `chats/` inside the mounted folder are read. Cards are
  read from PNG `tEXt` chunks (`chara` / `ccv3`); plain JSON cards are supported
  too. Group chats (`chats/<group>/...`) appear as ordinary characters with a
  "no card" badge if no matching card file exists.
- The app is read-only by design unless you deliberately mount `chats/` writable:
the only writes are the Cleaner's (explicitly applied by you) and the zip you
ask for. With a read-only mount, no code path can write anything. It never
phones home — everything runs locally.
- Corrupt lines and malformed files in wild archives are tolerated and flagged
  with an `error` badge rather than breaking the index.
