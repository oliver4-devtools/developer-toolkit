/*
 * Offscreen document that reads the browser colour scheme and sends it to the
 * service worker, which sets the toolbar icon and closes this document.
 */

'use strict';

const dark = matchMedia('(prefers-color-scheme: dark)').matches;
chrome.runtime.sendMessage({ type: 'oliver4-colour-scheme', dark: dark })
  .catch(() => { /* no listener - the icon is left unchanged */ });
