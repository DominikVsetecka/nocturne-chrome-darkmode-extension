const DEFAULTS = {
  enabled: true,
  enabledDomains: [],
  disabledDomains: [],
  settings: { brightness: 100, contrast: 100, saturation: 100, blueLight: 0 }
};

async function config() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

function domainFromUrl(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function canInject(url) {
  return /^https?:\/\//.test(url || "");
}

function setNocturne({ enabled, settings, targets = null }) {
  const id = "nocturne-dev-style";
  const preloadId = "nocturne-dev-preload";
  const appliedSelector = "[data-nocturne-bg], [data-nocturne-gradient], [data-nocturne-fg], [data-nocturne-media-text], [data-nocturne-vector], [data-nocturne-before], [data-nocturne-after]";
  const collectRoots = () => {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      roots[index].querySelectorAll("*").forEach((element) => {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      });
    }
    return roots;
  };
  const collectElements = () => collectRoots().flatMap((root) => [...root.querySelectorAll("*")]);
  const clearApplied = (elements, full = false) => {
    if (full) document.documentElement.removeAttribute("data-nocturne-dev");
    elements.filter((element) => element.matches(appliedSelector)).forEach((element) => {
      element.removeAttribute("data-nocturne-bg");
      element.removeAttribute("data-nocturne-gradient");
      element.removeAttribute("data-nocturne-fg");
      element.removeAttribute("data-nocturne-media-text");
      element.removeAttribute("data-nocturne-vector");
      element.removeAttribute("data-nocturne-before");
      element.removeAttribute("data-nocturne-after");
      element.style.removeProperty("--nocturne-background");
      element.style.removeProperty("--nocturne-foreground");
      element.style.removeProperty("--nocturne-vector");
      element.style.removeProperty("--nocturne-before-background");
      element.style.removeProperty("--nocturne-after-background");
    });
  };

  if (!enabled) {
    window.__nocturneDevObserver?.disconnect();
    clearTimeout(window.__nocturneDevTimer);
    clearTimeout(window.__nocturneDevBatchTimer);
    window.__nocturneDevPending?.clear();
    collectRoots().forEach((root) => root.querySelector(`#${id}`)?.remove());
    document.getElementById(preloadId)?.remove();
    document.documentElement.removeAttribute("data-nocturne-preload");
    clearApplied(collectElements(), true);
    delete window.__nocturneDevObserver;
    delete window.__nocturneDevOriginal;
    return;
  }

  // Restore source colours before each pass. This makes a later pass over
  // dynamically added UI idempotent instead of darkening already-darkened UI.
  const incremental = Array.isArray(targets);
  if (!incremental) {
    clearTimeout(window.__nocturneDevTimer);
    clearTimeout(window.__nocturneDevBatchTimer);
    window.__nocturneDevPending?.clear();
  }
  const roots = incremental ? [...new Set(targets.map((element) => element.getRootNode()).filter((root) => root === document || root instanceof ShadowRoot))] : collectRoots();
  const elements = incremental ? targets.filter((element) => element.isConnected) : roots.flatMap((root) => [...root.querySelectorAll("*")]);
  clearApplied(elements, !incremental);
  // Keep the document-start canvas in place while the site is still parsing.
  // Otherwise a framework can briefly paint its own white app root between
  // this early pass and the first full semantic pass.
  if (!incremental && document.readyState !== "loading") {
    document.getElementById(preloadId)?.remove();
    document.documentElement.removeAttribute("data-nocturne-preload");
  }

  const brightness = Math.max(50, Math.min(150, Number(settings.brightness) || 100));
  const contrast = Math.max(50, Math.min(150, Number(settings.contrast) || 100));
  const saturation = Math.max(0, Math.min(200, Number(settings.saturation) || 100));
  const warmth = Math.max(0, Math.min(100, Number(settings.blueLight) || 0));
  const mediaTags = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "SVG"]);
  const original = window.__nocturneDevOriginal || (window.__nocturneDevOriginal = new WeakMap());
  // getComputedStyle returns a live object: snapshot its properties before
  // applying our own overrides so descendants can reuse original colours.
  const pseudos = new Map();
  const vectorPaint = new Map();
  for (const element of elements) {
    const style = getComputedStyle(element);
    original.set(element, { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, color: style.color, position: style.position });
    if (!mediaTags.has(element.tagName)) {
      pseudos.set(element, ["::before", "::after"].map((pseudo) => {
        const computed = getComputedStyle(element, pseudo);
        return { content: computed.content, backgroundColor: computed.backgroundColor, backgroundImage: computed.backgroundImage };
      }));
    }
    if (element.matches("svg path, svg text, svg use, svg polygon, svg rect, svg circle")) {
      vectorPaint.set(element, { fill: style.fill, stroke: style.stroke });
    }
  }

  const parseColor = (value) => {
    if (!value) return null;
    const parsePart = (part, scale = 255) => part.endsWith("%")
      ? (Number.parseFloat(part) / 100) * scale
      : Number.parseFloat(part);
    const rgb = value.match(/^rgba?\((.*)\)$/i);
    if (rgb) {
      const parts = rgb[1].replace(/\//g, " ").trim().split(/[\s,]+/);
      const [r, g, b] = parts.slice(0, 3).map((part) => parsePart(part));
      const alpha = parts[3] === undefined ? 1 : parsePart(parts[3], 1);
      if ([r, g, b, alpha].some(Number.isNaN)) return null;
      return { r, g, b, a: alpha };
    }
    const srgb = value.match(/^color\(srgb\s+(.+)\)$/i);
    if (srgb) {
      const parts = srgb[1].replace(/\//g, " ").trim().split(/\s+/);
      const [r, g, b] = parts.slice(0, 3).map((part) => part.endsWith("%")
        ? parsePart(part, 255)
        : Number.parseFloat(part) * 255);
      const alpha = parts[3] === undefined ? 1 : parsePart(parts[3], 1);
      if ([r, g, b, alpha].some(Number.isNaN)) return null;
      return { r, g, b, a: alpha };
    }
    const hsl = value.match(/^hsla?\((.*)\)$/i);
    if (hsl) {
      const parts = hsl[1].replace(/,/g, " ").replace(/\//g, " ").trim().split(/\s+/);
      const hue = ((Number.parseFloat(parts[0]) % 360) + 360) % 360;
      const saturation = parsePart(parts[1], 1);
      const lightness = parsePart(parts[2], 1);
      const alpha = parts[3] === undefined ? 1 : parsePart(parts[3], 1);
      if ([hue, saturation, lightness, alpha].some(Number.isNaN)) return null;
      const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
      const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
      const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
      const m = lightness - chroma / 2;
      return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: alpha };
    }
    const oklch = value.match(/^oklch\((.*)\)$/i);
    const oklab = value.match(/^oklab\((.*)\)$/i);
    if (oklch || oklab) {
      const parts = (oklch?.[1] || oklab[1]).replace(/\//g, " ").trim().split(/\s+/);
      const l = parts[0].endsWith("%") ? Number.parseFloat(parts[0]) / 100 : Number.parseFloat(parts[0]);
      let a = Number.parseFloat(parts[1]);
      let b = Number.parseFloat(parts[2]);
      const alpha = parts[3] === undefined ? 1 : parsePart(parts[3], 1);
      if (oklch) {
        const chroma = a;
        const hue = b * Math.PI / 180;
        a = chroma * Math.cos(hue);
        b = chroma * Math.sin(hue);
      }
      if ([l, a, b, alpha].some(Number.isNaN)) return null;
      const lms = [
        (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
        (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
        (l - 0.0894841775 * a - 1.291485548 * b) ** 3
      ];
      const linear = [
        4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
        -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
        -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]
      ];
      const toSrgb = (channel) => 255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055);
      return { r: toSrgb(linear[0]), g: toSrgb(linear[1]), b: toSrgb(linear[2]), a: alpha };
    }
    return null;
  };
  const luminance = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
  const asCss = ({ r, g, b }) => `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
  const darken = (color) => {
    const lightness = luminance(color);
    // Preserve a page's intentionally dark surfaces. Only light surfaces move
    // into the dark palette, which avoids turning text on dark cards black.
    if (lightness < 0.2) return color;
    const paletteLevel = (0.075 + Math.min(lightness, 1) * 0.105) * (brightness / 100);
    const scale = paletteLevel / Math.max(lightness, 0.01);
    const warmthBias = warmth / 100;
    const chroma = saturation / 100;
    const average = (color.r + color.g + color.b) / 3;
    return {
      r: clamp((color.r * chroma + average * (1 - chroma)) * scale * (1 + warmthBias * 0.08)),
      g: clamp((color.g * chroma + average * (1 - chroma)) * scale),
      b: clamp((color.b * chroma + average * (1 - chroma)) * scale * (1 - warmthBias * 0.14))
    };
  };
  const effectiveBackground = (element) => {
    let current = element;
    while (current) {
      const computed = original.get(current);
      if (!computed) break;
      if (computed.backgroundImage !== "none") return { color: { r: 16, g: 18, b: 22 }, media: true };
      const color = parseColor(computed.backgroundColor);
      if (color && color.a > 0.04) return { color: darken(color), media: false };
      // A component's real visual backdrop can live on its shadow host. Walk
      // across that boundary as well, so text in an open Web Component gets
      // the same contrast decision as text in the document tree.
      current = current.parentElement || current.getRootNode()?.host || null;
    }
    return { color: { r: 18, g: 20, b: 24 }, media: false };
  };

  document.documentElement.setAttribute("data-nocturne-dev", "on");
  const componentRules = `
    [data-nocturne-bg] {
      background-color: var(--nocturne-background) !important;
    }
    [data-nocturne-gradient] {
      background-image: none !important;
    }
    [data-nocturne-fg] { color: var(--nocturne-foreground) !important; }
    [data-nocturne-media-text] {
      color: #f8f9fc !important;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .92), 0 0 10px rgba(0, 0, 0, .65) !important;
    }
    [data-nocturne-vector] {
      fill: var(--nocturne-vector) !important;
      stroke: var(--nocturne-vector) !important;
    }
    [data-nocturne-before]::before {
      background-color: var(--nocturne-before-background) !important;
      background-image: none !important;
    }
    [data-nocturne-after]::after {
      background-color: var(--nocturne-after-background) !important;
      background-image: none !important;
    }
  `;
  const documentRules = `
    html[data-nocturne-dev="on"] {
      background: #121418 !important;
      color-scheme: dark;
    }
    html[data-nocturne-dev="on"] body { background: #121418 !important; }
    ${componentRules}
  `;
  roots.forEach((root) => {
    let style = root.querySelector(`#${id}`);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      root === document ? (document.head || document.documentElement).append(style) : root.append(style);
    }
    const rules = root === document ? documentRules : componentRules;
    if (style.textContent !== rules) style.textContent = rules;
  });

  for (const element of elements) {
    const computed = original.get(element);
    if (!computed || mediaTags.has(element.tagName)) continue;
    const color = parseColor(computed.backgroundColor);
    const hasBitmapBackground = /url\(/i.test(computed.backgroundImage);
    const hasCssPaint = (color && color.a > 0.04) || computed.backgroundImage !== "none";
    // Positioned translucent gradients often sit directly over a player or
    // thumbnail. Replacing them with an opaque surface hides the media.
    const isMediaOverlay = (computed.position === "absolute" || computed.position === "fixed") &&
      computed.backgroundImage !== "none" && (!color || color.a <= 0.04) &&
      element.parentElement?.querySelector("img, video, canvas, picture");
    if (hasCssPaint && !hasBitmapBackground && !isMediaOverlay) {
      element.setAttribute("data-nocturne-bg", "");
      element.style.setProperty("--nocturne-background", asCss(darken(color && color.a > 0.04 ? color : { r: 225, g: 225, b: 225 })));
      if (computed.backgroundImage !== "none") element.setAttribute("data-nocturne-gradient", "");
    }
  }

  for (const element of elements) {
    const computed = original.get(element);
    if (!computed || mediaTags.has(element.tagName)) continue;
    const textColor = parseColor(computed.color);
    if (!textColor || textColor.a === 0) continue;
    const backdrop = effectiveBackground(element);
    const isMediaCaption = backdrop.media || computed.position === "absolute" || computed.position === "fixed";
    const desired = isMediaCaption || luminance(backdrop.color) < 0.55
      ? { r: 242, g: 244, b: 248 }
      : { r: 21, g: 23, b: 28 };
    element.setAttribute("data-nocturne-fg", "");
    element.style.setProperty("--nocturne-foreground", asCss(desired));
    if (isMediaCaption) element.setAttribute("data-nocturne-media-text", "");
  }

  // Frameworks commonly paint page frames and navigation strips through
  // pseudo-elements. They are invisible to a normal DOM colour walk, so treat
  // their paint as another surface while never touching bitmap backgrounds.
  for (const element of elements) {
    if (mediaTags.has(element.tagName)) continue;
    for (const [index, pseudo] of ["::before", "::after"].entries()) {
      const computed = pseudos.get(element)[index];
      if (computed.content === "none") continue;
      const color = parseColor(computed.backgroundColor);
      const hasBitmapBackground = /url\(/i.test(computed.backgroundImage);
      const hasPaint = (color && color.a > 0.04) || computed.backgroundImage !== "none";
      // Pseudo-elements frequently provide transparent caption gradients over
      // photos and videos; turning those into solid fills masks the media.
      const isMediaOverlay = computed.backgroundImage !== "none" &&
        (!color || color.a <= 0.04) && element.querySelector("img, video, canvas, picture");
      if (!hasPaint || hasBitmapBackground || isMediaOverlay) continue;
      const transformed = darken(color && color.a > 0.04 ? color : { r: 225, g: 225, b: 225 });
      const attribute = pseudo === "::before" ? "data-nocturne-before" : "data-nocturne-after";
      const property = pseudo === "::before" ? "--nocturne-before-background" : "--nocturne-after-background";
      element.setAttribute(attribute, "");
      element.style.setProperty(property, asCss(transformed));
    }
  }

  // SVGs often contain text-like black paths. Treat only their near-black
  // vector paint as foreground; coloured logo marks and all bitmap media stay
  // untouched.
  vectorPaint.forEach((paintValues, element) => {
    const fill = parseColor(paintValues.fill);
    const stroke = parseColor(paintValues.stroke);
    const paint = fill?.a > 0 ? fill : stroke;
    if (paint && luminance(paint) < 0.16) {
      element.setAttribute("data-nocturne-vector", "");
      element.style.setProperty("--nocturne-vector", "rgb(242, 244, 248)");
    }
  });

  // Process only changed subtrees, in bounded batches. Stylesheet changes are
  // exceptional: they can affect any selector, so they require a full pass.
  window.__nocturneDevSettings = settings;
  if (!window.__nocturneDevObserver) {
    const pending = window.__nocturneDevPending = new Set();
    const enqueueTree = (node) => {
      if (!(node instanceof Element) || !node.isConnected || node.id === id || node.id === preloadId) return;
      const stack = [node];
      while (stack.length) {
        const current = stack.pop();
        if (pending.has(current)) continue;
        pending.add(current);
        for (const child of current.children) stack.push(child);
        if (current.shadowRoot) {
          for (const child of current.shadowRoot.children) stack.push(child);
        }
      }
    };
    const runBatch = () => {
      window.__nocturneDevBatchTimer = null;
      if (!document.documentElement.hasAttribute("data-nocturne-dev")) return;
      const batch = [];
      for (const element of pending) {
        pending.delete(element);
        if (element.isConnected) batch.push(element);
        if (batch.length >= 150) break;
      }
      if (batch.length) setNocturne({ enabled: true, settings: window.__nocturneDevSettings, targets: batch });
      if (pending.size) window.__nocturneDevBatchTimer = setTimeout(runBatch, 0);
    };
    window.__nocturneDevObserver = new MutationObserver((records) => {
      let stylesheetChanged = false;
      for (const record of records) {
        if (record.type === "attributes") enqueueTree(record.target);
        else {
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (node.nodeType !== Node.ELEMENT_NODE || node.id === id || node.id === preloadId) continue;
            if (node.matches('style, link[rel~="stylesheet"]') || node.querySelector('style:not(#nocturne-dev-style):not(#nocturne-dev-preload), link[rel~="stylesheet"]')) stylesheetChanged = true;
            if (node.isConnected) enqueueTree(node);
          }
        }
      }
      if (stylesheetChanged) {
        clearTimeout(window.__nocturneDevTimer);
        window.__nocturneDevTimer = setTimeout(() => {
          if (document.documentElement.hasAttribute("data-nocturne-dev")) setNocturne({ enabled: true, settings: window.__nocturneDevSettings });
        }, 250);
      }
      if (pending.size && !window.__nocturneDevBatchTimer) window.__nocturneDevBatchTimer = setTimeout(runBatch, 60);
    });
  }
  roots.forEach((root) => window.__nocturneDevObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "open", "aria-hidden"]
  }));
}

async function applyToTab(tabId, url) {
  if (!canInject(url)) return;
  const { enabled, enabledDomains, disabledDomains, settings } = await config();
  const hostname = domainFromUrl(url);
  const active = Boolean(hostname && (enabledDomains.includes(hostname) || (enabled && !disabledDomains.includes(hostname))));
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: setNocturne,
      args: [{ enabled: active, settings }]
    });
  } catch {
    // Some pages intentionally reject script injection.
  }
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // The document-start script removes the white page canvas. An early pass
  // establishes the document colour scheme; the complete pass sees all CSS.
  if (change.status === "loading" || change.status === "complete") applyToTab(tabId, tab.url);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "apply-all-tabs") {
    chrome.tabs.query({}).then((tabs) => Promise.all(tabs.filter((tab) => tab.id && canInject(tab.url)).map((tab) => applyToTab(tab.id, tab.url))))
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type !== "apply-current-tab" || !message.tabId || !message.url) return;
  applyToTab(message.tabId, message.url).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});
