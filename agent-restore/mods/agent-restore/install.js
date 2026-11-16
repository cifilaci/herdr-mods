// The installer's rules: the command that runs the hook, the Claude plugin's
// two files, the merge into and the removal from the person's own Codex hooks
// file, and the paths the core binary may be at. Pure — it computes the texts
// and the paths, and writes nothing.
//
// The rules are the patch's own, ported rule for rule: `src/integrations.rs`
// and `src/core_bin.rs` on the patch branch.

import { LABEL_PREFIX } from "./decide.js";

/** The events the mod registers a hook for, and the action each one runs. */
const EVENTS = [["SessionStart", "session"], ["SessionEnd", "end"]];

/** The agent the Codex file belongs to: the mod's own entry is the Codex one. */
const CODEX_AGENT = "codex";

/** How long a hook may take. */
const TIMEOUT = 10;

/** The command that runs the hook: the script's own path, and the action. */
export function hookCommand(platform, scriptPath, action) {
  if (platform === "ps1") {
    // The script lives in the person's own home, so RemoteSigned runs it
    // (unsigned local scripts are allowed, downloaded ones are not); the
    // default Windows policy, Restricted, blocks every script. Not Bypass:
    // this hook has no reason to turn the guard off.
    return `powershell -NoProfile -ExecutionPolicy RemoteSigned -File "${scriptPath}" ${action}`;
  }
  return `sh "${scriptPath}" ${action}`;
}

/** The Claude plugin's two files: the plugin itself, and the hooks it runs. */
export function claudePluginFiles(scriptPath) {
  const platform = platformOf(scriptPath);
  const hooks = {};
  for (const [event, action] of EVENTS) {
    hooks[event] = [{ hooks: [hookEntry(platform, scriptPath, action)] }];
  }
  return {
    pluginJson: pretty({
      name: "herdr-resume",
      description: "Herdr's agent integration: report this agent's session so Herdr can resume it after a restart.",
      version: "1",
    }),
    hooksJson: pretty({ hooks }),
  };
}

/** The person's own Codex hooks file, with the mod's own entry merged in. */
export function mergeCodexHooks(existing, scriptPath) {
  const file = readHooks(existing);
  const events = eventsOf(file);
  const platform = platformOf(scriptPath);
  for (const [event, action] of EVENTS) {
    const groups = events[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      throw new Error(`the hooks file has an unexpected ${event}`);
    }
    const list = Array.isArray(groups) ? groups : [];
    // The mod's own hook goes; a group that held one of ours and one of the
    // person's keeps the person's. The mod's own entry goes first, and a
    // second install replaces it instead of adding another.
    stripHerdrGroups(list, CODEX_AGENT);
    list.unshift({ hooks: [hookEntry(platform, scriptPath, action)] });
    events[event] = list;
  }
  return pretty(file);
}

/** The person's own Codex hooks file, with the mod's own entry taken out.
 * Null when the file holds nothing of ours: there is nothing to write. */
export function stripCodexHooks(existing) {
  if (existing === null || existing === undefined) return null;
  const file = readHooks(existing);
  const events = file.hooks;
  if (!events || typeof events !== "object" || Array.isArray(events)) return null;
  let removed = false;
  for (const [event] of EVENTS) {
    const list = events[event];
    if (!Array.isArray(list)) continue;
    if (stripHerdrGroups(list, CODEX_AGENT)) removed = true;
    // An event that holds nothing else is gone.
    if (list.length === 0) delete events[event];
  }
  return removed ? pretty(file) : null;
}

/** Whether this hook is the mod's own: it runs the mod's script, whose path
 * carries the label, so the label in the command is what marks the entry as
 * ours.
 *
 * The path and this marker are one thing. If the label ever left the path,
 * removing the integration would leave the entry behind. */
export function isHerdrHook(hook, agent) {
  if (!hook || typeof hook !== "object") return false;
  const command = hook.command;
  return typeof command === "string" && command.includes(LABEL_PREFIX + agent);
}

/** A path, quoted for PowerShell: it is one word there, and a single quote
 * inside it is doubled. */
export function psPath(path) {
  return `'${String(path).split("'").join("''")}'`;
}

/** The paths the core binary may be at, in the order the app looks: the
 * configured path first, then the core's own folders, then PATH's folders,
 * then the usual ones. In every folder `herdr-core` is tried before `hc` — a
 * Windows zip ships only `herdr-core.exe`. */
export function coreCandidates(platform, env) {
  const windows = platform === "ps1";
  // The list of folders is split on the list's own separator; a folder's own
  // parts are joined with the platform's separator.
  const sep = windows ? "\\" : "/";
  const listSep = windows ? ";" : ":";
  const candidates = [];
  if (env.configured) candidates.push(expandHome(env.configured, env.home, sep));
  const dirs = [
    ...splitPath(env.coreDirs, listSep),
    ...splitPath(env.path, listSep),
    ...usualDirs(env, windows, sep),
  ];
  for (const dir of dirs) {
    candidates.push(joinPath(dir, windows ? "herdr-core.exe" : "herdr-core", sep));
    candidates.push(joinPath(dir, windows ? "hc.exe" : "hc", sep));
  }
  return candidates;
}

// One hook entry: the command that runs the hook, and how long it may take.
function hookEntry(platform, scriptPath, action) {
  return { type: "command", command: hookCommand(platform, scriptPath, action), timeout: TIMEOUT };
}

// The platform a script path belongs to: its extension says which hook it is.
function platformOf(scriptPath) {
  return String(scriptPath).endsWith(".ps1") ? "ps1" : "sh";
}

// The person's hooks file. A missing file is an empty one.
function readHooks(text) {
  if (text === null || text === undefined) return {};
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    throw new Error(`the hooks file is not valid JSON: ${error.message}`);
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("the hooks file is not a JSON object");
  }
  return file;
}

// The events of the person's hooks file, ready to be changed.
function eventsOf(file) {
  if (file.hooks === undefined) file.hooks = {};
  if (!file.hooks || typeof file.hooks !== "object" || Array.isArray(file.hooks)) {
    throw new Error("the hooks file has an unexpected hooks entry");
  }
  return file.hooks;
}

// Removes the mod's own hook from the groups. The person's own hooks stay; a
// group that held nothing but the mod's hook is gone. Whether anything was
// removed.
function stripHerdrGroups(groups, agent) {
  let removed = false;
  const kept = [];
  for (const group of groups) {
    const hooks = group && Array.isArray(group.hooks) ? group.hooks : null;
    if (!hooks) {
      kept.push(group);
      continue;
    }
    const ours = hooks.some((hook) => isHerdrHook(hook, agent));
    if (!ours) {
      kept.push(group);
      continue;
    }
    removed = true;
    const mine = hooks.filter((hook) => !isHerdrHook(hook, agent));
    // A group that held nothing but the mod's hook is gone.
    if (mine.length === 0) continue;
    group.hooks = mine;
    kept.push(group);
  }
  groups.length = 0;
  groups.push(...kept);
  return removed;
}

// A JSON file as it is written: two spaces, and a last newline.
function pretty(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

// `~/` is the person's own home; every other path is taken as it is.
function expandHome(path, home, sep) {
  const rest = String(path).startsWith("~/") ? String(path).slice(2) : null;
  return rest === null ? String(path) : joinPath(home, rest, sep);
}

// The folders of a PATH-like list: empty ones are no folders.
function splitPath(text, listSep) {
  if (!text) return [];
  return String(text).split(listSep).filter((dir) => dir !== "");
}

// Where herdr-core gets installed: its own installer and Herdr 1.x's
// (~/.local/bin), Homebrew, mise, Nix, cargo.
function usualDirs(env, windows, sep) {
  if (windows) {
    const local = env.localAppData || joinPath(env.home, "AppData" + sep + "Local", sep);
    return [joinPath(local, "Programs" + sep + "herdr-core", sep), joinPath(env.home, ".cargo" + sep + "bin", sep)];
  }
  return [
    joinPath(env.home, ".local/bin", sep),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    joinPath(env.home, ".local/share/mise/shims", sep),
    joinPath(env.home, ".nix-profile/bin", sep),
    "/run/current-system/sw/bin",
    joinPath(env.home, ".cargo/bin", sep),
  ];
}

// A path joined with the platform's own separator.
function joinPath(dir, name, sep) {
  const end = String(dir);
  if (end.endsWith("/") || end.endsWith("\\")) return end + name;
  return end + sep + name;
}
