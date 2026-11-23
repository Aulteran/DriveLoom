// A small, honest table of common US makes and a few models, used only to
// recognise different spellings of the same name when matching free-text
// vehicles against bundled data, and to offer optional suggestions in the
// vehicle form. Aliases are spellings of the SAME name ("chevy", "vw"); a trim
// or variant word ("EX-L", "Touring") is never an alias and is never dropped.
// Nothing here is stored or applied to a vehicle: it is comparison data only.
// Entries are compared after normalizeIdentity, so case, spaces and
// punctuation in aliases do not matter.

export interface MakeEntry { id: string; name: string; aliases?: string[] }
export interface ModelEntry { id: string; make: string; name: string; aliases?: string[] }

export const MAKES: readonly MakeEntry[] = [
  { id: 'acura', name: 'Acura' },
  { id: 'audi', name: 'Audi' },
  { id: 'bmw', name: 'BMW' },
  { id: 'buick', name: 'Buick' },
  { id: 'cadillac', name: 'Cadillac', aliases: ['caddy'] },
  { id: 'chevrolet', name: 'Chevrolet', aliases: ['chevy'] },
  { id: 'chrysler', name: 'Chrysler' },
  { id: 'dodge', name: 'Dodge' },
  { id: 'fiat', name: 'Fiat' },
  { id: 'ford', name: 'Ford' },
  { id: 'genesis', name: 'Genesis' },
  { id: 'gmc', name: 'GMC' },
  { id: 'honda', name: 'Honda' },
  { id: 'hyundai', name: 'Hyundai' },
  { id: 'infiniti', name: 'Infiniti' },
  { id: 'jaguar', name: 'Jaguar' },
  { id: 'jeep', name: 'Jeep' },
  { id: 'kia', name: 'Kia' },
  { id: 'land-rover', name: 'Land Rover', aliases: ['landrover'] },
  { id: 'lexus', name: 'Lexus' },
  { id: 'lincoln', name: 'Lincoln' },
  { id: 'mazda', name: 'Mazda' },
  { id: 'mercedes-benz', name: 'Mercedes-Benz', aliases: ['mercedes', 'mercedes benz', 'merc'] },
  { id: 'mini', name: 'MINI', aliases: ['mini cooper'] },
  { id: 'mitsubishi', name: 'Mitsubishi' },
  { id: 'nissan', name: 'Nissan' },
  { id: 'porsche', name: 'Porsche' },
  { id: 'ram', name: 'Ram', aliases: ['dodge ram'] },
  { id: 'subaru', name: 'Subaru' },
  { id: 'tesla', name: 'Tesla' },
  { id: 'toyota', name: 'Toyota' },
  { id: 'volkswagen', name: 'Volkswagen', aliases: ['vw', 'volks wagen'] },
  { id: 'volvo', name: 'Volvo' },
];

export const MODELS: readonly ModelEntry[] = [
  { id: 'odyssey', make: 'honda', name: 'Odyssey' },
  { id: 'accord', make: 'honda', name: 'Accord' },
  { id: 'civic', make: 'honda', name: 'Civic' },
  { id: 'cr-v', make: 'honda', name: 'CR-V', aliases: ['crv'] },
  { id: 'pilot', make: 'honda', name: 'Pilot' },
  { id: 'camry', make: 'toyota', name: 'Camry' },
  { id: 'corolla', make: 'toyota', name: 'Corolla' },
  { id: 'prius', make: 'toyota', name: 'Prius' },
  { id: 'rav4', make: 'toyota', name: 'RAV4', aliases: ['rav-4'] },
  { id: 'f-150', make: 'ford', name: 'F-150', aliases: ['f150'] },
  { id: 'mustang', make: 'ford', name: 'Mustang' },
  { id: 'silverado', make: 'chevrolet', name: 'Silverado' },
  { id: 'golf', make: 'volkswagen', name: 'Golf' },
];
