# Maintenance presets

Advisory maintenance templates for specific vehicles. DriveLoom shows a matching preset as a suggestion; the owner chooses what to import and can edit every interval afterwards. Presets never write odometer or fuel data, and they carry no dashboard, Maintenance Minder or other diagnostic codes.

## Layout

`maintenance-presets/<market>/<make>/<model>/<year>.json`, all lowercase slugs, for example `us/honda/odyssey/2015.json`. The file's `market`, `make`, `model` and `year` must match its path, and `id` must be `<market>-<make>-<model>-<year>`. Structure: `preset.schema.json`. Files are at most 64 KB. Unknown keys are rejected everywhere.

At runtime the files sit at `maintenance-presets/` next to `src/` (in the Docker image, `/app/apps/api/maintenance-presets`).

## Authoring rules

- Rules are `months`, `distance` (decimal **string** plus `km`/`mi`), or both (whichever comes first). At least one is required.
- `catalogKey` is optional and must be a key of `CATALOG` in `apps/api/src/service/maintenance-status.ts`.
- Task ids are unique slugs within the file. Do not rename a published task id; it identifies the task on re-import. Bump `version` when you change a file.
- Keep descriptions short and factual. No advice that depends on guesses about the specific car.

## Sourcing responsibility

You are responsible for every value you submit. Only cite a source you have actually read, and only quote pages or figures you saw. Do not invent citations. If you cannot verify a value, label it `community`.

## Trust labels

- `manufacturer`: the value is stated in the manufacturer's own documentation for that exact model and year. Put the document in `sources` (kind `manufacturer`) and say where in `sourceNote`.
- `community`: anything else. The `sourceNote` must say plainly that it is a community-suggested, editable value and not an official requirement.

Never present a community value as an official requirement.

## Validate

From `apps/api`: `npm run check` (runs `scripts/check-presets.ts`) and `npm test`.

## Opening a preset PR

Open preset pull requests with the preset template: https://github.com/Aulteran/DriveLoom/compare?template=preset.md (use `?template=preset.md` when opening a preset PR).
