/*
 * Oliver4 Developer Toolkit - extension service worker.
 *
 *   1. Injects toolkit/oliver4-toolkit.js into the page when the toolbar icon
 *      is clicked, and removes the panel on the next click.
 *   2. Disables the icon on tabs that are not a Dynamics host.
 *   3. Switches the icon to suit a light or dark browser theme.
 */

'use strict';

const TOOLKIT_FILE = 'toolkit/oliver4-toolkit.js';
const OFFSCREEN_PATH = 'offscreen.html';

// Element id of the toolkit panel. Must match PANEL_ID in the toolkit.
const PANEL_ID = 'oliver4-developer-toolkit-panel';

// Icon sets keyed by the toolbar background they are drawn for.
const ICONS = {
  light: {
    16: 'icons/mark-on-light-16.png',
    32: 'icons/mark-on-light-32.png',
    48: 'icons/mark-on-light-48.png',
    128: 'icons/mark-on-light-128.png'
  },
  dark: {
    16: 'icons/mark-on-dark-16.png',
    32: 'icons/mark-on-dark-32.png',
    48: 'icons/mark-on-dark-48.png',
    128: 'icons/mark-on-dark-128.png'
  }
};

/* ------------------------------------------------------------ where it runs --- */

// Host match patterns from manifest.json host_permissions, as regular expressions.
const HOST_PATTERNS = (chrome.runtime.getManifest().host_permissions || [])
  .map(toRegExp)
  .filter(Boolean);

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Converts a match pattern to a regular expression. Supports a scheme, an
// optional leading *. on the host, and * in the path. Returns null for any
// pattern it cannot parse.
function toRegExp(pattern) {
  const parts = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parts) return null;
  const scheme = parts[1] === '*' ? 'https?' : parts[1];
  const host = parts[2] === '*'
    ? '[^/]+'
    : parts[2].indexOf('*.') === 0
      ? '(?:[^/]+\\.)?' + escapeForRegExp(parts[2].slice(2))
      : escapeForRegExp(parts[2]);
  const path = parts[3].split('*').map(escapeForRegExp).join('.*');
  return new RegExp('^' + scheme + '://' + host + path, 'i');
}

// Returns true if the url matches one of the host patterns. The url is only
// available for tabs covered by a host permission, so a missing url returns false.
function isToolkitHost(url) {
  return typeof url === 'string' && HOST_PATTERNS.some((pattern) => pattern.test(url));
}

async function refreshTab(tabId, url) {
  try {
    if (isToolkitHost(url)) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId);
  } catch (error) {
    /* tab no longer exists */
  }
}

async function refreshEveryTab() {
  try {
    // Disable the icon by default, then enable it per matching tab.
    await chrome.action.disable();
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) await refreshTab(tab.id, tab.url);
  } catch (error) {
    console.warn('Oliver4 Developer Toolkit could not set the icon state:', error);
  }
}

/* ------------------------------------------------------------------- theme --- */

// Opens an offscreen document to read prefers-color-scheme. The document
// reports the result by message and is then closed.
let schemeProbe = null;

async function readColourScheme() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return;
  if (schemeProbe) return schemeProbe;
  schemeProbe = (async () => {
    try {
      if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['MATCH_MEDIA'],
        justification: 'Read prefers-color-scheme so the toolbar icon suits the browser theme.'
      });
    } catch (error) {
      // API unavailable or a document is already open - the icon is left unchanged.
    } finally {
      schemeProbe = null;
    }
  })();
  return schemeProbe;
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'oliver4-colour-scheme') return;
  chrome.action.setIcon({ path: message.dark ? ICONS.dark : ICONS.light })
    .catch(() => { /* icon left unchanged */ });
  if (chrome.offscreen && chrome.offscreen.closeDocument) {
    chrome.offscreen.closeDocument().catch(() => { /* already gone */ });
  }
});

/* ------------------------------------------------------------------- click --- */

// Runs in the page. Removes the toolkit panel if present and returns true,
// otherwise returns false. Toolkit state held on the window is not affected.
function removePanel(panelId) {
  var panel = document.getElementById(panelId);
  if (!panel || !panel.parentNode) return false;
  panel.parentNode.removeChild(panel);
  return true;
}

async function openOrClose(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  readColourScheme();

  // Top frame only. The toolkit finds forms in child frames itself.
  const target = { tabId: tab.id, frameIds: [0] };

  try {
    const closed = await chrome.scripting.executeScript({
      target: target,
      world: 'MAIN',
      func: removePanel,
      args: [PANEL_ID]
    });
    if (closed && closed[0] && closed[0].result === true) {
      clearWarning(tab.id);
      return;
    }

    // Injected into the MAIN world so the toolkit can access the page's Xrm object.
    await chrome.scripting.executeScript({
      target: target,
      world: 'MAIN',
      files: [TOOLKIT_FILE]
    });
    clearWarning(tab.id);
  } catch (error) {
    console.error('Oliver4 Developer Toolkit could not be injected:', error);
    showWarning(tab.id);
  }
}

function showWarning(tabId) {
  chrome.action.setBadgeText({ tabId: tabId, text: '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#a4262c' }).catch(() => {});
  chrome.action.setTitle({
    tabId: tabId,
    title: 'Oliver4 Developer Toolkit could not run on this page. Open the extension’s service worker console for the reason.'
  }).catch(() => {});
}

function clearWarning(tabId) {
  chrome.action.setBadgeText({ tabId: tabId, text: '' }).catch(() => {});
  chrome.action.setTitle({ tabId: tabId, title: 'Oliver4 Developer Toolkit' }).catch(() => {});
}

/* ------------------------------------------------------------------ events --- */

// Event listeners are registered at the top level so they are available when
// the service worker restarts.
chrome.action.onClicked.addListener((tab) => { openOrClose(tab); });

chrome.runtime.onInstalled.addListener(() => { refreshEveryTab(); readColourScheme(); });
chrome.runtime.onStartup.addListener(() => { refreshEveryTab(); readColourScheme(); });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Refresh on load as well as url change, as the url is not available after
  // navigating away from a Dynamics host.
  if (changeInfo.status === 'loading' || changeInfo.url) refreshTab(tabId, tab && tab.url);
});

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    refreshTab(info.tabId, tab && tab.url);
  } catch (error) {
    /* tab no longer exists */
  }
});
