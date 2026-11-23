// Display helpers. The server already converts and rounds; these only label.
export const UNIT = { km: 'km', mi: 'mi', l: 'L', gal_us: 'US gal', gal_imp: 'imp gal', l_per_100km: 'L/100 km', km_per_l: 'km/L', mpg_us: 'mpg (US)', mpg_imp: 'mpg (imp)' };
export const qty = (q) => (q ? `${q.value} ${UNIT[q.unit] ?? q.unit}` : '—');
export const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
/** A calendar date (YYYY-MM-DD) as the person's locale writes it; never shifted by a time zone. */
export const plainDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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
// Vehicle roles. The API value `editor` is shown as "Authorized Manager".
// These mirror apps/api/src/vehicles/permissions.ts; the server decides.
export const ROLE = { owner: 'Owner', editor: 'Authorized Manager', driver: 'Driver', viewer: 'Viewer' };
/** Roles the owner can grant, most capable first, for pickers. */
export const GRANTABLE_ROLES = [['editor', ROLE.editor], ['driver', ROLE.driver], ['viewer', ROLE.viewer]];
export const ROLE_HELP = {
  editor: 'Edits the vehicle details and photo, imports, and adds or corrects any fill-up.',
  driver: 'Adds fill-ups and corrects or deletes the ones they logged.',
  viewer: 'Can only read.',
};
/** Details, photo and import (ignores archiving; callers check it). */
export const canEditVehicle = (v) => v.role === 'owner' || v.role === 'editor';
/** Logging new fill-ups. */
export const canAddFuel = (v) => canEditVehicle(v) || v.role === 'driver';
/** Editing or deleting one fill-up: drivers only their own. */
export const canChangeFill = (v, f, userId) => canEditVehicle(v) || (v.role === 'driver' && !!f.createdBy && f.createdBy === userId);

// How a vehicle is named in the UI. A nickname, when set, leads and is followed by
// year, make and model. Without one the state/province and plate lead instead
// (e.g. "ON CXPZ101 · 2019 Honda Civic"). Friends' vehicles never carry plate
// data, so they fall back to year, make and model alone.
export const vehicleDescription = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ');
export const vehiclePlate = (v) => [v.plateRegion, v.plateNumber].filter(Boolean).join(' ');
export const vehicleTitle = (v) => v.name || vehiclePlate(v) || vehicleDescription(v) || 'Unnamed vehicle';
export const vehicleLabel = (v) => [v.name || vehiclePlate(v), vehicleDescription(v)].filter(Boolean).join(' \u00b7 ') || 'Unnamed vehicle';

// Service history (module). Mirrors canWriteService / canChangeVisit in permissions.ts.
/** Recording new service visits. */
export const canAddService = (v) => canEditVehicle(v) || v.role === 'driver';
/** Editing or deleting one visit: drivers only their own. */
export const canChangeVisit = (v, visit, userId) => canEditVehicle(v) || (v.role === 'driver' && !!visit.createdBy && visit.createdBy === userId);
