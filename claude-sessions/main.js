// Claude Code sessions: browse the transcripts Claude Code keeps on disk and
// reopen one where it ran.
//
// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<project-slug>/<session-id>.jsonl, and every prompt it
// received in ~/.claude/history.jsonl. The transcripts are the sessions that
// can be resumed; the history says what one was about and how many prompts it
// holds. A transcript runs to tens of megabytes, so it is never read whole:
// the listing is a shallow walk of the project folders, the history is read
// from its tail, and a session the history does not know costs one bounded
// head read.
//
// The chosen session goes back where it ran: into the space of the terminal
// that carried it, else into the space of its project, else into a new space.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, exec, theme, settings, props, closeOverlay, terminals, spaces, window } from "herdr";

const HEAD_BYTES = 262144;    // of a transcript, for a title the history lacks
const INDEX_BYTES = 4194304;  // of history.jsonl, the part that is recent
const CHUNK = 16;             // transcripts per head read
const ROW = 46;               // a row's height
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The listing: path, mtime and size of every session, NUL separated. Only the
// project folder's own transcripts: what sits deeper belongs to sub-agents
// and workflows, and those cannot be resumed.
const LIST_PS = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$sb = [Text.StringBuilder]::new()
Get-ChildItem -Path (Join-Path $root 'projects') -Filter '*.jsonl' -File -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object {
  [void]$sb.Append($_.FullName); [void]$sb.Append([char]0)
  [void]$sb.Append([int64](($_.LastWriteTimeUtc.ToFileTimeUtc() - 116444736000000000) / 10000000)); [void]$sb.Append([char]0)
  [void]$sb.Append($_.Length); [void]$sb.Append([char]0)
}
[Console]::Out.Write($sb.ToString())`;

const LIST_SH = `root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
for f in "$root"/projects/*/*.jsonl; do
  [ -f "$f" ] || continue
  m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
  s=$(wc -c < "$f" 2>/dev/null || echo 0)
  printf "%s\\0%s\\0%s\\0" "$f" "$m" "$s"
done`;

// The prompt history, its recent part only: it grows for as long as the
// person works.
const INDEX_PS = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$p = Join-Path $root 'history.jsonl'
if (Test-Path -LiteralPath $p) {
  $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
  $len = $fs.Length
  $take = [Math]::Min($len, ${INDEX_BYTES})
  [void]$fs.Seek($len - $take, 'Begin')
  $buf = New-Object byte[] $take
  $n = $fs.Read($buf, 0, $take)
  $fs.Close()
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($buf, 0, $n))
}`;

const INDEX_SH = `root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
tail -c ${INDEX_BYTES} "$root/history.jsonl" 2>/dev/null || true`;

// The head of the transcripts the history does not know, path and head NUL
// separated. The paths ride in the script itself: a command line has a length
// limit, and a long list of them does not fit.
const HEADS_PS = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$paths = @(__PATHS__)
foreach ($p in $paths) {
  [Console]::Out.Write($p); [Console]::Out.Write([char]0)
  try {
    $fs = [IO.File]::OpenRead($p)
    $buf = New-Object byte[] ${HEAD_BYTES}
    $n = $fs.Read($buf, 0, ${HEAD_BYTES})
    $fs.Close()
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($buf, 0, $n))
  } catch {}
  [Console]::Out.Write([char]0)
}`;

const HEADS_SH = `for p in "$@"; do
  printf "%s\\0" "$p"
  head -c ${HEAD_BYTES} "$p" 2>/dev/null || true
  printf "\\0"
done`;

const windows = () => window()?.platform === "windows";
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function baseName(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function sessionIdOf(path) {
  return baseName(path).replace(/\.jsonl$/i, "");
}

// The project a transcript sits in, as the folder name Claude Code made of
// the path. It is a fallback: the real folder comes from the transcript.
function projectOf(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts[parts.length - 1] || "";
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const s = String(p).replace(/[\\/]+$/, "");
    return windows() ? s.replace(/\//g, "\\").toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

function ago(seconds) {
  if (!seconds) return "";
  const mins = Math.floor((Date.now() / 1000 - seconds) / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const d = new Date(seconds * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// A prompt that is not a prompt: a slash command, or the note Claude Code
// leaves when the person ran a command of their own.
function isCommand(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^\/[a-z][a-z0-9_-]*$/i.test(t)) return true;
  if (t.startsWith("<command-name>")) return true;
  if (t.startsWith("<local-command-")) return true;
  return false;
}

// A prompt, as a title: one line, and the person's own words.
function titleOf(entry) {
  const display = typeof entry.display === "string" ? entry.display.trim() : "";
  if (!display || isCommand(display)) return "";
  const cleaned = display.replace(/\s*\[Pasted text #\d+[^\]]*\]\s*$/i, "").trim();
  if (!cleaned || isCommand(cleaned)) return "";
  return cleaned.replace(/\s+/g, " ").slice(0, 160);
}

// The text of a message, whatever shape its content has.
function messageText(message) {
  if (!message) return "";
  const content = message.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
  }
  return text.trim().replace(/\s+/g, " ").slice(0, 160);
}

// What the head of a transcript says: its first prompt and its folder.
function fromHead(text) {
  let title = "", cwd = "";
  for (const line of String(text).split("\n")) {
    if (line[0] !== "{") continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof d.cwd === "string" && d.cwd) cwd = d.cwd;
    if (title || d.type !== "user" || d.isMeta) continue;
    const t = messageText(d.message);
    if (!t || isCommand(t)) continue;
    title = t;
  }
  return { title, cwd };
}

async function listTranscripts() {
  const r = windows()
    ? await exec("powershell", ["-NoProfile", "-Command", LIST_PS], { timeout: 120000 })
    : await exec("sh", ["-c", LIST_SH, "sessions"], { timeout: 120000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "Cannot list Claude Code's sessions");
  const fields = String(r.stdout || "").split("\0");
  const out = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    if (!path) continue;
    out.push({ path, id: sessionIdOf(path), mtime: Number(fields[i + 1]) || 0, size: Number(fields[i + 2]) || 0 });
  }
  return out;
}

async function readIndex() {
  const r = windows()
    ? await exec("powershell", ["-NoProfile", "-Command", INDEX_PS], { timeout: 120000 })
    : await exec("sh", ["-c", INDEX_SH, "sessions"], { timeout: 120000 });
  const map = new Map();
  if (r.code !== 0) return map;
  for (const line of String(r.stdout || "").split("\n")) {
    if (line[0] !== "{") continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const id = d.sessionId;
    if (!id) continue;
    let e = map.get(id);
    if (!e) {
      e = { title: "", project: "", last: 0, count: 0 };
      map.set(id, e);
    }
    e.count++;
    const when = Math.floor((d.timestamp || 0) / 1000);
    if (when > e.last) e.last = when;
    if (!e.title) {
      const t = titleOf(d);
      if (t) e.title = t;
    }
    if (!e.project && typeof d.project === "string") e.project = d.project;
  }
  return map;
}

async function readHeads(paths) {
  const map = new Map();
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    let r;
    if (windows()) {
      const quoted = chunk.map(psQuote).join(", ");
      r = await exec("powershell", ["-NoProfile", "-Command", HEADS_PS.replace("__PATHS__", quoted)], { timeout: 120000 });
    } else {
      r = await exec("sh", ["-c", HEADS_SH, "sessions", ...chunk], { timeout: 120000 });
    }
    if (r.code !== 0) continue;
    const fields = String(r.stdout || "").split("\0");
    for (let j = 0; j + 1 < fields.length; j += 2) {
      if (!fields[j]) continue;
      map.set(fields[j], fromHead(fields[j + 1] || ""));
    }
  }
  return map;
}

export default class ClaudeSessions extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = 0;
    this.scroll = 0;
    this.sessions = [];
    this.loading = true;
    this.error = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Browse Claude Code sessions…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.reopen(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.load(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  rows() {
    const f = this.filter.trim().toLowerCase();
    if (!f) return this.sessions;
    return this.sessions.filter((s) => `${s.title} ${s.project} ${s.id}`.toLowerCase().includes(f));
  }

  async load(cx) {
    try {
      const files = await listTranscripts();
      const index = await readIndex();
      const rows = files.map((f) => {
        const e = index.get(f.id);
        return {
          id: f.id,
          path: f.path,
          title: e?.title || "",
          project: e?.project || "",
          count: e?.count || 0,
          when: Math.max(f.mtime, e?.last || 0),
        };
      });
      // A session the history does not know: one bounded head read for a
      // title and its folder.
      const missing = rows.filter((r) => !r.title);
      if (missing.length) {
        const heads = await readHeads(missing.map((r) => r.path));
        for (const r of missing) {
          const h = heads.get(r.path);
          if (!h) continue;
          if (!r.title) r.title = h.title;
          if (!r.project) r.project = h.cwd;
        }
      }
      for (const r of rows) if (!r.project) r.project = projectOf(r.path);
      this.sessions = rows.sort((a, b) => b.when - a.when);
      this.error = null;
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
      cx.notify();
    }
  }

  // The space the session goes back into: the one its terminal belongs to,
  // else the one of its project.
  spaceFor(session) {
    const term = terminals().find((t) => {
      const labels = t.labels || {};
      for (const key of Object.keys(labels)) {
        if (!key.startsWith("herdr.resume.")) continue;
        try { if (JSON.parse(labels[key]).session_id === session.id) return true; } catch {}
      }
      return false;
    });
    const id = term && term.labels && term.labels["herdr.space"];
    if (id) {
      const space = spaces().find((sp) => sp.id === id);
      if (space) return space;
    }
    return spaces().find((sp) => samePath(sp.folder, session.project)) || null;
  }

  reopen(session) {
    if (!session) return;
    this.close();
    const argv = ["claude", "--resume", session.id];
    const name = (session.title || session.id.slice(0, 8)).slice(0, 40);
    const space = this.spaceFor(session);
    if (space) {
      run("tab.new", { space: space.id, name, folder: session.project, argv });
      return;
    }
    // A space for the project, on this computer: the transcripts are this
    // computer's, so the session belongs here. The empty machine says so --
    // without it the new space would land on the focused space's machine.
    run("space.new", { name: projectOf(session.project) || session.title, tab: name, folder: session.project, argv, machine: "" });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const sel = rows[this.at];
    const height = Math.min(380, this.listHeight ?? 380);
    const fixed = rows.length * ROW > height;
    const maxScroll = Math.max(0, rows.length * ROW - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    if (sel) {
      const top = this.at * ROW;
      if (top < this.scroll) this.scroll = top;
      if (top + ROW > this.scroll + height) this.scroll = top + ROW - height;
    }

    const row = (s, i) => {
      const on = s === sel;
      const name = s.title || s.id.slice(0, 8);
      return h_flex()
        .id(`cs-${s.id}`)
        .mx(4)
        .px(10)
        .py(6)
        .h(ROW)
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s2) => s2.bg(t.hover))
        .on_click(() => this.reopen(s))
        .child(
          v_flex()
            .flex_1()
            .min_w_0()
            .gap(1)
            .child(div().truncate().text_size(12.5).text_color(t.foreground).when(on, (el) => el.font_semibold()).child(name))
            .child(div().truncate().text_size(11).text_color(t.dim).child(s.project || "unknown folder")),
        )
        .child(
          v_flex()
            .flex_none()
            .items_end()
            .gap(1)
            .child(div().text_size(11).text_color(t.dim).child(s.count ? `${s.count} prompt${s.count === 1 ? "" : "s"}` : ""))
            .child(div().text_size(11).text_color(t.dim).child(ago(s.when))),
        );
    };

    const visible = (i) => !fixed || (i * ROW + ROW > this.scroll && i * ROW < this.scroll + height);
    const place = (el, i) =>
      fixed ? el.absolute().left(0).right(0).top(i * ROW - this.scroll).bottom(height - ((i + 1) * ROW - this.scroll)) : el;

    return v_flex()
      .id("claude-sessions")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = (this.at + 1) % Math.max(1, rows.length);
        else if (k === "up") this.at = (this.at + rows.length - 1) % Math.max(1, rows.length);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Claude Code sessions"))
          .child(
            div()
              .id("cs-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s2) => s2.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg("mods/claude-sessions/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("cs-list")
          .on_size_change((size, cx) => {
            this.listHeight = size.height / settings().zoom;
            cx.notify();
          })
          .h(Math.min(380, rows.length * ROW))
          .min_h(0)
          .mb(6)
          .when(fixed, (el) =>
            el.overflow_hidden().on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
              while (this.at < rows.length - 1 && this.at * ROW < this.scroll) this.at++;
              while (this.at > 0 && this.at * ROW + ROW > this.scroll + height) this.at--;
              cx.notify();
            }),
          )
          .children(rows.map((s, i) => (visible(i) ? place(row(s, i), i) : null)).filter(Boolean)),
      )
      .when(this.loading, (el) => el.child(div().px(10).text_size(12).text_color(t.dim).child("Reading Claude Code's sessions…")))
      .when(!this.loading && this.error, (el) => el.child(div().px(10).text_size(12).text_color(t.blocked).child(this.error)))
      .when(!this.loading && !this.error && !rows.length, (el) => el.child(div().px(10).text_size(12).text_color(t.dim).child("No Claude Code sessions found in ~/.claude/projects")))
      .when(!this.loading && !this.error && rows.length, (el) =>
        el.child(div().px(10).text_size(11).text_color(t.dim).child("Enter reopens the session where it ran")),
      );
  }
}
