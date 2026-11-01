// instantcoffee: Ovis's New workspace / New tab picker remembers its agent per
// browser (localStorage "ovis:new-session-agent"; "" is Shell, its default).
// Until a choice has been made in this browser, it is pi, so a new workspace or
// tab opens on a pi chat (operator, 2026-11-01). A choice made in the picker is
// kept as Ovis keeps it. Loaded from dist/index.html (scripts/ovis_patch.py);
// a separate file because Ovis's CSP is script-src 'self'.
try {
  if (window.localStorage.getItem("ovis:new-session-agent") === null) {
    window.localStorage.setItem("ovis:new-session-agent", "pi");
  }
} catch {
  // storage refused: the picker shows its own default
}
