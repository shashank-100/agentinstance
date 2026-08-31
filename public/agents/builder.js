// agentinstance agent builder — client logic. Pure functions are exported for testing;
// DOM wiring runs only in a browser (guarded by `typeof document`).

// One-click ready: pre-select sensible defaults so Launch is enabled instantly.
// The first harness/model in the catalog are used unless the caller overrides.
/** Can this harness actually drive this model? */
export function supportsModel(catalog, harness, modelId) {
  const allowed = catalog.harnessModels?.[harness];
  return allowed ? allowed.includes(modelId) : true;
}

/** Is there any harness at all that can run this model? */
export function runnableByAny(catalog, modelId) {
  const map = catalog.harnessModels;
  if (!map) return true;
  return Object.values(map).some((ids) => ids.includes(modelId));
}

/**
 * The models a harness can run, in that harness's own order — the first is its
 * default. Ordered by the mapping rather than by filtering the catalog, so an
 * unrelated catalog ordering cannot decide which model an agent starts on.
 */
export function modelsFor(catalog, harness) {
  const allowed = catalog.harnessModels?.[harness];
  // No mapping for this harness: everything is fair game.
  if (!allowed) return catalog.models;
  return allowed
    .map((id) => catalog.models.find((m) => m.id === id))
    .filter((m) => m !== undefined);
}

export function createState(catalog, { preselect = true } = {}) {
  const harness = preselect ? (catalog.harnesses[0]?.id ?? null) : null;
  return {
    catalog,
    harness,
    model: preselect ? (modelsFor(catalog, harness)[0]?.id ?? null) : null,
    // Every agent gets every tool. These are not a menu: a shell and the web
    // are what make it an agent rather than a chat box.
    capabilities: new Set(catalog.capabilities.map((c) => c.id)),
    machine: catalog.defaultMachine,
  };
}

export function selectHarness(state, id) {
  state.harness = id;
  // The two CLIs speak different APIs, so a model valid for one is a 404 on
  // the other. Move to this harness's own default rather than keeping a
  // selection it cannot run.
  const allowed = modelsFor(state.catalog, id);
  if (!allowed.some((m) => m.id === state.model)) {
    state.model = allowed[0]?.id ?? null;
  }
  return state;
}
export function selectModel(state, id) {
  state.model = id;
  return state;
}
export function toggleCapability(state, id) {
  if (state.capabilities.has(id)) state.capabilities.delete(id);
  else state.capabilities.add(id);
  return state;
}
export function selectMachine(state, id) {
  state.machine = id;
  return state;
}

// Mirrors server-side estimateMonthCost: usdPerHour * 24 * 30.
export function estimateMonthly(state) {
  const m = state.catalog.machines.find((x) => x.id === state.machine);
  if (!m) return 0;
  return Math.round(m.usdPerHour * 24 * 30 * 100) / 100;
}

// Mirrors server-side checkCompatible: returns null if OK, else a message.
export function compatibility(state) {
  if (!state.harness) return "Choose a harness";
  if (!state.model) return "Pick a model";
  return null;
}

export function toSpec(state) {
  return {
    harness: state.harness,
    model: state.model,
    capabilities: [...state.capabilities],
    machine: state.machine,
  };
}

export function summary(state) {
  const model = state.catalog.models.find((m) => m.id === state.model);
  const machine = state.catalog.machines.find((m) => m.id === state.machine);
  return {
    harness: state.harness ?? "—",
    model: model?.label ?? "—",
    capabilities: [...state.capabilities],
    machine: machine ? machine.label : "—",
    estMonthly: estimateMonthly(state),
    ready: compatibility(state) === null,
  };
}

// ---- browser wiring ----
if (typeof document !== "undefined") {
  const $ = (s) => document.querySelector(s);
  let state;

  async function boot() {
    const catalog = await (await fetch("/catalog")).json();
    state = createState(catalog);
    renderHarnesses();
    renderModels();
    renderCapabilities();
    renderMachines();
    renderSummary();
  }

  function card(sel, label, desc, active) {
    const el = document.createElement("button");
    el.className = "card" + (active ? " active" : "");
    el.dataset.id = sel;
    el.innerHTML = `<div class="card-t">${label}</div><div class="card-d">${desc}</div>`;
    return el;
  }

  function renderHarnesses() {
    const box = $("#harnesses");
    box.innerHTML = "";
    for (const h of state.catalog.harnesses) {
      const el = card(h.id, h.id, h.desc, state.harness === h.id);
      el.onclick = () => { selectHarness(state, h.id); renderHarnesses(); renderModels(); renderSummary(); };
      box.appendChild(el);
    }
  }
  function renderModels() {
    const box = $("#models");
    box.innerHTML = "";
    // Every model stays visible: hiding them makes the list look arbitrary.
    // The ones this harness cannot drive are shown disabled, with the reason.
    for (const m of state.catalog.models) {
      const ok = supportsModel(state.catalog, state.harness, m.id);
      // An OAuth model has no per-token rate to quote — leave the line blank
      // rather than printing $0, which would read as free.
      const rate = m.oauth ? "" : `$${m.priceIn}/$${m.priceOut} per 1M`;
      // Distinguish "pick another harness" from "nothing can run this": with
      // one harness shipped, most models fall in the second case and telling
      // the user to switch harness would send them looking for one.
      const why = runnableByAny(state.catalog, m.id)
        ? "needs a different harness"
        : "no harness available yet";
      const el = card(m.id, m.label, ok ? rate : why, state.model === m.id);
      el.disabled = !ok;
      if (!ok) {
        el.classList.add("off");
        el.title = why;
      } else {
        el.onclick = () => { selectModel(state, m.id); renderModels(); renderSummary(); };
      }
      box.appendChild(el);
    }
  }
  function renderCapabilities() {
    const box = $("#capabilities");
    box.innerHTML = "";
    // Shown, not chosen: every agent has all of these.
    for (const c of state.catalog.capabilities) {
      const el = document.createElement("span");
      el.className = "chip active";
      el.title = c.desc ?? "";
      el.textContent = c.id.replace(/_/g, " ");
      box.appendChild(el);
    }
  }
  function renderMachines() {
    const box = $("#machines");
    box.innerHTML = "";
    for (const m of state.catalog.machines) {
      // Spell out the hardware: "4 GB" alone hid that the tiers differ in CPU
      // too, which is what actually limits anything run_shell does.
      const spec = `${m.vcpu} vCPU · ${m.ramGb} GB RAM · ${m.diskGb} GB disk`;
      const el = card(m.id, m.label, `${spec}<br>$${m.usdPerHour}/hr active`, state.machine === m.id);
      el.onclick = () => { selectMachine(state, m.id); renderMachines(); renderSummary(); };
      box.appendChild(el);
    }
  }
  function renderSummary() {
    const s = summary(state);
    $("#s-harness").textContent = s.harness;
    $("#s-model").textContent = s.model;
    $("#s-caps").textContent = s.capabilities.length ? s.capabilities.join(", ") : "none";
    $("#s-machine").textContent = s.machine;
    $("#s-cost").textContent = `~$${s.estMonthly}/mo`;
    const msg = compatibility(state);
    const btn = $("#launch");
    btn.disabled = !s.ready;
    $("#compat").textContent = msg ?? "Compatible ✔";
  }

  let launching = false;

  /**
   * Claim the right to launch, synchronously.
   *
   * The guard has to flip before any `await`: a burst of clicks all run to
   * completion before the first one yields, so an async check lets the second
   * and third through and creates duplicate agents.
   */
  function claimLaunch() {
    if (launching) return false;
    launching = true;
    const btn = $("#launch");
    btn.disabled = true;
    btn.textContent = "Launching…";
    return true;
  }

  async function launch() {
    if (!claimLaunch()) return;
    const btn = $("#launch");

    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toSpec(state)),
      });
      const data = await res.json();
      if (!res.ok) {
        $("#result").textContent = `Error: ${data.error}`;
        return;
      }
      // Go straight to the new agent — the builder's job is done, and staying
      // here is what invites a second click.
      $("#result").textContent = `Launched ${data.id} — opening chat…`;
      location.href = `/chat?id=${encodeURIComponent(data.id)}`;
    } catch (e) {
      $("#result").textContent = `Error: ${e}`;
    } finally {
      // Only re-enable on failure; a success is navigating away.
      if (!location.href.includes("/chat")) {
        launching = false;
        btn.disabled = false;
        btn.textContent = "⚡ Launch agent";
      }
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    boot();
    $("#launch").addEventListener("click", () => void launch());
    // One-key launch: ⌘↵ / Ctrl+↵
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void launch();
    });
  });
}
