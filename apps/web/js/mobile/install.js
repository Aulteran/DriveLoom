// Install the app (#/more/install): platform-specific steps from pwa.js's
// installState(), with a manual switch in case detection is wrong. Android
// Chrome gets the browser's own prompt when it offers one; iOS has no prompt,
// so it gets Safari's steps. Install and the service worker need a trusted
// HTTPS origin, which the screen says plainly when it is missing. Each
// self-hosted instance installs separately.
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { installState, onInstallChange, promptInstall } from '../pwa.js';
import { page, copyField } from './kit.js';

const step = (n, title, ...body) => h('li', { class: 'm-step' },
  h('span', { class: 'm-step-n', 'aria-hidden': 'true' }, String(n)),
  h('div', { class: 'm-step-body' }, h('p', { class: 'm-step-title' }, h('span', { class: 'm-vh' }, `Step ${n}: `), title), ...body));
const key = (ic, label) => h('span', { class: 'm-key' }, icon(ic), label);
const small = (text) => h('p', { class: 'm-step-note' }, text);

function iosSteps() {
  return h('ol', { class: 'm-group m-steps', 'aria-label': 'Steps for iPhone and iPad' },
    step(1, 'Open this page in Safari', small('It must be Safari: other iPhone browsers may not offer Add to Home Screen. Works best on iOS 16.4 or later.')),
    step(2, 'Tap Share', h('p', { class: 'm-step-keys' }, key('share', 'Share')), small('In the toolbar at the bottom of the screen (at the top on iPad).')),
    step(3, 'Choose Add to Home Screen', h('p', { class: 'm-step-keys' }, key('install', 'Add to Home Screen')), small('Scroll down the list if you don’t see it.')),
    step(4, 'Tap Add', small('Then open DriveLoom from its new icon. You may need to sign in once.')));
}

function androidSteps(s, refresh) {
  const out = [];
  if (s.canPrompt) {
    out.push(h('button', { type: 'button', class: 'm-wide m-cta', onclick: async (e) => {
      e.currentTarget.disabled = true;
      const outcome = await promptInstall();
      if (outcome !== 'accepted') refresh();
    } }, icon('download'), 'Install app'));
    out.push(h('p', { class: 'm-note' }, 'Your browser shows its own install dialog. Or install from the browser’s menu:'));
  }
  out.push(h('ol', { class: 'm-group m-steps', 'aria-label': 'Steps for Android' },
    step(1, 'Open this page in Chrome', small('Edge, Samsung Internet and Firefox offer the same from their menus.')),
    step(2, 'Open the browser menu', h('p', { class: 'm-step-keys' }, key('dots', 'Menu')), small('The three dots next to the address bar.')),
    step(3, 'Choose Install app', small('Some versions call it Add to Home screen.')),
    step(4, 'Confirm with Install', small('DriveLoom then opens from its own icon, full screen.'))));
  return out;
}

export function installView() {
  const slot = h('div', { class: 'm-install-body' });
  let chosen = null;
  const draw = () => {
    const s = installState();
    const platform = chosen ?? (s.platform === 'ios' ? 'ios' : 'android');
    const blocks = [];
    if (s.standalone) {
      blocks.push(h('div', { class: 'm-callout m-callout-good', role: 'status' },
        icon('check'), h('div', {}, h('h2', {}, 'Installed'), h('p', {}, 'You’re using DriveLoom as an installed app. Updates arrive by themselves; you’ll be asked before the app reloads.'))));
    } else {
      if (!s.secure) {
        blocks.push(h('div', { class: 'm-callout m-callout-warn' },
          icon('alert'), h('div', {},
            h('h2', {}, 'Needs a secure connection'),
            h('p', {}, 'This server was opened over plain HTTP or without a trusted certificate. Phones only install web apps, and only keep them working offline, on trusted HTTPS.'),
            h('p', {}, 'Whoever runs this server can add HTTPS, for example with a reverse proxy that holds a certificate, or a secure tunnel. Until then DriveLoom works as an ordinary website, and a home-screen shortcut opens it in the browser.'))));
      }
      const seg = h('div', { class: 'm-seg', role: 'group', 'aria-label': 'Device' },
        [['ios', 'iPhone, iPad'], ['android', 'Android']].map(([k, label]) => h('button', {
          type: 'button', 'aria-pressed': String(platform === k), onclick: () => { chosen = k; draw(); slot.querySelector(`.m-seg [data-k="${k}"]`)?.focus(); }, dataset: { k },
        }, label)));
      blocks.push(seg);
      if (platform === 'ios') blocks.push(iosSteps());
      else blocks.push(...androidSteps(s.secure ? s : { ...s, canPrompt: false }, draw));
    }
    blocks.push(h('section', { class: 'm-sec', 'aria-labelledby': 'm-inst-h' },
      h('h2', { class: 'm-label', id: 'm-inst-h' }, 'This server'),
      h('div', { class: 'm-group m-pad' },
        copyField('Address', location.origin, { hint: 'Each DriveLoom server installs as its own app. To use another server, open its address and install it from there too.' }))));
    slot.replaceChildren(...blocks);
  };
  draw();
  // The prompt can become available (or the app installed) while the screen is open.
  const off = onInstallChange(() => { if (!slot.isConnected) { off(); return; } draw(); });
  return page({ title: 'Install DriveLoom', lede: 'Open DriveLoom full screen from your home screen, without the browser’s bars. Your data stays on your server.' }, slot);
}

/** One word for the Settings row: Installed, Needs HTTPS or Not installed. */
export function installStatus() {
  const s = installState();
  return s.standalone ? 'Installed' : !s.secure ? 'Needs HTTPS' : 'Not installed';
}
