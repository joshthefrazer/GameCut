/**
 * "What's new": a card shown once after an update that adds tools or changes
 * keys. Moving Import from I to Ctrl+I, and Loop from L to Shift+L, would be a
 * nasty surprise if nothing said so, so this says so the first time the editor
 * opens, and never again (it can be opened from Ctrl+K).
 */
import { bus } from '../core/events.js';

const SEEN_KEY = 'strike.whatsNew';
const EDITION = '3.0-A';

const NEW_TOOLS = [
  ['Colour', 'Brightness, contrast, saturation, warmth, tint and film fade on any clip, plus starting points you pick (Vivid, Warm, Mono…). Picture tab → Colour.'],
  ['Blend', 'How a layer mixes with what is under it: Screen for light leaks, Multiply for shadows, Overlay for textures… Next to Opacity.'],
  ['In and Out', 'I and O mark a part of the edit. Loop it, export just that part, or take it out with Lift / Extract (Ctrl+K).'],
  ['J K L', 'Play backwards, stop, play forwards; press J or L again to go faster. , and . step one frame.'],
  ['Trim and slip', 'Alt+[ and Alt+] cut the start or end of the clip under the playhead right to it. Alt+, and Alt+. slip: show an earlier or later part of the recording inside the clip.'],
  ['Go to a time', 'Ctrl+G, or click the time under the preview, and type 1:23, 83 or 2m5s.'],
  ['Caption editor', 'Shift+C: every caption in one list. Fix a word, click a word to colour it, make it huge, give it an emoji or a shake, split and join lines.'],
  ['Caption animations', 'Karaoke (colour sweeps through each word), Bounce in, Rise up, Word by word, Punch: pick one for all your captions.'],
  ['Subtitle files', 'Save captions as .srt / .vtt, or bring in an .srt you already have (in the Auto-captions box).'],
  ['Click to outline anything', 'Crop → Smart: click a thing and Strike traces its exact edge (a small optional download, once).'],
];
const MOVED = [
  ['Import', 'I', 'Ctrl+I'],
  ['Loop', 'L', 'Shift+L'],
];

export function initWhatsNew({ library } = {}) {
  let el = null;
  // Asked at once, at start-up: did this computer already have projects before
  // this launch? (A new install, or a test's fresh profile, has none.)
  const hadProjects = Promise.resolve().then(() => library?.list?.()).then(l => Array.isArray(l) && l.length > 0).catch(() => false);
  function open() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'mini whatsnew';
      el.id = 'whatsNew';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'What is new in Strike');
      el.innerHTML = `<div class="mini__box whatsnew__box">
        <b>New in Strike: editing tools</b>
        <ul class="whatsnew__list">${NEW_TOOLS.map(([t, d]) => `<li><b>${t}</b><span>${d}</span></li>`).join('')}</ul>
        <div class="whatsnew__moved"><b>Two keys moved</b>${MOVED.map(([what, from, to]) => `<span>${what}: <s>${from}</s> → <kbd>${to}</kbd></span>`).join('')}</div>
        <div class="mini__row">
          <button class="btn btn--ghost" id="whatsNewKeys">All shortcuts (?)</button>
          <button class="btn btn--primary" id="whatsNewOk">Got it</button>
        </div>
      </div>`;
      document.body.appendChild(el);
      const done = () => { el.hidden = true; try { localStorage.setItem(SEEN_KEY, EDITION); } catch { /* storage off */ } };
      el.querySelector('#whatsNewOk').addEventListener('click', done);
      el.querySelector('#whatsNewKeys').addEventListener('click', () => { done(); window.gc?.help?.toggle?.(); });
      el.addEventListener('pointerdown', (e) => { if (e.target === el) done(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(); } });
    }
    el.hidden = false;
    el.querySelector('#whatsNewOk').focus();
  }

  /** Once, the first time the editor (not the projects screen) is in front after this update. */
  async function maybeShow() {
    let seen = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch { return; }
    if (seen === EDITION) return;
    // A brand-new install gets the tour instead; this card is for people who knew the old keys.
    if (!(await hadProjects)) { try { localStorage.setItem(SEEN_KEY, EDITION); } catch { /* */ } return; }
    const tryNow = () => {
      if (document.getElementById('app')?.classList.contains('is-home')) return false;
      if ([...document.querySelectorAll('[aria-modal="true"]')].some(d => d !== el && d.getClientRects().length)) return false;
      open();
      return true;
    };
    if (tryNow()) return;
    const iv = setInterval(() => { if (tryNow()) clearInterval(iv); }, 1500);
  }
  setTimeout(maybeShow, 2500);

  bus.emit('palette:add', [{ id: 'whatsnew', name: "What's new in this version", sec: 'Help', run: open }]);
  return { open };
}
