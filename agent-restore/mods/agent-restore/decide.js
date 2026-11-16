// The rules of the agent restore mod: which terminal may be resumed, and the
// command to type into it. Pure — it reads what the app knows and decides,
// and it touches nothing.

/** The label prefix that carries an agent's resume reference. */
export const LABEL_PREFIX = "herdr.resume.";

/** The POSIX shells the mod writes a command for. */
export const POSIX_SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "fish"];

/** The PowerShell shells the mod writes a command for. */
export const POWERSHELL_SHELLS = ["pwsh", "powershell"];

/** The mod's own resume table: how to reopen a session an agent reported. */
export const RESUME_TABLE = {
  claude: ["claude", "--resume", "{session}"],
  codex: ["codex", "--no-daemon", "resume", "{session}"],
};

/** What the toasts call the agents. */
export const AGENT_NAMES = { claude: "Claude Code", codex: "Codex" };

const MAX_ARGS = 64;
const MAX_BYTES = 8 * 1024;
// How long a sent resume command waits for the agent to report itself.
const REPORT_WAIT_MS = 15_000;

// The quotes PowerShell doubles inside a single-quoted word.
const PS_QUOTES = ["'", "‘", "’", "‚", "‛"];

/** The reference in a terminal's labels, if it has one. */
export function reference(labels) {
  if (!labels || typeof labels !== "object") return null;
  // The first label by name, sorted by the mod itself: the app's own map
  // keeps the order the labels arrived in, so the sort is what makes two
  // agents' labels always give the same one.
  const key = Object.keys(labels).filter((k) => k.startsWith(LABEL_PREFIX)).sort()[0];
  if (key === undefined) return null;
  const raw = labels[key];
  if (typeof raw !== "string") return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  if (!sessionId) return null;
  return { agent: key.slice(LABEL_PREFIX.length), sessionId };
}

/** The legacy Herdr's rules for a resume command: true, or why it is refused. */
export function validArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return "no command";
  const first = argv[0];
  // A plain command name, never a path and never a metacharacter.
  if (typeof first !== "string" || !/^[A-Za-z0-9._-]+$/.test(first)) {
    return `${JSON.stringify(first)} is not a plain command name`;
  }
  if (argv.length > MAX_ARGS) return `${argv.length} arguments, at most ${MAX_ARGS}`;
  // The words and the spaces between them: the command's own length.
  const total = argv.reduce((sum, arg) => sum + utf8Length(String(arg)), 0) + argv.length - 1;
  if (total > MAX_BYTES) return `${total} bytes, at most ${MAX_BYTES}`;
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("'") || holdsControl(arg)) {
      return `${JSON.stringify(arg)} holds an apostrophe or a control character`;
    }
  }
  return true;
}

/** The command for this shell, or none: a shell the mod cannot write syntax
 * for is refused rather than guessed at (nushell and cmd cannot parse sh
 * syntax at all, and elvish is not a shell the mod writes for). */
export function shellLine(shell, argv) {
  if (POWERSHELL_SHELLS.includes(shell)) return powershellLine(argv);
  if (POSIX_SHELLS.includes(shell)) return posixLine(argv);
  return null;
}

/** How to resume a session an agent reported, from the person's own table or
 * the mod's own. None when the agent has no resume line. */
export function resumeArgv(agent, sessionId, table = RESUME_TABLE) {
  const entry = table && table[agent];
  if (!Array.isArray(entry) || entry.length === 0) return null;
  return entry.map((word) => String(word).split("{session}").join(sessionId));
}

/** The person's own resume lines, read from the app home's programs.json: the
 * person's own wins over the mod's own table, and everything else keeps the
 * mod's own line. A file that cannot be read changes nothing. */
export function personResumeTable(text, table = RESUME_TABLE) {
  if (!text || typeof text !== "string") return table;
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return table;
  }
  const programs = file && typeof file === "object" ? file.programs : null;
  if (!programs || typeof programs !== "object" || Array.isArray(programs)) return table;
  const merged = { ...table };
  for (const [key, entry] of Object.entries(programs)) {
    const resume = entry && typeof entry === "object" ? entry.resume : null;
    if (!Array.isArray(resume) || resume.length === 0) continue;
    if (!resume.every((word) => typeof word === "string")) continue;
    merged[key] = resume.slice();
  }
  return merged;
}

/** What the app knows about one terminal when it decides. */
export function factsFor(record, panes, spaces, modStartedMs) {
  const address = record && record.address;
  const pane = (panes || []).find((p) => p && p.terminal === address);
  // The app's own ids: the pane's tab is the space's tab, no prefix guessing.
  const space = (spaces || []).find((s) => s && (s.tabs || []).some((t) => t && t.id === (pane && pane.tab)));
  return {
    labels: (record && record.labels) || {},
    program: (record && record.program) || {},
    // The core's created_ms is epoch milliseconds; a terminal created after the
    // mod started is one Herdr started during this run.
    startedHere: typeof record?.created_ms === "number" && record.created_ms > modStartedMs,
    inPane: Boolean(pane),
    // The machine the pane is on: the app publishes machine: null for this
    // computer, a name for another one, and nothing for a space it does not
    // list at all.
    machine: space === undefined ? undefined : space.machine,
  };
}

/** What to do with a terminal: type this command, or leave it alone and say why. */
export function decide(facts, table = RESUME_TABLE) {
  const found = reference(facts.labels);
  if (!found) return { kind: "skip", reason: "no session reference" };
  if (!facts.inPane) return { kind: "skip", reason: "it has no pane" };
  // A pane whose space Herdr does not list is not on another machine: Herdr
  // does not know where it is.
  if (facts.machine === undefined) return { kind: "skip", reason: "Herdr does not know its space" };
  if (facts.machine !== null) return { kind: "skip", reason: "it is on another machine" };
  if (facts.startedHere) return { kind: "skip", reason: "Herdr started it" };
  const program = facts.program || {};
  if (program.shell !== true) return { kind: "skip", reason: "it is not a shell" };
  const argv = resumeArgv(found.agent, found.sessionId, table);
  if (!argv) return { kind: "skip", reason: "Herdr cannot resume that agent" };
  if (validArgv(argv) !== true) return { kind: "skip", reason: "the resume command is not allowed" };
  const command = shellLine(program.name || "", argv);
  if (!command) return { kind: "skip", reason: "Herdr cannot write a command for that shell" };
  return { kind: "resume", agent: found.agent, sessionId: found.sessionId, command };
}

/** Whether the running core recovered this terminal: a terminal the core
 * created is younger than the core itself, and a recovered one keeps the
 * created_ms it always had. Without the core's start time there is no
 * evidence, and no evidence is never a restart. */
export function recoveredByCore(createdMs, coreStartMs) {
  if (typeof createdMs !== "number" || typeof coreStartMs !== "number") return false;
  return createdMs < coreStartMs;
}

/** The agents whose resume command was sent but that never reported. The
 * resumes that are done with leave the map; a terminal the person closed
 * leaves it too, and says nothing. */
export function awaiting(resumes, live, now) {
  const silent = [];
  for (const [address, resume] of resumes) {
    const record = live && live.get(address);
    if (!record) {
      resumes.delete(address);
      continue;
    }
    // The agent reports its state once it is running; an empty name is no report.
    const app = record.report && record.report.app;
    if (typeof app === "string" && app !== "") {
      resumes.delete(address);
      continue;
    }
    if (now - resume.when > REPORT_WAIT_MS) {
      silent.push(resume.agent);
      resumes.delete(address);
    }
  }
  return silent;
}

// `'claude' '--resume' 'abc'`: a command for a POSIX shell, each word quoted.
function posixLine(argv) {
  return argv.map((word) => `'${String(word).split("'").join("'\\''")}'`).join(" ");
}

// `& 'claude' '--resume' 'abc'`: the same for PowerShell.
function powershellLine(argv) {
  return `& ${argv.map(powershellQuote).join(" ")}`;
}

function powershellQuote(word) {
  let quoted = "'";
  for (const ch of String(word)) {
    if (PS_QUOTES.includes(ch)) quoted += ch;
    quoted += ch;
  }
  return quoted + "'";
}

// Whether a word holds a control character: the Cc range, as Rust counted it.
function holdsControl(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// The command's length is counted in bytes, as Rust counted it; the count is
// done here because the mod's runtime need not have a TextEncoder.
function utf8Length(text) {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
