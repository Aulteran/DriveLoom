// Display helpers. The server already converts and rounds; these only label.
export const UNIT = { km: 'km', mi: 'mi', l: 'L', gal_us: 'US gal', gal_imp: 'imp gal', l_per_100km: 'L/100 km', km_per_l: 'km/L', mpg_us: 'mpg (US)', mpg_imp: 'mpg (imp)' };
export const qty = (q) => (q ? `${q.value} ${UNIT[q.unit] ?? q.unit}` : '—');
export const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export const dateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function money(amount, currency) {
  if (amount === null || amount === undefined) return '—';
  // Formatting a decimal string through Number is display-only and exact for any realistic amount.
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 4 }).format(Number(amount)); } catch { return `${amount} ${currency}`; }
}
export const REASONS = {
  partial_fill: 'Partial fill', no_previous_full_fill: 'First full fill', missed_fill: 'Missed purchase', no_distance: 'No distance',
};
/** Local date-time for an <input type="datetime-local"> */
export function localInput(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** datetime-local value -> RFC 3339 with the browser's offset */
export function toInstant(local) { return new Date(local).toISOString(); }
export const ROLE = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
