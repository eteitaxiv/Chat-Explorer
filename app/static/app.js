/* ST Chat Explorer frontend */
"use strict";

const $ = (sel) => document.querySelector(sel);
const view = () => $("#view");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let detail = r.statusText;
    try { const j = await r.json(); if (j.detail) detail = j.detail; } catch (e) {}
    throw new Error(detail);
  }
  return r.json();
}

function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

function fmtInt(n) { return (n ?? 0).toLocaleString("en-US"); }

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString("en-GB", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtDay(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
}

function tsOf(dateStr) {
  if (!dateStr) return 0;
  const t = Date.parse(dateStr);
  return isNaN(t) ? 0 : t;
}

function markText(htmlEscapedText, q) {
  if (!q) return htmlEscapedText;
  if (S.lastSearchOpts && S.lastSearchOpts.regex) return htmlEscapedText;
  try {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return htmlEscapedText.replace(re, (m) => `<mark>${m}</mark>`);
  } catch (e) {
    return htmlEscapedText;
  }
}

/* ---------- downloads ---------- */

function downloadFile(avatar, file) {
  const a = document.createElement("a");
  a.href = `/api/download/${encodeURIComponent(avatar)}/${encodeURIComponent(file)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadCard(avatar) {
  const a = document.createElement("a");
  a.href = `/api/card/${encodeURIComponent(avatar)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadZip(items) {
  toast("Preparing zip...");
  try {
    const r = await fetch("/api/download-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!r.ok) {
      let detail = r.statusText;
      try { const j = await r.json(); if (j.detail) detail = j.detail; } catch (e) {}
      throw new Error(detail);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "st-chats-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    toast("Zip failed: " + e.message);
  }
}

/* ---------- state ---------- */

const S = {
  status: null,
  groups: null,       // character groups from API
  sel: new Set(),     // "avatar\u0000file" selected for zip
  lastSearchOpts: null,
  chatSort: "name",   // chat list sort key: name | recent | msgs | size
};

/* ---------- sidebar ---------- */

async function loadSidebar() {
  const data = await api("/api/characters");
  S.groups = data.groups;
  renderSidebar("");
}

function renderSidebar(filterRaw) {
  const filter = filterRaw.trim().toLowerCase();
  const root = $("#char-list");
  let html = "";
  let shown = 0;
  for (const g of S.groups) {
    const variants = g.variants.filter((v) => {
      if (!filter) return true;
      return (
        v.name.toLowerCase().includes(filter) ||
        v.avatar.toLowerCase().includes(filter) ||
        (v.creator_notes || "").toLowerCase().includes(filter)
      );
    });
    if (!variants.length) continue;
    shown += variants.length;
    const open = filter ? " open" : "";
    html += `<div class="char-group${open}" data-gname="${esc(g.name)}">`;
    html += `<div class="char-group-head" data-act="toggle-group"><span class="tw">&#9654;</span>${esc(g.name)}<span class="cnt">${variants.length > 1 ? variants.length + " versions" : ""}</span></div>`;
    html += `<div class="char-variants">`;
    for (const v of variants) {
      const active = route.name === "character" && route.avatar === v.avatar;
      const img = v.has_card
        ? `<img src="/api/avatar/${encodeURIComponent(v.avatar)}?w=68" loading="lazy" alt="">`
        : `<div class="ph">${esc(v.name.slice(0, 1).toUpperCase())}</div>`;
      const notes = v.creator_notes ? `<div class="cv-notes">${esc(v.creator_notes.slice(0, 70))}</div>` : "";
      html += `<div class="char-variant${active ? " active" : ""}" data-avatar="${esc(v.avatar)}">${img}
        <div class="cv-meta"><div class="cv-file">${esc(v.avatar)}${v.has_card ? "" : " <span class='badge'>no card</span>"}</div>${notes}</div>
        <div class="cv-chats">${v.chat_count} chat${v.chat_count === 1 ? "" : "s"}</div></div>`;
    }
    html += `</div></div>`;
  }
  if (!shown) html = `<div class="side-note">No characters match.</div>`;
  root.innerHTML = html;
}

$("#char-list").addEventListener("click", (ev) => {
  const head = ev.target.closest("[data-act='toggle-group']");
  if (head && ev.target.classList.contains("tw")) {
    head.parentElement.classList.toggle("open");
    return;
  }
  const variant = ev.target.closest(".char-variant");
  if (variant) {
    location.hash = `#/c/${encodeURIComponent(variant.dataset.avatar)}`;
  }
});

$("#char-filter").addEventListener("input", (ev) => renderSidebar(ev.target.value));

/* ---------- router ---------- */

let route = { name: "home" };

function parseRoute() {
  const raw = location.hash;
  const qi = raw.indexOf("?");
  const pathPart = qi === -1 ? raw : raw.slice(0, qi);
  const h = decodeURIComponent(pathPart.replace(/^#\/?/, ""));
  const q = new URLSearchParams(qi === -1 ? "" : raw.slice(qi + 1));
  if (h.startsWith("c/")) {
    const rest = h.slice(2);
    const [avatar] = rest.split("/");
    return { name: "character", avatar };
  }
  if (h.startsWith("chat/")) {
    const rest = h.slice(5);
    const slash = rest.indexOf("/");
    return { name: "chat", avatar: rest.slice(0, slash), file: rest.slice(slash + 1), m: q.get("m"), q: q.get("q") || "", k: q.get("k") || "", si: q.get("si") };
  }
  if (h === "search") {
    return { name: "search", params: q };
  }
  if (h === "cleaner") {
    return { name: "cleaner", params: q };
  }
  return { name: "home" };
}

async function render() {
  route = parseRoute();
  const v = view();
  v.innerHTML = `<div class="side-note">Loading...</div>`;
  try {
    if (route.name === "home") await renderHome(v);
    else if (route.name === "character") await renderCharacter(v);
    else if (route.name === "chat") await renderChat(v);
    else if (route.name === "search") await renderSearch(v);
    else if (route.name === "cleaner") await renderCleaner(v);
  } catch (e) {
    v.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p>
      <p><a href="#/">Back to home</a></p></div>`;
  }
  renderSidebar($("#char-filter").value);
}

window.addEventListener("hashchange", render);

/* ---------- home ---------- */

async function renderHome(v) {
  const st = await api("/api/status");
  S.status = st;
  const cards = [
    [fmtInt(st.characters), "characters"],
    [fmtInt(st.chats), "chat files"],
    [fmtInt(st.messages), "messages"],
    [fmtInt(st.swipes), "swipes"],
    [fmtInt(st.hidden_swipes), "hidden swipes"],
    [fmtInt(st.reasoning), "reasoning traces"],
    [fmtBytes(st.bytes), "of chat data"],
  ].map(([n, l]) => `<div class="stat-card"><b>${n}</b><span>${l}</span></div>`).join("");
  v.innerHTML = `
    <h1>Your archive</h1>
    <p class="muted">Read-only browser and search for your SillyTavern characters and chats.</p>
    <div class="home-grid">${cards}</div>
    <h2>Recently updated chats</h2>
    <div id="recent" class="recent-list"><div class="side-note">Loading...</div></div>
    <div class="card">
      <h3>How to use</h3>
      <p>Pick a character on the left to browse their chats, or search everything from the bar above.
      Search options let you look only at the visible main line, only at hidden swipes, only at
      branches, or everywhere including reasoning traces. Chats download exactly as they are on disk,
      ready to import back into SillyTavern.</p>
    </div>`;
  const recent = await api("/api/recent?limit=8");
  const rows = recent.chats.map((c) => `
    <a class="recent-row" href="#/chat/${encodeURIComponent(c.avatar)}/${encodeURIComponent(c.file)}">
      ${c.has_card
        ? `<img src="/api/avatar/${encodeURIComponent(c.avatar)}?w=48" loading="lazy" alt="">`
        : `<div class="ph">${esc(c.character.slice(0, 1).toUpperCase())}</div>`}
      <div class="rr-meta"><b>${esc(c.base_name)}</b><span>${esc(c.character)} &middot; ${fmtInt(c.msgs)} msg${c.msgs === 1 ? "" : "s"}</span></div>
      <span class="rr-date small muted">${fmtDay(c.last_date || c.first_date)}</span>
    </a>`).join("");
  $("#recent").innerHTML = rows || `<div class="side-note">No chats found in the mounted folders.</div>`;
}

/* ---------- character view ---------- */

const FIELD_LABELS = {
  description: "Description",
  personality: "Personality",
  scenario: "Scenario",
  first_mes: "First message",
  alternate_greetings: "Alternate greetings",
  mes_example: "Example messages",
  system_prompt: "System prompt",
  post_history_instructions: "Post-history instructions",
};

async function renderCharacter(v) {
  const data = await api(`/api/character/${encodeURIComponent(route.avatar)}`);
  const card = data.card;
  let fields = "";
  if (card.texts) {
    const blocks = Object.entries(FIELD_LABELS)
      .filter(([k]) => card.texts[k])
      .map(([k, label]) => `<h4>${label}</h4><pre>${esc(card.texts[k])}</pre>`)
      .join("");
    if (blocks) fields = `<details class="cardfields"><summary>Character card fields</summary><div class="cf-body">${blocks}</div></details>`;
  }
  const img = card.has_card
    ? `<img src="/api/avatar/${encodeURIComponent(card.avatar)}?w=300" alt="">`
    : `<div class="ph">${esc(card.name.slice(0, 1).toUpperCase())}</div>`;
  const notes = card.creator_notes
    ? `<div class="creator-notes">${esc(card.creator_notes)}</div>` : "";
  const tags = (card.tags || []).length
    ? `<div class="tags">${card.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : "";
  const meta = [];
  if (card.creator) meta.push("by " + esc(card.creator));
  if (card.character_version) meta.push("v" + esc(card.character_version));
  if (card.spec_version) meta.push("spec " + esc(card.spec_version));

  v.innerHTML = `
    <div class="card">
      <div class="char-head">
        ${img}
        <div class="char-title">
          <h1>${esc(card.name)}</h1>
          <div class="char-file">${esc(card.avatar)}${card.has_card ? "" : ' <span class="badge">no card file</span>'} ${meta.length ? "&middot; " + meta.join(" &middot; ") : ""}</div>
          ${notes}${tags}
          <div class="char-search-row">
            <input id="in-char-q" type="search" placeholder="Search within ${esc(card.name)}...">
            <button id="in-char-go" class="btn accent">Search</button>
            ${card.has_card ? '<button id="dl-card" class="btn" title="Download the original card file (PNG or JSON)">Download card</button>' : ""}
          </div>
          <div class="small muted">${data.totals.chats} chats &middot; ${fmtInt(data.totals.messages)} messages &middot; ${data.totals.branches} branch files</div>
        </div>
      </div>
      ${fields}
    </div>
    <div class="toolbar">
      <span id="sel-info" class="small muted"></span>
      <span class="spacer"></span>
      <label class="small muted sort-label">Sort
        <select id="chat-sort">
          <option value="name">Name</option>
          <option value="recent">Recently updated</option>
          <option value="msgs">Most messages</option>
          <option value="size">Largest</option>
        </select>
      </label>
      <button class="btn" id="select-all">Select all</button>
      <button class="btn" id="select-none">Clear</button>
      <button class="btn" id="dl-zip">Download selected</button>
      <button class="btn" id="dl-all">Download all (zip)</button>
    </div>
    <div id="chat-list"></div>`;

  renderChatTable(data.chats);

  const sortSel = $("#chat-sort");
  sortSel.value = S.chatSort;
  sortSel.addEventListener("change", () => {
    S.chatSort = sortSel.value;
    renderChatTable(data.chats);
  });

  const go = () => {
    const q = $("#in-char-q").value;
    if (q) {
      const p = new URLSearchParams({ q, avatar: card.avatar });
      location.hash = `#/search?${p.toString()}`;
    }
  };
  $("#in-char-go").onclick = go;
  $("#in-char-q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

  const dlCard = $("#dl-card");
  if (dlCard) dlCard.onclick = () => downloadCard(card.avatar);

  $("#dl-all").onclick = () => {
    downloadZip(data.chats.map((c) => ({ avatar: card.avatar, file: c.file })));
  };
  $("#select-all").onclick = () => {
    for (const c of data.chats) S.sel.add(card.avatar + "\u0000" + c.file);
    refreshSelection(card.avatar);
  };
  $("#select-none").onclick = () => {
    for (const c of data.chats) S.sel.delete(card.avatar + "\u0000" + c.file);
    refreshSelection(card.avatar);
  };
  $("#dl-zip").onclick = () => {
    const items = [...S.sel].map((k) => {
      const [avatar, file] = k.split("\u0000");
      return { avatar, file };
    });
    if (!items.length) { toast("Nothing selected yet."); return; }
    downloadZip(items);
  };
}

function chatRow(c, cardAvatar) {
  const name = c.is_branch
    ? `<span class="badge branch">Branch #${c.branch_no}</span> ${esc(c.base_name)}`
    : esc(c.base_name);
  const sw = c.hidden_swipes
    ? `<span class="badge hidden-sw" title="swipes other than the selected one">${c.hidden_swipes} hidden</span>`
    : (c.swipes > 1 ? `<span class="badge">${c.swipes} swipes</span>` : "");
  const rr = c.reasoning_count ? `<span class="badge reasoning">${c.reasoning_count} reasoning</span>` : "";
  const sel = S.sel.has(cardAvatar + "\u0000" + c.file);
  const err = c.error ? ` <span class="badge" style="color:#a04343">error</span>` : "";
  return `<tr data-avatar="${esc(cardAvatar)}" data-file="${esc(c.file)}">
    <td><input type="checkbox" data-act="sel" ${sel ? "checked" : ""}></td>
    <td class="chat-name" data-act="open"><span class="bname">${name}</span>${err}</td>
    <td class="num">${fmtInt(c.msgs)}</td>
    <td class="num">${sw || ""}</td>
    <td class="num">${rr || ""}</td>
    <td class="small muted">${fmtDay(c.first_date)} &rarr; ${fmtDay(c.last_date)}</td>
    <td class="num small muted">${fmtBytes(c.size)}</td>
    <td><button class="btn small" data-act="dl" title="Download this chat">Download</button></td>
  </tr>`;
}

function renderChatTable(chats) {
  const cardAvatar = route.avatar;
  const sorted = [...chats];
  if (S.chatSort === "recent") {
    sorted.sort((a, b) => tsOf(b.last_date || b.first_date) - tsOf(a.last_date || a.first_date) || a.base_name.localeCompare(b.base_name));
  } else if (S.chatSort === "msgs") {
    sorted.sort((a, b) => b.msgs - a.msgs || a.base_name.localeCompare(b.base_name));
  } else if (S.chatSort === "size") {
    sorted.sort((a, b) => b.size - a.size || a.base_name.localeCompare(b.base_name));
  }
  const byBase = new Map();
  for (const c of sorted) {
    if (!byBase.has(c.base_name)) byBase.set(c.base_name, { base: null, branches: [] });
    if (c.is_branch) byBase.get(c.base_name).branches.push(c);
    else byBase.get(c.base_name).base = c;
  }
  const rows = [];
  for (const [baseName, grp] of byBase) {
    grp.branches.sort((a, b) => (a.branch_no || 0) - (b.branch_no || 0));
    if (grp.base) rows.push(chatRow(grp.base, cardAvatar));
    else if (!grp.branches.length) continue;
    if (grp.branches.length) {
      rows.push(`<tr class="branch-parent" data-base="${esc(baseName)}"><td></td>
        <td colspan="7"><span class="muted small">${esc(baseName)} &middot; ${grp.branches.length} branch file${grp.branches.length === 1 ? "" : "s"}</span></td></tr>`);
      rows.push(`<tr class="branch-kids" data-base="${esc(baseName)}" style="display:table-row"><td></td><td colspan="7" style="padding:0">
        <div class="branch-children"><table class="chat-table">${grp.branches.map((c) => chatRow(c, cardAvatar)).join("")}</table></div></td></tr>`);
    }
  }
  $("#chat-list").innerHTML = `<table class="chat-table">
    <thead><tr><th></th><th>Chat</th><th class="num">Msgs</th><th class="num">Swipes</th><th class="num">Reasoning</th><th>Dates</th><th class="num">Size</th><th></th></tr></thead>
    <tbody>${rows.join("")}</tbody></table>`;
  refreshSelection(cardAvatar);
}

function refreshSelection(cardAvatar) {
  const info = $("#sel-info");
  if (!info) return;
  const n = [...S.sel].filter((k) => k.startsWith(cardAvatar + "\u0000")).length;
  info.textContent = n ? `${n} chat${n === 1 ? "" : "s"} selected` : "";
  document.querySelectorAll("#chat-list input[data-act='sel']").forEach((cb) => {
    const tr = cb.closest("tr");
    cb.checked = S.sel.has(tr.dataset.avatar + "\u0000" + tr.dataset.file);
  });
}

$("#main").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const tr = btn.closest("tr");
  if (btn.dataset.act === "open" && tr) {
    location.hash = `#/chat/${encodeURIComponent(tr.dataset.avatar)}/${encodeURIComponent(tr.dataset.file)}`;
  } else if (btn.dataset.act === "dl" && tr) {
    downloadFile(tr.dataset.avatar, tr.dataset.file);
  }
});

$("#main").addEventListener("change", (ev) => {
  if (ev.target.matches("input[data-act='sel']")) {
    const tr = ev.target.closest("tr");
    const key = tr.dataset.avatar + "\u0000" + tr.dataset.file;
    if (ev.target.checked) S.sel.add(key);
    else S.sel.delete(key);
    refreshSelection(tr.dataset.avatar);
  }
});

/* ---------- chat viewer ---------- */

async function renderChat(v) {
  const data = await api(`/api/chat/${encodeURIComponent(route.avatar)}/${encodeURIComponent(route.file)}`);
  const info = data.info;
  const meta = [
    `${fmtInt(info.msgs)} messages`,
    info.swipes > info.msgs ? `${info.swipes} swipes (${info.hidden_swipes} hidden)` : null,
    info.reasoning_count ? `${info.reasoning_count} reasoning traces` : null,
    fmtBytes(info.size),
    info.first_date ? `${fmtDay(info.first_date)} &rarr; ${fmtDay(info.last_date)}` : null,
    (info.models || []).length ? "models: " + info.models.join(", ") : null,
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join("");

  let siblings = "";
  if (data.siblings.length) {
    const chips = data.siblings.map((s) =>
      `<a class="chip" href="#/chat/${encodeURIComponent(s.avatar)}/${encodeURIComponent(s.file)}">${s.is_branch ? "Branch #" + s.branch_no : esc(s.base_name)}</a>`).join("");
    siblings = `<div class="sibling-chips"><span class="small muted">Same chat, other files:</span>${chips}</div>`;
  }

  v.innerHTML = `
    <div class="card viewer-head">
      <div>
        <div class="small"><a href="#/c/${encodeURIComponent(info.avatar)}">&larr; ${esc(info.avatar)}</a></div>
        <h1>${info.is_branch ? `<span class="badge branch">Branch #${info.branch_no}</span> ` : ""}${esc(info.base_name)}</h1>
        <div class="viewer-meta">${meta}</div>
        ${siblings}
      </div>
      <span class="grow" style="flex:1"></span>
      <div style="display:flex;gap:8px;flex-direction:column">
        <button class="btn accent" id="dl-this">Download chat</button>
        <button class="btn" id="dl-back">&larr; Back to list</button>
      </div>
    </div>
    <div class="find-bar">
      <input id="find-in-chat" type="search" placeholder="Find in this chat...">
      <button class="btn small" id="find-prev">&uarr;</button>
      <button class="btn small" id="find-next">&darr;</button>
      <span id="find-info" class="small muted"></span>
    </div>
    <div id="messages"></div>`;

  const msgsHtml = data.messages.map((m) => renderMessage(m, route.q)).join("");
  $("#messages").innerHTML = msgsHtml;

  $("#dl-this").onclick = () => downloadFile(info.avatar, info.file);
  $("#dl-back").onclick = () => { location.hash = `#/c/${encodeURIComponent(info.avatar)}`; };

  // in-chat find
  const findState = { term: "", idx: -1, matches: [] };
  const findInput = $("#find-in-chat");
  function collectMatches() {
    findState.term = findInput.value.toLowerCase();
    findState.matches = [];
    findState.idx = -1;
    if (!findState.term) { $("#find-info").textContent = ""; return; }
    document.querySelectorAll(".msg").forEach((el) => {
      if (el.dataset.searchText.includes(findState.term)) findState.matches.push(el);
    });
    $("#find-info").textContent = findState.matches.length ? "" : "no matches";
  }
  function gotoMatch(dir) {
    if (!findState.matches.length) return;
    findState.idx = (findState.idx + dir + findState.matches.length) % findState.matches.length;
    const el = findState.matches[findState.idx];
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
    $("#find-info").textContent = `${findState.idx + 1} / ${findState.matches.length}`;
  }
  findInput.addEventListener("input", collectMatches);
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { collectMatches(); gotoMatch(1); }
  });
  $("#find-next").onclick = () => gotoMatch(1);
  $("#find-prev").onclick = () => gotoMatch(-1);

  // jump to message from search results
  if (route.m != null) {
    const el = document.getElementById("m-" + route.m);
    if (el) {
      // when the hit lives in a hidden swipe or reasoning trace, open that panel
      if (route.k === "swipe") {
        const panel = document.getElementById("swipes-" + route.m);
        if (panel) panel.hidden = false;
        if (route.si != null && route.si !== "") {
          const item = panel?.querySelectorAll(".swipe-item")[+route.si];
          if (item) {
            item.scrollIntoView({ block: "center" });
            item.classList.add("flash");
            setTimeout(() => item.classList.remove("flash"), 2500);
          }
        }
      } else if (route.k === "reasoning") {
        const panel = document.getElementById("reasoning-" + route.m);
        if (panel) panel.hidden = false;
        panel?.querySelector("details")?.setAttribute("open", "");
      }
      el.scrollIntoView({ block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 2500);
    } else {
      toast(`Message #${route.m} not found in this file (different branch?).`);
    }
  }
}

function renderMessage(m, highlight) {
  const body = markText(esc(m.mes), highlight);
  const role = m.is_user ? "user" : "ai";
  const swipes = m.swipes || [];
  let tools = "";
  if (swipes.length > 1) {
    tools += `<button class="btn small ghost" data-m="${m.idx}" data-panel="swipes">${swipes.length} swipes</button>`;
  }
  const hasReasoning = (m.reasoning && m.reasoning.trim()) || (m.swipe_meta || []).some((s) => s.reasoning);
  if (hasReasoning) {
    tools += `<button class="btn small ghost" data-m="${m.idx}" data-panel="reasoning">reasoning</button>`;
  }
  let metaBits = [
    `<span class="midx">#${m.idx}</span>`,
    `<span class="mname">${esc(m.name || (m.is_user ? "You" : "Character"))}</span>`,
    `<span class="role-chip ${role}">${role === "user" ? "user" : "AI"}</span>`,
  ];
  if (m.date) metaBits.push(`<span>${esc(fmtDate(m.date))}</span>`);
  if (m.model) metaBits.push(`<span class="badge">${esc(m.model)}</span>`);
  const selLabel = m.swipes.length > 1 ? ` <span class="badge">swipe ${m.swipe_id + 1}/${m.swipes.length}</span>` : "";

  // swipes panel
  let swipesPanel = "";
  if (swipes.length > 1) {
    const items = swipes.map((sw, i) => {
      const sm = (m.swipe_meta || [])[i] || {};
      const selected = i === m.swipe_id;
      const r = sm.reasoning
        ? `<details class="reasoning"><summary>Show reasoning for this swipe</summary><div class="r-body">${esc(sm.reasoning)}</div></details>`
        : "";
      return `<div class="swipe-item${selected ? " selected" : ""}">
        <div class="swipe-head">
          <span class="sel-flag">${selected ? "selected" : "alternate"}</span>
          <span>Swipe ${i + 1} / ${swipes.length}</span>
          ${sm.model ? `<span class="badge">${esc(sm.model)}</span>` : ""}
          ${sm.date ? `<span class="muted small">${esc(fmtDate(sm.date))}</span>` : ""}
        </div>
        <div class="swipe-text">${markText(esc(sw), highlight)}</div>${r}</div>`;
    }).join("");
    swipesPanel = `<div class="msg-swipes" id="swipes-${m.idx}" hidden><div class="small muted" style="margin-bottom:8px">
      The selected swipe is what the chat shows. The others are the alternatives you swiped away.</div>${items}</div>`;
  }

  // reasoning panel (selected swipe)
  let reasoningPanel = "";
  if (hasReasoning) {
    const sm = (m.swipe_meta || [])[m.swipe_id] || {};
    const r = m.reasoning || sm.reasoning || "";
    reasoningPanel = `<div class="msg-swipes" id="reasoning-${m.idx}" hidden>
      <details class="reasoning" open><summary>Reasoning for the selected swipe</summary><div class="r-body">${esc(r)}</div></details></div>`;
  }

  return `<div class="msg ${role}" id="m-${m.idx}" data-search-text="${esc((m.mes + " " + swipes.join(" ")).toLowerCase())}">
    <div class="msg-head">
      ${metaBits.join("")}${selLabel}<span class="grow"></span>
      <div class="msg-tools">${tools}</div>
    </div>
    <div class="msg-body">${body}</div>
    ${swipesPanel}${reasoningPanel}
  </div>`;
}

$("#main").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-panel]");
  if (!btn) return;
  const id = btn.dataset.panel + "-" + btn.dataset.m;
  const el = document.getElementById(id);
  if (el) el.hidden = !el.hidden;
});

/* ---------- search ---------- */

const SCOPE_LABELS = {
  all: "Everywhere (visible + hidden swipes)",
  visible: "Visible main line only",
  hidden: "Hidden swipes only",
  reasoning: "Reasoning traces only",
};

const FIELD_LABEL = {
  description: "Description",
  personality: "Personality",
  scenario: "Scenario",
  first_mes: "First message",
  alternate_greetings: "Alternate greetings",
  mes_example: "Example messages",
  creator_notes: "Creator's notes",
  system_prompt: "System prompt",
  post_history_instructions: "Post-history instructions",
};

function searchFormHtml(params) {
  const models = S.status ? S.status.models : [];
  const modelOpts = ["", ...models].map((m) =>
    `<option value="${esc(m)}" ${params.get("model") === m ? "selected" : ""}>${m === "" ? "Any model" : esc(m)}</option>`).join("");
  return `
  <div class="search-panel">
    <div class="row1">
      <input id="sq" type="search" placeholder="Search query..." value="${esc(params.get("q") || "")}">
      <button id="s-go" class="btn accent">Search</button>
    </div>
    <div class="opt-grid">
      <label>Look in
        <select id="s-scope">
          ${Object.entries(SCOPE_LABELS).map(([k, lbl]) => `<option value="${k}" ${params.get("scope") === k ? "selected" : ""}>${lbl}</option>`).join("")}
        </select>
      </label>
      <label>Branches
        <select id="s-branches">
          <option value="all" ${params.get("branches") !== "exclude" && params.get("branches") !== "only" ? "selected" : ""}>Include branch files</option>
          <option value="exclude" ${params.get("branches") === "exclude" ? "selected" : ""}>Exclude branches</option>
          <option value="only" ${params.get("branches") === "only" ? "selected" : ""}>Branch files only</option>
        </select>
      </label>
      <label>Role
        <select id="s-role">
          <option value="any" ${params.get("role") !== "user" && params.get("role") !== "ai" ? "selected" : ""}>Any</option>
          <option value="user" ${params.get("role") === "user" ? "selected" : ""}>User messages</option>
          <option value="ai" ${params.get("role") === "ai" ? "selected" : ""}>AI messages</option>
        </select>
      </label>
      <label>Model <select id="s-model">${modelOpts}</select></label>
      <label><input type="checkbox" id="s-case" ${params.get("case") ? "checked" : ""}> Match case</label>
      <label><input type="checkbox" id="s-word" ${params.get("word") ? "checked" : ""}> Whole word</label>
      <label><input type="checkbox" id="s-regex" ${params.get("regex") ? "checked" : ""}> Regex</label>
      <label>Also search
        <label class="small"><input type="checkbox" id="s-t-chats" ${params.get("targets")?.includes("chats") ? "checked" : ""}> chat names</label>
        <label class="small"><input type="checkbox" id="s-t-cards" ${params.get("targets")?.includes("cards") ? "checked" : ""}> character cards</label>
      </label>
      <label>From <input type="text" id="s-from" style="width:105px" placeholder="2026-01-01" value="${esc(params.get("date_from") || "")}"></label>
      <label>To <input type="text" id="s-to" style="width:105px" placeholder="2026-12-31" value="${esc(params.get("date_to") || "")}"></label>
      ${params.get("avatar") ? `<span class="pin-chip">in ${esc(params.get("avatar"))} <span class="x" id="s-unpin" title="Search everything">&times;</span></span>` : ""}
    </div>
    <div class="small muted" style="margin-top:10px">
      "Visible main line" = the swipe you actually kept on each message. "Hidden swipes" = the alternatives you swiped away.
      Branch files are full copies SillyTavern makes when you branch a chat.
    </div>
  </div>`;
}

async function renderSearch(v) {
  const params = route.params;
  if (!S.status) S.status = await api("/api/status");
  v.innerHTML = searchFormHtml(params) + `<div id="s-results"><div class="side-note">Results will appear here.</div></div>`;

  const wireForm = () => {
    const go = () => {
      const p = new URLSearchParams();
      p.set("q", $("#sq").value);
      const scope = $("#s-scope").value;
      if (scope !== "all") p.set("scope", scope);
      const br = $("#s-branches").value;
      if (br !== "all") p.set("branches", br);
      const role = $("#s-role").value;
      if (role !== "any") p.set("role", role);
      if ($("#s-model").value) p.set("model", $("#s-model").value);
      if ($("#s-case").checked) p.set("case", "1");
      if ($("#s-word").checked) p.set("word", "1");
      if ($("#s-regex").checked) p.set("regex", "1");
      const tg = [];
      if ($("#s-t-chats").checked) tg.push("chats");
      if ($("#s-t-cards").checked) tg.push("cards");
      if (tg.length) p.set("targets", tg.join(","));
      if ($("#s-from").value.trim()) p.set("date_from", $("#s-from").value.trim());
      if ($("#s-to").value.trim()) p.set("date_to", $("#s-to").value.trim());
      if (params.get("avatar") && !$("#s-unpin")) p.set("avatar", params.get("avatar"));
      location.hash = `#/search?${p.toString()}`;
    };
    $("#s-go").onclick = go;
    $("#sq").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    for (const id of ["s-scope", "s-branches", "s-role", "s-model"]) {
      $("#" + id).addEventListener("change", go);
    }
    for (const id of ["s-case", "s-word", "s-regex", "s-t-chats", "s-t-cards"]) {
      $("#" + id).addEventListener("change", go);
    }
    const unpin = $("#s-unpin");
    if (unpin) unpin.onclick = (ev) => {
      ev.stopPropagation();
      const p = new URLSearchParams(location.hash.split("?")[1] || "");
      p.delete("avatar");
      location.hash = `#/search?${p.toString()}`;
    };
  };
  wireForm();

  const q = params.get("q");
  if (!q) return;
  S.lastSearchOpts = { regex: !!params.get("regex") };
  $("#s-results").innerHTML = `<div class="side-note">Searching...</div>`;
  const sp = new URLSearchParams();
  sp.set("q", q);
  if (params.get("scope")) sp.set("scope", params.get("scope"));
  if (params.get("branches")) sp.set("branches", params.get("branches"));
  if (params.get("role")) sp.set("role", params.get("role"));
  if (params.get("model")) sp.set("model", params.get("model"));
  if (params.get("case")) sp.set("case", "1");
  if (params.get("word")) sp.set("word", "1");
  if (params.get("regex")) sp.set("regex", "1");
  if (params.get("targets")) sp.set("targets", params.get("targets"));
  if (params.get("avatar")) sp.set("avatar", params.get("avatar"));
  if (params.get("date_from")) sp.set("date_from", params.get("date_from"));
  if (params.get("date_to")) sp.set("date_to", params.get("date_to"));

  const t0 = performance.now();
  let data;
  try {
    data = await api("/api/search?" + sp.toString());
  } catch (e) {
    $("#s-results").innerHTML = `<div class="card"><b>Search failed:</b> ${esc(e.message)}</div>`;
    return;
  }
  const ms = Math.round(performance.now() - t0);
  renderSearchResults(data, q, ms);
}

function kindBadge(h) {
  if (h.kind === "visible") return `<span class="badge">main line</span>`;
  if (h.kind === "swipe") return `<span class="badge hidden-sw">hidden swipe #${(h.swipe_index ?? 0) + 1}</span>`;
  if (h.kind === "reasoning") return `<span class="badge reasoning">reasoning${h.swipe_index != null ? " (swipe " + (h.swipe_index + 1) + ")" : ""}</span>`;
  return "";
}

function renderSearchResults(data, q, ms) {
  const root = $("#s-results");
  let html = "";

  const t = data.totals || {};
  const bits = [];
  if (t.hits != null) bits.push(`${fmtInt(t.hits)} hits in ${fmtInt(t.chats)} chat${t.chats === 1 ? "" : "s"}`);
  if (data.chat_names.length) bits.push(`${data.chat_names.length} chat name matches`);
  if (data.cards.length) bits.push(`${data.cards.length} card matches`);
  bits.push(`${(ms / 1000).toFixed(1)}s`);
  html += `<div class="search-totals">${bits.join(" &middot; ")}</div>`;

  if (t.truncated) {
    html += `<div class="truncated-note">Result limit reached &mdash; showing the first ${fmtInt(t.hits)} hits. Narrow the search or scope it to one character to see more.</div>`;
  }

  if (data.chat_names.length) {
    html += `<h3 class="section-title">Chat name matches</h3><div class="card" style="padding:4px 6px">`;
    for (const m of data.chat_names) {
      html += `<div class="chatname-match"><div class="cm-row">
        <span class="cname" data-avatar="${esc(m.avatar)}" data-file="${esc(m.file)}">#${esc(m.base_name)}${m.branch_no != null ? ` <span class="badge branch">Branch #${m.branch_no}</span>` : ""}</span>
        <span class="small muted">${fmtInt(m.msgs)} msgs</span>
        <span class="snip">${m.snippets.map((s) => s.html).join(" ")}</span>
        <span class="grow"></span>
        <button class="btn small" data-act="dl" data-avatar="${esc(m.avatar)}" data-file="${esc(m.file)}">Download</button>
      </div></div>`;
    }
    html += `</div>`;
  }

  if (data.cards.length) {
    html += `<h3 class="section-title">Character card matches</h3><div class="card" style="padding:4px 6px">`;
    for (const m of data.cards) {
      html += `<div class="card-match"><div class="cm-row">
        <span class="cname" data-avatar="${esc(m.avatar)}">${esc(m.name)}</span>
        <span class="badge">${esc(FIELD_LABEL[m.field] || m.field)}</span>
        <span class="snip">${m.snippets.map((s) => s.html).join(" ")}</span>
      </div>
      ${m.creator_notes ? `<div class="small muted" style="margin-top:3px">notes: ${esc(m.creator_notes.slice(0, 140))}</div>` : ""}
      </div>`;
    }
    html += `</div>`;
  }

  for (const g of data.groups) {
    const img = g.avatar && S.groups
      ? `<img src="/api/avatar/${encodeURIComponent(g.avatar)}?w=80" loading="lazy" alt="">`
      : `<div class="ph">${esc(String(g.name).slice(0, 1).toUpperCase())}</div>`;
    let body = "";
    for (const c of g.chats) {
      const hits = c.hits.map((h) => `
        <div class="hit kind-${h.kind}">
          <div class="hit-meta">
            <span class="go" data-avatar="${esc(g.avatar)}" data-file="${esc(c.file)}" data-m="${h.msg_index}" data-k="${h.kind}" data-si="${h.swipe_index ?? ''}">msg #${h.msg_index}</span>
            <span class="mname">${esc(h.name)}</span>
            <span class="role-chip ${h.role}">${h.role === "user" ? "user" : "AI"}</span>
            ${kindBadge(h)}
            ${h.model ? `<span class="badge">${esc(h.model)}</span>` : ""}
            ${h.date ? `<span class="muted">${esc(fmtDate(h.date))}</span>` : ""}
            <span class="muted">${h.count} match${h.count === 1 ? "" : "es"}</span>
          </div>
          ${h.snippets.map((s) => `<div class="snip">${s.html}</div>`).join("")}
        </div>`).join("");
      body += `<div class="result-chat">
        <div class="result-chat-head">
          <span class="cname" data-avatar="${esc(g.avatar)}" data-file="${esc(c.file)}">${c.is_branch ? `<span class="badge branch">Branch #${c.branch_no}</span> ` : ""}${esc(c.base_name)}</span>
          <span class="badge">${c.total_hits} hit${c.total_hits === 1 ? "" : "s"}</span>
          ${c.more ? `<span class="muted small">showing first ${c.hits.length}</span>` : ""}
          <span class="grow"></span>
          <button class="btn small" data-act="dl" data-avatar="${esc(g.avatar)}" data-file="${esc(c.file)}">Download</button>
        </div>
        ${hits}
      </div>`;
    }
    html += `<div class="result-group">
      <div class="result-group-head">
        ${img}
        <div>
          <h3>${esc(g.name)}</h3>
          <div class="muted">${g.creator_notes ? "notes: " + esc(g.creator_notes.slice(0, 90)) : esc(g.avatar)}</div>
        </div>
        <span class="grow"></span>
        <span class="badge">${g.total_hits} hits</span>
        <a class="btn small" href="#/c/${encodeURIComponent(g.avatar)}">Open</a>
      </div>
      <div class="result-group-body">${body}</div>
    </div>`;
  }

  if (!data.groups.length && !data.chat_names.length && !data.cards.length) {
    html += `<div class="card">No matches for <b>${esc(q)}</b>.</div>`;
  }

  root.innerHTML = html;

  root.querySelectorAll("[data-m]").forEach((el) => {
    el.addEventListener("click", () => {
      const p = new URLSearchParams({ m: el.dataset.m, q });
      if (el.dataset.k) p.set("k", el.dataset.k);
      if (el.dataset.si != null) p.set("si", el.dataset.si);
      location.hash = `#/chat/${encodeURIComponent(el.dataset.avatar)}/${encodeURIComponent(el.dataset.file)}?${p.toString()}`;
    });
  });
  root.querySelectorAll(".cm-row .cname[data-file]").forEach((el) => {
    el.addEventListener("click", () => {
      location.hash = `#/chat/${encodeURIComponent(el.dataset.avatar)}/${encodeURIComponent(el.dataset.file)}`;
    });
  });
  root.querySelectorAll(".cname[data-avatar]:not([data-file])").forEach((el) => {
    el.addEventListener("click", () => {
      location.hash = `#/c/${encodeURIComponent(el.dataset.avatar)}`;
    });
  });
  root.querySelectorAll("button[data-act='dl']").forEach((el) => {
    el.addEventListener("click", () => downloadFile(el.dataset.avatar, el.dataset.file));
  });
}

/* ---------- cleaner ---------- */

async function renderCleaner(v) {
  if (!S.status) S.status = await api("/api/status");
  if (!S.status.cleaner_available) {
    v.innerHTML = `
      <div class="card">
        <h2>Cleaner unavailable</h2>
        <p>The chats folder is mounted read-only, so chat cleanup is disabled.</p>
        <p class="small muted">To enable it, mount <code>chats</code> without <code>:ro</code> in docker-compose.yml
        and make sure the container user can write to it (set <code>user:</code> to match the host owner).</p>
        <p><a href="#/">Back to home</a></p>
      </div>`;
    return;
  }
  const p = route.params;
  v.innerHTML = cleanerFormHtml(p) + `<div id="cl-results"><div class="side-note">Preview shows what a run would change. Nothing is touched until you press Apply.</div></div>`;
  wireCleanerForm(v);
  if (p.get("run") === "1") await runCleaner(false);
}

function cleanerFormHtml(p) {
  return `
  <h1>Cleaner</h1>
  <p class="muted">Prune old branch files, strip reasoning traces, and drop unused swipes from bloated chat folders.</p>
  <div class="search-panel">
    <div class="row1">
      <button id="cl-preview" class="btn accent">Preview (dry-run)</button>
      <button id="cl-apply" class="btn danger">Apply changes</button>
      <span id="cl-busy" class="small muted" hidden>Working&hellip;</span>
    </div>
    <div class="opt-grid">
      <label><input type="checkbox" id="cl-a-branches" ${p.get("actions")?.includes("branches") || !p.get("actions") ? "checked" : ""}> Prune old branch files</label>
      <label><input type="checkbox" id="cl-a-reasoning" ${p.get("actions")?.includes("reasoning") || !p.get("actions") ? "checked" : ""}> Strip reasoning traces</label>
      <label><input type="checkbox" id="cl-a-swipes" ${p.get("actions")?.includes("swipes") || !p.get("actions") ? "checked" : ""}> Drop unused swipes</label>
      <label>Min folder MB <input type="number" id="cl-min" min="0" step="1" style="width:70px" value="${esc(p.get("min_folder_mb") || "25")}"></label>
      <label>Keep recent branches <input type="number" id="cl-keep" min="0" step="1" style="width:70px" value="${esc(p.get("keep_recent") || "20")}"></label>
    </div>
    <label class="small">Skip chat names (comma-separated, exact match)
      <input type="text" id="cl-skip" style="width:100%" placeholder="15B, FB" value="${esc(p.get("skip_names") || "")}">
    </label>
    <div class="small muted" style="margin-top:10px">
      Branch pruning keeps the ${"<span id='cl-keep-hint'>20</span>"} most recently modified branch files per chat and deletes the rest.
      Dropping unused swipes keeps only the swipe you actually selected on each message — this is destructive and cannot be undone.
    </div>
  </div>`;
}

function cleanerOpts() {
  const acts = [];
  if ($("#cl-a-branches").checked) acts.push("branches");
  if ($("#cl-a-reasoning").checked) acts.push("reasoning");
  if ($("#cl-a-swipes").checked) acts.push("swipes");
  if (!acts.length) { toast("Pick at least one action."); return null; }
  return {
    actions: acts.join(","),
    min_folder_mb: $("#cl-min").value || "0",
    keep_recent: $("#cl-keep").value || "0",
    skip_names: $("#cl-skip").value,
  };
}

function wireCleanerForm(v) {
  $("#cl-keep").addEventListener("input", () => { $("#cl-keep-hint").textContent = $("#cl-keep").value || "0"; });
  $("#cl-preview").onclick = () => runCleaner(false);
  $("#cl-apply").onclick = async () => {
    if (!confirm("Apply cleanup? Branch files will be deleted and chat files rewritten in place. This cannot be undone.")) return;
    await runCleaner(true);
  };
}

async function runCleaner(apply) {
  const opts = cleanerOpts();
  if (!opts) return;
  const busy = $("#cl-busy");
  const results = $("#cl-results");
  busy.hidden = false;
  try {
    const qs = new URLSearchParams(opts).toString();
    const r = apply
      ? await api("/api/cleaner/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) })
      : await api("/api/cleaner/preview?" + qs);
    renderCleanerResults(r, apply);
    if (apply) {
      toast(`Cleaned: ${fmtBytes(r.totals.bytes_freed)} freed, ${r.totals.files_deleted} files deleted, ${r.totals.files_modified} modified.`);
      $("#overlay").hidden = false;
      await waitForIndex();
      await loadSidebar();
      await render();
    }
  } catch (e) {
    results.innerHTML = `<div class="card"><p>Cleaner failed: ${esc(e.message)}</p></div>`;
    toast("Cleaner failed: " + e.message);
  } finally {
    busy.hidden = true;
  }
}

function renderCleanerResults(r, applied) {
  const t = r.totals;
  const rows = r.folders.map((f) => {
    const err = f.errors?.length
      ? `<div class="small" style="color:var(--danger)">${f.errors.map((e) => esc(e.file + ": " + e.error)).join("<br>")}</div>` : "";
    return `<tr><td>${esc(f.avatar)}</td><td>${fmtBytes(f.size)}</td><td>${fmtBytes(f.bytes_freed)}</td>
      <td>${f.files_deleted}</td><td>${f.files_modified}</td></tr>${err ? `<tr><td colspan="5">${err}</td></tr>` : ""}`;
  }).join("");
  $("#cl-results").innerHTML = `
    <h2>${applied ? "Applied" : "Dry-run preview"}</h2>
    <p><b>${fmtBytes(t.bytes_freed)}</b> ${applied ? "freed" : "would be freed"},
       <b>${t.files_deleted}</b> files ${applied ? "deleted" : "to delete"},
       <b>${t.files_modified}</b> files ${applied ? "modified" : "to modify"} across ${t.folders} folder(s).</p>
    ${rows ? `<table class="chat-table"><thead><tr><th>Folder</th><th>Size</th><th>${applied ? "Freed" : "To free"}</th><th>Deleted</th><th>Modified</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="side-note">Nothing to do — no folders matched the current settings.</div>`}
    ${applied ? "" : `<p class="small muted">No changes were made. Press Apply to execute.</p>`}`;
}

/* ---------- global search bar ---------- */

function runGlobalSearch() {
  const q = $("#global-q").value.trim();
  if (!q) {
    toast("Type something to search.");
    return;
  }
  const p = new URLSearchParams({ q });
  location.hash = `#/search?${p.toString()}`;
}
$("#global-go").onclick = runGlobalSearch;
$("#global-q").addEventListener("keydown", (e) => { if (e.key === "Enter") runGlobalSearch(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
    e.preventDefault();
    $("#global-q").focus();
  }
});

/* ---------- boot ---------- */

async function waitForIndex() {
  const overlay = $("#overlay");
  while (true) {
    let st;
    try {
      st = await api("/api/status");
    } catch (e) {
      $("#overlay-phase").textContent = "Waiting for server...";
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    S.status = st;
    if (st.ready) break;
    $("#overlay-phase").textContent = st.phase === "scanning chats" ? "Scanning chats..." : "Reading character cards...";
    if (st.total) {
      $("#overlay-bar").style.width = Math.round((st.done / st.total) * 100) + "%";
      $("#overlay-count").textContent = `${fmtInt(st.done)} / ${fmtInt(st.total)} files`;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  overlay.hidden = true;
}

function syncCleanerButton() {
  const btn = $("#cleaner-btn");
  if (!btn) return;
  btn.hidden = !(S.status && S.status.cleaner_available);
}

async function boot() {
  $("#overlay").hidden = false;
  await waitForIndex();
  syncCleanerButton();
  await loadSidebar();
  await render();
}

async function reindex() {
  const btn = $("#reindex-btn");
  btn.disabled = true;
  try {
    const r = await api("/api/reindex", { method: "POST" });
    if (!r.started) return;
    $("#overlay").hidden = false;
    await waitForIndex();
    await loadSidebar();
    await render();
  } finally {
    btn.disabled = false;
  }
}

$("#reindex-btn").onclick = reindex;
$("#cleaner-btn").onclick = () => { location.hash = "#/cleaner"; };

boot();
