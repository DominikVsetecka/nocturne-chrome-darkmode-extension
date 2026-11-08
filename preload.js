// Runs before a site's document is built. Full semantic colour analysis still
// happens afterwards, once the page's computed styles are available.
(async () => {
  const defaults = { enabled: true, enabledDomains: [], disabledDomains: [] };
  const { enabled, enabledDomains, disabledDomains } = await chrome.storage.sync.get(defaults);
  if (!enabledDomains.includes(location.hostname) && (!enabled || disabledDomains.includes(location.hostname))) return;

  const root = document.documentElement;
  if (!root || document.getElementById("nocturne-dev-preload")) return;
  root.setAttribute("data-nocturne-preload", "on");

  const style = document.createElement("style");
  style.id = "nocturne-dev-preload";
  style.textContent = `
    html[data-nocturne-preload="on"] { background: #121418 !important; color-scheme: dark; }
    html[data-nocturne-preload="on"] body { background: #121418 !important; }
    html[data-nocturne-preload="on"] body > * { background-color: #121418 !important; }
  `;
  root.append(style);
})();
