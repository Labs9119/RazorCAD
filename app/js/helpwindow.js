// The manual in a window of its own (help.html, opened by the help panel's ⧉): the same view as the panel; ⇤ puts it
// back in RazorCAD's window. RazorCAD shows other sections here with window.showHelp({ id, q }).
import { HelpView } from './help.js';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';

const view = new HelpView(document.getElementById('help-root'), {
  tools: [{ label: '⇤', title: 'Dock in the RazorCAD window', onclick: () => dock(), attrs: { 'data-help-dock': '' } }],
  onShow: (id) => {
    const u = new URL(location.href);
    u.hash = id || '';
    if (view?.query) u.searchParams.set('q', view.query); else u.searchParams.delete('q');
    history.replaceState(null, '', u.href);
  },
});

function dock() {
  const place = view.place;
  if (window.pywebview?.api?.dock) { window.pywebview.api.dock(place.id || '', place.q || ''); return; }
  if (window.opener && !window.opener.closed) window.opener.postMessage({ razorcadHelp: 'dock', place }, location.origin);
  window.close();
}

window.showHelp = (place) => { window.focus(); return view.go(place?.id || null, { q: place?.q ?? null }); };
const q = new URLSearchParams(location.search).get('q');
view.go(decodeURIComponent(location.hash.slice(1)) || null, { q }).then(() => { if (!location.hash.slice(1)) view.focus(); });
