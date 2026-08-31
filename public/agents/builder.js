// agentinstance agent builder — client logic. Pure functions are exported for testing;
// DOM wiring runs only in a browser (guarded by `typeof document`).

// One-click ready: pre-select sensible defaults so Launch is enabled instantly.
// The first harness/model in the catalog are used unless the caller overrides.
export function createState(catalog, { preselect = true } = {}) {
  return {
    catalog,
    harness: preselect ? (catalog.harnesses[0]?.id ?? null) : null,
    model: preselect ? (catalog.models[0]?.id ?? null) : null,
    // Every tool on by default: an agent that cannot reach the web or its own
    // shell is the surprising case, not the useful one. They stay togglable.
    capabilities: new Set(preselect ? catalog.capabilities.map((c) => c.id) : []),
    machine: catalog.defaultMachine,
  };
}

export function selectHarness(state, id) {
  state.harness = id;
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
  const heavy = ["generate_video", "image_to_video", "browser_use"];
  const usesHeavy = [...state.capabilities].some((c) => heavy.includes(c));
  if (usesHeavy && state.machine === "1gb")
    return "video/browser capabilities require at least the 2gb machine";
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
      el.onclick = () => { selectHarness(state, h.id); renderHarnesses(); renderSummary(); };
      box.appendChild(el);
    }
  }
  function renderModels() {
    const box = $("#models");
    box.innerHTML = "";
    for (const m of state.catalog.models) {
      const el = card(m.id, m.label, `$${m.priceIn}/$${m.priceOut} per 1M`, state.model === m.id);
      el.onclick = () => { selectModel(state, m.id); renderModels(); renderSummary(); };
      box.appendChild(el);
    }
  }
  function renderCapabilities() {
    const box = $("#capabilities");
    box.innerHTML = "";
    for (const c of state.catalog.capabilities) {
      const el = document.createElement("button");
      el.className = "chip" + (state.capabilities.has(c.id) ? " active" : "");
      el.dataset.id = c.id;
      el.textContent = c.id.replace(/_/g, " ");
      el.onclick = () => { toggleCapability(state, c.id); renderCapabilities(); renderSummary(); };
      box.appendChild(el);
    }
  }
  function renderMachines() {
    const box = $("#machines");
    box.innerHTML = "";
    for (const m of state.catalog.machines) {
      const el = card(m.id, m.label, `$${m.usdPerHour}/hr active`, state.machine === m.id);
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
