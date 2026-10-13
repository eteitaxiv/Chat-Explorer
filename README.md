# ST Chat Explorer

A read-only web app for browsing and searching SillyTavern characters and chats,
built for large archives where SillyTavern's own search is too slow and too shallow.

It mounts your SillyTavern data folder **read-only** into a Docker container and
never writes a single byte to it. Chats download byte-for-byte in their native
`.jsonl` format, ready to import straight back into SillyTavern.

## Run it

```bash
# point the volumes at your ST characters/ and chats/ folders
docker compose up -d --build
```

Then open http://localhost:8000. Replace `./characters` and `./chats` in
`docker-compose.yml` with your SillyTavern paths, e.g.:

```yaml
    volumes:
      - /home/you/SillyTavern/data/default-user/characters:/data/characters:ro
      - /home/you/SillyTavern/data/default-user/chats:/data/chats:ro
```

The first start indexes the archive (a 700 MB archive takes roughly 10-30
seconds); afterwards everything is instant.

## What it shows

- **Characters grouped by name.** When several card files share the same
  internal name (your `Aria_1`, `Aria` style duplicates), each variant is
  listed with its **Creator's Notes** underneath - the way you tell them apart.
- **Chats under each character**, including branch files, with message counts,
  swipe counts, reasoning trace counts, date ranges and file sizes.
- **The full chat viewer**: every message with all its swipes (the selected one
  marked, the alternatives you swiped away included), per-swipe reasoning
  traces, model names, and a find-in-chat bar.

## Search

Two entry points: the global bar in the top bar, and the "Search within
<character>" box on a character's page.

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
hit to jump straight to that message in the viewer.

Messages that your summary-injection extension ghosted out of context are
ordinary user/assistant messages and are always searched normally.

## Downloads

- Per chat: the **Download** button serves the original file unchanged
  (byte-for-byte identical, same file name, `.jsonl`).
- Multi-select chats in a character's list and grab them as a zip, or download
  every chat of a character in one zip. The zip keeps `character-name/file.jsonl`
  structure; extract and import into SillyTavern as usual.

## Notes

- Only `characters/` and `chats/` inside the mounted folder are read. Cards are
  read from PNG `tEXt` chunks (`chara` / `ccv3`); plain JSON cards are supported
  too. Group chats (`chats/<group>/...`) appear as ordinary characters with a
  "no card" badge if no matching card file exists.
- The app is read-only by design: the mount is `:ro`, and the code opens nothing
  under the data root for writing. The only output it produces is the zip you
  explicitly ask for.
