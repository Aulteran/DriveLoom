// Extra stroke icons for the phone screens, drawn like icons.js (24 × 24,
// currentColor, aria-hidden). Kept here so the shared icon set stays as it is.
import { s } from '../ui.js';

const PATHS = {
  edit: 'M4 20h4L19 9l-4-4L4 16ZM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  archive: 'M4 5h16v4H4ZM5 9v10h14V9M10 13h4',
  image: 'M4 5h16v14H4ZM4 16l5-5 4 4 2-2 5 5M15 9.5h.01',
  share: 'M8 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM21 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM21 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM7.7 10.8l8.6-3.6M7.7 13.2l8.6 3.6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
};

export function glyph(name, cls = 'icon') {
  return s('svg', { class: cls, viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: PATHS[name] ?? '' }));
}
