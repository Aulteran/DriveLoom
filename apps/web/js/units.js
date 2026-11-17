// Display-unit choices shared by setup, registration, settings and admin.
import { h, field, select } from './ui.js';
import { currencyOptions } from './views/vehicles.js';

export const UNIT_KEYS = ['distanceUnit', 'volumeUnit', 'economyUnit', 'currency'];
const LABELS = { distanceUnit: 'Distance', volumeUnit: 'Fuel volume', economyUnit: 'Fuel economy', currency: 'Currency' };
const CHOICES = {
  distanceUnit: [['km', 'Kilometres'], ['mi', 'Miles']],
  volumeUnit: [['l', 'Litres'], ['gal_us', 'US gallons'], ['gal_imp', 'Imperial gallons']],
  economyUnit: [['l_per_100km', 'L/100 km'], ['km_per_l', 'km/L'], ['mpg_us', 'mpg (US)'], ['mpg_imp', 'mpg (imperial)']],
};
const options = (key, current) => (key === 'currency' ? currencyOptions(current) : CHOICES[key]);
export const unitLabel = (key, value) => (key === 'currency' ? value : CHOICES[key].find(([v]) => v === value)?.[1] ?? value);

/**
 * Four unit selects. With `defaults`, each select starts with an
 * "Instance default" option (value "") that follows the administrator's choice;
 * `inherited` lists the fields that currently follow it.
 */
export function unitFields(values, { defaults = null, inherited = [], hints = {} } = {}) {
  return h('div', { class: 'grid' }, UNIT_KEYS.map((k) => {
    const opts = options(k, values[k]);
    const all = defaults ? [['', `Instance default (${unitLabel(k, defaults[k])})`], ...opts] : opts;
    return field(LABELS[k], select(k, all, defaults && inherited.includes(k) ? '' : values[k]), hints[k]);
  }));
}

/** Read the unit selects inside `root` into an object. */
export const readUnits = (root) => Object.fromEntries(UNIT_KEYS.map((k) => [k, root.querySelector(`select[name="${k}"]`).value]));
