const defaults = {
  enabled: true,
  enabledDomains: [],
  disabledDomains: [],
  settings: { brightness: 100, contrast: 100, saturation: 100, blueLight: 0 }
};

const controls = ["brightness", "contrast", "saturation", "blueLight"];
let tab;
let hostname;

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

async function readConfig() {
  return { ...defaults, ...(await chrome.storage.sync.get(defaults)) };
}

function siteIsEnabled(state, domain) {
  return Boolean(domain && (state.enabledDomains.includes(domain) || (state.enabled && !state.disabledDomains.includes(domain))));
}

async function apply() {
  if (tab?.id && tab.url) {
    await chrome.runtime.sendMessage({ type: "apply-current-tab", tabId: tab.id, url: tab.url });
  }
}

function updateOutputs() {
  controls.forEach((name) => {
    document.getElementById(`${name}-output`).value = `${document.getElementById(name).value}%`;
  });
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  hostname = getDomain(tab?.url);
  const editable = Boolean(hostname && /^https?:/.test(tab.url));
  document.getElementById("domain").textContent = hostname || "Unsupported page";

  const state = await readConfig();
  document.getElementById("enabled").checked = state.enabled;
  document.getElementById("site-enabled").checked = siteIsEnabled(state, hostname);
  document.getElementById("site-enabled").disabled = !editable;
  document.getElementById("domain-label").textContent = editable ? "Enable on this site" : "This page cannot be styled";
  controls.forEach((name) => { document.getElementById(name).value = state.settings[name]; });
  updateOutputs();

  document.getElementById("enabled").addEventListener("change", async (event) => {
    await chrome.storage.sync.set({ enabled: event.target.checked });
    document.getElementById("site-enabled").checked = siteIsEnabled(await readConfig(), hostname);
    await chrome.runtime.sendMessage({ type: "apply-all-tabs" });
  });
  document.getElementById("site-enabled").addEventListener("change", async (event) => {
    const latest = await readConfig();
    const enabled = new Set(latest.enabledDomains);
    const disabled = new Set(latest.disabledDomains);
    enabled.delete(hostname);
    disabled.delete(hostname);
    if (event.target.checked !== latest.enabled) {
      (event.target.checked ? enabled : disabled).add(hostname);
    }
    await chrome.storage.sync.set({ enabledDomains: [...enabled], disabledDomains: [...disabled] });
    await apply();
  });
  controls.forEach((name) => document.getElementById(name).addEventListener("input", async () => {
    const latest = await readConfig();
    latest.settings[name] = Number(document.getElementById(name).value);
    await chrome.storage.sync.set({ settings: latest.settings });
    updateOutputs();
    await apply();
  }));
  document.getElementById("reset").addEventListener("click", async () => {
    await chrome.storage.sync.set({ settings: defaults.settings });
    controls.forEach((name) => { document.getElementById(name).value = defaults.settings[name]; });
    updateOutputs();
    await apply();
  });
}

init();
