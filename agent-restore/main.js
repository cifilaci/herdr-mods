// The agent restore mod.
//
// Two copies of it run. The copy in the layout block — the one without
// props().overlay — is the worker: it watches the terminals and resumes the
// agents the core recovered after a restart. The copy the app opens as an
// overlay shows what is installed and installs it.
//
// The rules live in decide.js. This file gathers the facts, asks decide.js,
// and acts; it decides nothing on its own.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, terminals, panes, spaces, hc, exec, notify, shared, setShared, settings, commands, theme, appHome, home, layout, window, readTextFile, writeTextFile } from "herdr";
import { factsFor, decide, recoveredByCore, personResumeTable, reference, awaiting, AGENT_NAMES, LABEL_PREFIX } from "./decide.js";
import { scriptText } from "./hook.js";
import { claudePluginFiles, mergeCodexHooks, stripCodexHooks, isHerdrHook, coreCandidates, psPath } from "./install.js";

// How often the worker looks at the terminals.
const POLL_MS = 2000;
// The settle: the core's own quiet period, before anything is typed.
const SETTLE_MS = 3000;
// How long a read is kept before it is taken again: the person's resume
// table and the core's age.
const READ_TTL_MS = 5000;
// The mod's own name: the folder it lives in, and the block a layout carries.
const MOD_NAME = "agent-restore";
// The shared state: the mod's own switch, and what the overlay says. It is
// keyed by the mod's own name.
const SHARED_KEY = MOD_NAME;
// The reasons a reference could not be used: the person is told, once, why
// the pane stayed a shell. The ordinary ones — no reference, no pane, Herdr
// started it, it is not a shell — are not news, and would fire on every
// terminal every two seconds. A pane whose space Herdr does not list is
// news: the mod says it instead of guessing where the pane is.
const SAID_REASONS = new Set([
  "it is on another machine",
  "Herdr does not know its space",
  "Herdr cannot resume that agent",
  "the resume command is not allowed",
  "Herdr cannot write a command for that shell",
]);

// The time of day, in the person's own timezone.
function clockOf(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// A JSON object out of a file's text: null when the file is missing or cannot
// be read at all.
function jsonObject(text) {
  if (!text) return null;
  try {
    const file = JSON.parse(text);
    if (!file || typeof file !== "object" || Array.isArray(file)) return null;
    return file;
  } catch {
    return null;
  }
}

export default class AgentRestore extends View {
  init(_props, cx) {
    this.startedAt = Date.now();
    // The addresses the mod already decided about: one candidate, one decision.
    this.acted = new Set();
    // The resumes that were sent, waiting for their agent to report.
    this.pending = new Map();
    this.standsDown = false;
    this.said = new Set();
    // The action the overlay is running, if any: the next one waits for it.
    this.pendingAction = null;
    // What Herdr itself does with the agents: "on", "off" or "none". It is
    // null until the app home's settings.json has been read.
    this.own = null;
    // The person's own resume table, and the core's age.
    this.table = null;
    this.tableAt = 0;
    this.core = null;
    // The poll's own work: one poll at a time.
    this.polling = false;
    // What Herdr itself does with the agents is read off the window's thread.
    // The poll waits for that answer: two implementations must never resume
    // the same terminal.
    let decided;
    this.decision = new Promise((resolve) => { decided = resolve; });
    this.isOverlay = Boolean(props()?.overlay);
    // The overlay never resumes anything.
    if (this.isOverlay) {
      // What is installed, and what the mod would install.
      this.info = null;
      decided();
      cx.spawn(async (cx) => { await this.refresh(cx); });
      return;
    }
    cx.spawn(async (cx) => {
      try {
        this.own = await this.herdrOwnRestore();
        if (this.own === "on") this.standDown("Herdr's own agent restore is on");
        else if (this.own === "off") this.takeOver("The mod takes over");
      } finally {
        decided();
      }
    });
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
  }

  // What Herdr itself does with the agents after a restart: "on" (it resumes
  // them), "off" (the person turned it off), or "none" (this build has no such
  // feature at all).
  //
  // The switch is the app home's own settings.json key — the app's settings()
  // is the resolved look and holds no such key. Reading the app's file is
  // read-only; the mod never writes it.
  async herdrOwnRestore() {
    if (!commands().some((c) => c?.name === "agent.integration")) return "none";
    const person = await this.personSettings();
    // The app home's own file is the authority. The app's resolved settings
    // are only a fallback for a file that cannot be read at all — they are
    // the look, and hold no such key.
    const flag = person === null ? settings().resume_agents_on_restore : person.resume_agents_on_restore;
    return flag === false ? "off" : "on";
  }

  // The app home's settings.json: the person's own settings, flat, with the
  // keys the app's own guide lists. Null when the file cannot be read.
  async personSettings() {
    const text = await readTextFile(this.join(appHome(), "settings.json")).catch(() => null);
    return jsonObject(text);
  }

  // The resume table: the mod's own, with the person's own programs.json
  // winning where it has a line. Read once and kept for a while.
  async resumeTable() {
    const now = Date.now();
    if (this.table && now - this.tableAt < READ_TTL_MS) return this.table;
    const text = await readTextFile(this.join(appHome(), "programs.json")).catch(() => null);
    this.table = personResumeTable(text);
    this.tableAt = now;
    return this.table;
  }

  // The mod stands down: Herdr itself resumes the agents, so the mod does not.
  standDown(reason) {
    this.standsDown = true;
    this.say("stand-down", {
      title: reason,
      body: "Herdr's own agent restore is installed on this build — the mod stands down.",
    });
  }

  // The person turned Herdr's own agent restore off: the mod takes over.
  takeOver(reason) {
    this.say("take-over", {
      title: reason,
      body: "Herdr's own agent restore is off — the mod takes over.",
    });
  }

  // A toast that is said once.
  say(key, toast) {
    if (this.said.has(key)) return;
    this.said.add(key);
    notify(toast);
  }

  // The mod's own state, in the shared storage: the switch, the agents the
  // hook is installed for, and what was restored. Both copies read it.
  state() {
    const state = shared(SHARED_KEY);
    if (state && typeof state === "object") return state;
    return { enabled: true, agents: ["claude", "codex"], last: null };
  }

  // The mod's own switch, in the shared state.
  switchedOff() {
    return this.state().enabled === false;
  }

  // The poll: a live read of the terminals, and the decision that follows. It
  // never redraws — the app redraws the mods by itself when the data changes.
  poll(cx) {
    if (this.standsDown) return;
    // One poll at a time: the last one is still asking the core.
    if (this.polling) return;
    this.polling = true;
    // The flag is cleared whatever happens: the spawned work clears it when
    // it is done, and a poll that never got that far clears it here — or
    // the poll would stop for the life of the mod.
    let handed = false;
    try {
      const now = Date.now();
      const list = terminals();
      const live = new Map(list.map((r) => [r.address, r]));
      // The resumes that are still waiting for their agent to report.
      for (const agent of awaiting(this.pending, live, now)) {
        notify({
          title: `${AGENT_NAMES[agent] ?? agent} did not start`,
          body: "the resume command was sent, but the agent never reported",
        });
      }
      if (!list.length) return;
      // The mod's own switch: when it is off, nothing is resumed and nothing
      // is said.
      if (this.switchedOff()) return;
      const ps = panes();
      const sp = spaces();
      // The decision needs the person's own resume table, which is read off
      // the window's thread.
      cx.spawn(async (cx) => {
        try {
          // What Herdr itself does is known before anything is resumed.
          await this.decision;
          if (this.standsDown) return;
          const table = await this.resumeTable();
          const candidates = [];
          for (const record of list) {
            const facts = factsFor(record, ps, sp, this.startedAt);
            const decision = decide(facts, table);
            if (decision.kind !== "resume") {
              this.explain(record, decision);
              continue;
            }
            candidates.push({ record, facts, decision });
          }
          for (const { record, facts, decision } of candidates) {
            if (this.acted.has(record.address)) continue;
            const plan = await this.consider(record, facts, decision);
            if (!plan) continue;
            // The settle: the terminal is read again before anything is typed.
            cx.timer.after(SETTLE_MS, (cx) => cx.spawn(async () => { await this.settle(plan); }));
          }
        } finally {
          this.polling = false;
        }
      });
      handed = true;
    } finally {
      if (!handed) this.polling = false;
    }
  }

  // A reference that could not be used: the person is told, once, why the
  // pane stayed a shell. The ordinary skips are not said — they are not news,
  // and they would fire on every terminal every two seconds.
  explain(record, decision) {
    if (!SAID_REASONS.has(decision.reason)) return;
    const key = `${record.address}:${decision.reason}`;
    if (this.said.has(key)) return;
    this.said.add(key);
    const found = reference(record.labels);
    const name = found ? (AGENT_NAMES[found.agent] ?? found.agent) : "the agent";
    notify({
      title: `${name} was not resumed`,
      body: `${decision.reason} — the pane stays a shell`,
    });
  }

  // One candidate: may it be resumed, and does the mod have to show that a
  // restart happened? The decision comes from decide.js; the poll already has
  // it, and passes it along.
  async consider(record, facts, decision = decide(facts)) {
    const address = record.address;
    if (this.acted.has(address)) return null;
    if (decision.kind !== "resume") return null;
    // What Herdr itself does, read again: the person may have turned Herdr's
    // own restore on since the mod started, and two implementations must
    // never resume the same terminal.
    const own = await this.herdrOwnRestore();
    if (own === "on") {
      this.standDown("Herdr's own agent restore is on");
      return null;
    }
    if (own === "off" && this.own !== "off") {
      this.own = "off";
      this.takeOver("The mod takes over");
    }
    // The evidence of a restart is one comparison: the running core
    // recovered this terminal. The core's start time is later than the
    // terminal's created_ms; a terminal the core created is younger than the
    // core, and a recovered one keeps the created_ms it always had. A core
    // that cannot be asked has no start time, and no evidence is never a
    // restart.
    const core = await this.coreAge();
    if (!recoveredByCore(record.created_ms, core ? core.startMs : null)) return null;
    // The decision is made: the candidate is marked now, before the settle,
    // so one terminal can never get two commands. A candidate whose evidence
    // was not there yet is not marked, and is decided again on a later poll.
    this.acted.add(address);
    return { address, agent: decision.agent, command: decision.command };
  }

  // The core's age, asked once and kept for a while: the poll asks for it
  // often, and the core's start time does not move. A core that cannot be
  // asked is not kept: it may answer in a moment, and one failed answer must
  // not lose a candidate for the life of the mod.
  async coreAge() {
    const now = Date.now();
    if (this.core && now - this.core.askedAt < READ_TTL_MS) return this.core;
    const uptimeMs = await this.coreUptimeMs();
    if (typeof uptimeMs !== "number") return { askedAt: now, uptimeMs: null, startMs: null };
    this.core = {
      askedAt: now,
      uptimeMs,
      startMs: now - uptimeMs,
    };
    return this.core;
  }

  // The core's age: the top-level uptime_ms, with core.uptime_ms as the
  // fallback. A core that cannot be asked is unknown, and unknown is never a
  // restart.
  async coreUptimeMs() {
    try {
      const r = await hc(["server", "status", "--json"]);
      if (r.code !== 0) return null;
      const data = JSON.parse(r.stdout);
      const ms = data?.uptime_ms ?? data?.core?.uptime_ms;
      return typeof ms === "number" ? ms : null;
    } catch {
      return null;
    }
  }

  // The settle: the terminal is read again, and only a shell is written to.
  async settle(plan) {
    const record = terminals().find((r) => r.address === plan.address);
    if (!record) return;                        // the person closed it
    if (record.program?.shell !== true) return; // an agent is running here now
    await this.resume(plan.address, plan.agent, plan.command);
  }

  // The send: the core pastes the command and presses Enter.
  async resume(address, agent, command) {
    const name = AGENT_NAMES[agent] ?? agent;
    let r;
    try {
      r = await hc(["send", address, command]);
    } catch (e) {
      r = { code: 1, stdout: "", stderr: String(e?.message ?? e) };
    }
    if (r.code !== 0) {
      // A refused send is said out loud, and never retried.
      notify({ title: "Not resumed", body: `${name}: ${(r.stderr || r.stdout || "the core refused the command").trim()}` });
      return;
    }
    notify({ title: `Sent the resume command for ${name}`, body: "the resume command was sent" });
    this.pending.set(address, { agent, when: Date.now() });
    this.remember(agent, address);
  }

  // What was restored, for the overlay to say.
  remember(agent, address) {
    setShared(SHARED_KEY, { ...this.state(), last: { agent, address, when: Date.now() } });
  }

  // ---- The overlay: what is installed, and the buttons that change it.

  // The overlay's facts: what is installed, for which agent, which core the
  // hook reports through, whether the shown layout carries the block, and the
  // mod's own switch.
  async status() {
    const paths = await this.paths();
    const core = await this.resolveCore();
    const agents = {};
    for (const agent of Object.keys(AGENT_NAMES)) {
      agents[agent] = await this.agentStatus(agent, paths);
    }
    const state = this.state();
    // What Herdr itself does is read again every time: the person may have
    // turned it on while the overlay was open, and the line must not be a
    // stale one.
    this.own = await this.herdrOwnRestore();
    return {
      core: core.path,
      coreError: core.error,
      agents,
      hasBlock: this.hasBlock(),
      enabled: state.enabled !== false,
      own: this.own,
      last: state.last ?? null,
    };
  }

  // The facts, read again.
  async refresh(cx) {
    this.info = await this.status();
    cx.notify();
  }

  // One action, and then the facts are read again. The overlay never keeps a
  // cx: the refresh happens inside the spawn, with the spawn's own cx, which
  // lives as long as the task — a click's cx is good only while the click
  // runs. A second click waits for the first: two installs must not
  // interleave, or the second one is refused for the wrong reason.
  act(cx, action) {
    const previous = this.pendingAction ?? Promise.resolve();
    // The action, serialized: the next click waits for this one.
    const next = previous.then(async () => { await action(); });
    this.pendingAction = next.catch(() => {});
    cx.spawn(async (cx) => {
      try {
        await next;              // the mutation, serialized
      } finally {
        // The facts are read again whether the action worked or not: the
        // overlay must not show facts that are not true.
        await this.refresh(cx);  // the read, with the spawn's own cx
      }
    });
  }

  // The platform: the hook's language, and its extension.
  platform() {
    return window()?.platform === "windows" ? "ps1" : "sh";
  }

  // A path joined with the platform's own separator.
  join(...parts) {
    const sep = this.platform() === "ps1" ? "\\" : "/";
    let out = "";
    parts.forEach((part, i) => {
      const piece = String(part).replace(/[\\/]+$/, "");
      if (i === 0) {
        out = piece;
        return;
      }
      out += sep + piece.replace(/^[\\/]+/, "");
    });
    return out;
  }

  // One environment variable, read through exec: the mod API has no
  // process.env, and exec runs with the person's real environment.
  async env(name) {
    const r = this.platform() === "ps1"
      ? await exec("powershell.exe", ["-NoProfile", "-Command", `$env:${name}`]).catch(() => null)
      : await exec("sh", ["-c", `printf %s "$${name}"`]).catch(() => null);
    return String(r?.stdout ?? "").trim();
  }

  // The paths the mod's own files live at: the app's home for the hook, the
  // agents' own homes for their registration.
  async paths() {
    const claude = (await this.env("CLAUDE_CONFIG_DIR")) || this.join(home(), ".claude");
    const codex = (await this.env("CODEX_HOME")) || this.join(home(), ".codex");
    const plugin = this.join(claude, "skills", "herdr-resume");
    return {
      claudeHome: claude,
      codexHome: codex,
      pluginDir: plugin,
      pluginJson: this.join(plugin, ".claude-plugin", "plugin.json"),
      pluginHooks: this.join(plugin, "hooks", "hooks.json"),
      codexHooks: this.join(codex, "hooks.json"),
    };
  }

  // The folder that holds the hook: the app's own home, one folder per
  // agent, the label in its name — so the mod's own entry is told from the
  // person's own.
  scriptDir(agent) {
    return this.join(appHome(), "integrations", LABEL_PREFIX + agent);
  }

  // The hook script itself.
  scriptPath(agent) {
    return this.join(this.scriptDir(agent), `herdr-resume.${this.platform()}`);
  }

  // The core binary, the way the app finds it: the configured path first,
  // then HERDR_CORE_DIRS, then the PATH and the usual folders — every
  // candidate validated by running `--version`, the app's own test. The path
  // is shown, because both hook scripts swallow their own errors: a wrong
  // path means the agent never reports and nothing would say so.
  //
  // The configured path is the app home's own settings.json key, with `~/`
  // expanded the way the app expands it.
  async resolveCore() {
    const platform = this.platform();
    const person = await this.personSettings();
    const configured = typeof person?.core === "string"
      ? person.core
      : (typeof settings().core === "string" ? settings().core : undefined);
    const env = {
      configured,
      coreDirs: await this.env("HERDR_CORE_DIRS"),
      path: await this.env("PATH"),
      home: home(),
    };
    if (platform === "ps1") env.localAppData = await this.env("LOCALAPPDATA");
    for (const candidate of coreCandidates(platform, env)) {
      if (await this.isCore(candidate)) return { path: candidate, error: null };
    }
    return { path: null, error: "No herdr-core was found — the hook cannot report." };
  }

  // The app's own test for a core: the version it prints starts with "hc ".
  async isCore(path) {
    const r = await exec(path, ["--version"]).catch(() => null);
    return Boolean(r && r.code === 0 && String(r.stdout ?? "").trim().startsWith("hc "));
  }

  // What is installed for one agent: the agent's own registration, and the
  // hook script. Both are needed — a registration without the script reports
  // nothing, and a script without a registration is never run.
  async agentStatus(agent, paths) {
    const file = agent === "claude" ? paths.pluginHooks : paths.codexHooks;
    const registered = this.registered(await readTextFile(file).catch(() => null), agent);
    const script = this.scriptPath(agent);
    const there = (await readTextFile(script).catch(() => null)) !== null;
    return { installed: registered && there };
  }

  // Whether this hooks file holds the mod's own entry for this agent: the
  // label in the command is what tells it from the person's own.
  registered(text, agent) {
    if (!text) return false;
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      return false;
    }
    const events = file && typeof file === "object" ? file.hooks : null;
    if (!events || typeof events !== "object") return false;
    for (const list of Object.values(events)) {
      if (!Array.isArray(list)) continue;
      for (const group of list) {
        for (const hook of group?.hooks ?? []) {
          if (isHerdrHook(hook, agent)) return true;
        }
      }
    }
    return false;
  }

  // Whether the shown layout carries the mod's block: the mod runs only when
  // a layout has one.
  hasBlock() {
    return this.findBlock(layout());
  }

  findBlock(node) {
    if (!node || typeof node !== "object") return false;
    if (node.content?.mod === MOD_NAME) return true;
    for (const child of node.children ?? []) {
      if (this.findBlock(child)) return true;
    }
    return false;
  }

  // The install: the hook script, and the agent's own registration. Nothing
  // of the person's own is rewritten.
  async install(agent) {
    const name = AGENT_NAMES[agent];
    if (!name) {
      notify({ title: "Not installed", body: `Herdr does not know the agent ${agent}` });
      return false;
    }
    const core = await this.resolveCore();
    if (!core.path) {
      notify({
        title: "No herdr-core found",
        body: `${name}: the hook needs the core binary — put herdr-core on the PATH, or name it in Herdr's settings.`,
      });
      return false;
    }
    const paths = await this.paths();
    const script = this.scriptPath(agent);
    // One refusal, said the same way every time — with the app's own words,
    // so a permission error and a file that changed under the mod are not
    // the same thing.
    const refused = (error) => notify({
      title: "Not installed",
      body: `${name}: the file was not written — ${error}`,
    });
    const wrote = await this.writeOver(script, scriptText(this.platform(), core.path, agent));
    if (!wrote.ok) {
      refused(wrote.error);
      return false;
    }
    if (agent === "claude") {
      const files = claudePluginFiles(script);
      const one = await this.writeOver(paths.pluginJson, files.pluginJson);
      const two = one.ok ? await this.writeOver(paths.pluginHooks, files.hooksJson) : one;
      if (!two.ok) {
        refused(two.error);
        return false;
      }
    } else {
      const existing = await readTextFile(paths.codexHooks).catch(() => null);
      let merged;
      try {
        merged = mergeCodexHooks(existing, script);
      } catch {
        notify({ title: "Not installed", body: `${name}: the hooks file is not valid JSON — it was not changed.` });
        return false;
      }
      const saved = await this.write(paths.codexHooks, merged, existing);
      if (!saved.ok) {
        refused(saved.error);
        return false;
      }
    }
    this.setAgent(agent, true);
    notify({
      title: `Installed the hook for ${name}`,
      body: "the hook takes effect for the next agent you start",
    });
    return true;
  }

  // The removal: the mod's own entry, and the mod's own folders. Nothing of
  // the person's own is touched.
  async remove(agent) {
    const name = AGENT_NAMES[agent];
    if (!name) {
      notify({ title: "Not removed", body: `Herdr does not know the agent ${agent}` });
      return false;
    }
    const paths = await this.paths();
    const problems = [];
    let removed = 0;
    if (agent === "codex") {
      const existing = await readTextFile(paths.codexHooks).catch(() => null);
      if (existing !== null) {
        let stripped = null;
        try {
          stripped = stripCodexHooks(existing);
        } catch {
          problems.push("the hooks file is not valid JSON, so the mod's entry was left in it");
        }
        if (stripped !== null) {
          const saved = await this.write(paths.codexHooks, stripped, existing);
          if (saved.ok) removed++;
          else problems.push(`the hooks file was not written, so the mod's entry was left in it: ${saved.error}`);
        }
      }
    }
    // The mod's own folders: the script's, and the Claude plugin's.
    const folders = [[this.scriptDir(agent), [this.scriptPath(agent)]]];
    if (agent === "claude") folders.push([paths.pluginDir, [paths.pluginJson, paths.pluginHooks]]);
    for (const [folder, witnesses] of folders) {
      const outcome = await this.removeFolder(folder, witnesses);
      if (outcome.error) problems.push(outcome.error);
      if (outcome.removed) removed++;
    }
    this.setAgent(agent, false);
    if (problems.length) {
      notify({ title: "Not fully removed", body: problems.join(" ") });
      return false;
    }
    notify({
      title: removed ? `Removed the hook for ${name}` : `Nothing to remove for ${name}`,
      body: removed ? "the agent will not report its session any more" : "there was nothing of the mod's own there",
    });
    return true;
  }

  // One write of a file the mod has not read yet: it is read first, and the
  // text that was read is what the write expects to find, so a file that
  // changed under the mod is refused instead of overwritten.
  async writeOver(path, text) {
    const found = await readTextFile(path).catch(() => null);
    return this.write(path, text, found);
  }

  // The write itself: the expected text is what the file must still hold.
  // A file that changed under the mod is refused, and the caller says so —
  // with the app's own message, so a permission error and a stale file are
  // told apart.
  async write(path, text, expected) {
    try {
      await writeTextFile(path, text, expected);
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // The mod's own folder, gone: the mod API has no delete, so the platform's
  // own remove command takes it. A folder that is still there afterwards is
  // reported, not left silently.
  async removeFolder(folder, witnesses) {
    if (!(await this.folderThere(witnesses))) return { removed: false, error: null };
    // The PowerShell command is one string: powershell.exe re-joins its
    // arguments with spaces and parses them again, so the path has to be
    // quoted inside it — a path with a space would otherwise arrive in
    // pieces, and nothing would be removed.
    const r = this.platform() === "ps1"
      ? await exec("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath ${psPath(folder)} -Recurse -Force`]).catch(() => null)
      : await exec("rm", ["-rf", folder]).catch(() => null);
    if (await this.folderThere(witnesses)) {
      const why = r?.stderr ? `: ${String(r.stderr).trim()}` : "";
      return { removed: false, error: `cannot remove ${folder}${why}` };
    }
    return { removed: true, error: null };
  }

  // Whether the mod's own folder is still there: one of the files in it.
  async folderThere(witnesses) {
    for (const path of witnesses) {
      if ((await readTextFile(path).catch(() => null)) !== null) return true;
    }
    return false;
  }

  // The agents the hook is installed for, in the shared state.
  setAgent(agent, on) {
    const state = this.state();
    const agents = new Set(Array.isArray(state.agents) ? state.agents : []);
    if (on) agents.add(agent);
    else agents.delete(agent);
    setShared(SHARED_KEY, { ...state, agents: [...agents] });
  }

  // The mod's own switch: the restore itself. Both copies read it.
  toggle() {
    const state = this.state();
    const enabled = !state.enabled;
    setShared(SHARED_KEY, { ...state, enabled });
    notify({
      title: enabled ? "The restore is on" : "The restore is off",
      body: enabled ? "the mod resumes the agents after a restart" : "the mod resumes nothing",
    });
    return enabled;
  }

  render(cx) {
    // The worker draws nothing: its block takes no room.
    if (!this.isOverlay) return div();
    const t = theme();
    const info = this.info;
    // What was restored last is read from the shared state, not from the
    // last snapshot: a restore that happened a moment ago is said at once.
    const last = this.state().last ?? null;
    return v_flex()
      .id("agent-restore")
      .size_full()
      .min_h(0)
      .p(14)
      .gap(8)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(13).font_semibold().child("Agent restore"))
        .child(div().text_size(11).text_color(t.dim).child("herdr-resume")))
      .child(div().text_size(12).text_color(t.muted).child(this.statusLine()))
      .child(this.coreLine(t, info))
      .child(this.agentLine(t, "claude", info))
      .child(this.agentLine(t, "codex", info))
      .child(this.layoutLine(t, info))
      .child(this.switchLine(t, info))
      .when(Boolean(last), (el) => el.child(this.lastLine(t, last)))
      .child(div().text_size(11).text_color(t.dim)
        .child("The hook takes effect for the next agent you start. Codex asks for trust the first time it runs a hook it has not seen."));
  }

  // The overlay's one line: where the mod stands.
  statusLine() {
    const own = this.info?.own ?? this.own;
    if (own === "on") return "Herdr's own agent restore is on — the mod stands down.";
    if (own === "off") return "Herdr's own agent restore is off — the mod takes over.";
    return "Watching for the agents to come back.";
  }

  // The core the hook would report through.
  coreLine(t, info) {
    if (!info) return div().text_size(12).text_color(t.dim).child("Looking for the core…");
    if (!info.core) return div().text_size(12).text_color(t.blocked).child(info.coreError);
    return div().text_size(12).text_color(t.muted).child(`Core: ${info.core}`);
  }

  // One agent: what is installed for it, and the buttons that change that.
  agentLine(t, agent, info) {
    const name = AGENT_NAMES[agent] ?? agent;
    const state = info?.agents?.[agent];
    const what = !info ? "…" : state?.installed ? "installed" : "not installed";
    return h_flex().gap(8).items_center()
      .child(div().flex_1().text_size(12).text_color(t.foreground).child(`${name} — ${what}`))
      .child(this.button(`install-${agent}`, "Install", t, (_e, cx) => this.act(cx, () => this.install(agent))))
      .child(this.button(`remove-${agent}`, "Remove", t, (_e, cx) => this.act(cx, () => this.remove(agent))));
  }

  // Whether the shown layout carries the mod's block.
  layoutLine(t, info) {
    if (!info) return div().text_size(12).text_color(t.dim).child("Looking at the layout…");
    return div().text_size(12).text_color(t.muted).child(info.hasBlock
      ? "This layout carries the agent-restore block."
      : "This layout has no agent-restore block — add one to your layout, or the mod will not run.");
  }

  // The mod's own switch.
  switchLine(t, info) {
    const on = info ? info.enabled : true;
    return h_flex().gap(8).items_center()
      .child(div().flex_1().text_size(12).text_color(t.foreground)
        .child(`Restore the agents after a restart: ${on ? "on" : "off"}`))
      .child(this.button("toggle", on ? "Turn off" : "Turn on", t, (_e, cx) => this.act(cx, async () => { this.toggle(); })));
  }

  // What was restored last, for the person to see.
  lastLine(t, last) {
    const name = AGENT_NAMES[last.agent] ?? last.agent;
    return div().text_size(12).text_color(t.dim)
      .child(`Last restored: ${name} in ${last.address}, at ${clockOf(last.when)}.`);
  }

  // A button, in the theme's colors.
  button(id, label, t, onClick) {
    return h_flex().id(id).h(26).px(10).items_center().rounded(7).border_1().border_color(t.input)
      .bg(t.raised).text_color(t.foreground).text_size(12).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }
}
