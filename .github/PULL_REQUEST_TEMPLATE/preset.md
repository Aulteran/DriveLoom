## Preset

File: `apps/api/maintenance-presets/<market>/<make>/<model>/<year>.json`
New preset / change to existing (bump `version`): 

## Sources

List every source and say what you took from it. Only list documents you actually read.

## Checklist

- [ ] I am responsible for these values and verified each one against a source I read
- [ ] `manufacturer` trust is used only where the manufacturer's documentation for this exact model and year states the value
- [ ] Everything else is `community`, and its `sourceNote` says it is a community-suggested, editable value and not an official requirement
- [ ] No dashboard, Maintenance Minder or diagnostic code fields
- [ ] `npm run check` and `npm test` pass in `apps/api`
