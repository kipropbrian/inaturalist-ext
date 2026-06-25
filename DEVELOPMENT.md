# Development

## Reference iNaturalist application

The iNaturalist web application has been cloned locally at:

```text
/Users/brian/Developer/MRI/projects/inaturalist
```

Use this repository as the source of truth for React components, Rails views,
CSS, modal structure, tab behavior, identification forms, and API usage. It is
especially useful when an extension feature needs to match native iNaturalist
behavior or when live DOM inspection does not explain React-managed state.

Keep extension changes in `inaturalist-ext` unless changes to the iNaturalist
application are explicitly requested.

## Identification Explorer

The `feature/identification-explorer` branch adds a lightweight inline search toolbar to:

```text
https://www.inaturalist.org/identifications/<username>
```

It does not load all identifications upfront. Instead it injects a compact search bar **above the native identification list** and queries the iNaturalist API only when the user submits a search.

### Features

- Search by taxon name (scientific or common)
- Filter by identification category (leading, improving, supporting, maverick)
- Toggle current-IDs-only
- Sort by newest/oldest
- Up to 10 results shown as a compact inline list linking to observations and taxa
- Compact paging controls for navigating beyond the first page of API results
- Disable from extension options

### Notes

- The toolbar queries the iNaturalist API on demand instead of preloading the
  full identification history.
- The compact layout is intended to keep the list readable without horizontal
  scrolling.

### Load the development build in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select:

```text
/Users/brian/Developer/MRI/projects/inaturalist-ext/iNaturalist Enhancement Suite
```

5. Open or reload an iNaturalist identification page.

Chrome treats this as a separate unpacked extension from the Web Store copy. Disable the Web Store copy temporarily while testing if both versions attempt to modify the same page.

### Validation

```bash
node --check "iNaturalist Enhancement Suite/content-identifications.js"
node --check "iNaturalist Enhancement Suite/options.js"
jq empty "iNaturalist Enhancement Suite/manifest.json"
git diff --check
```

## CV suggestions and hierarchy

- `content-score-crop.js` renders computer-vision suggestions with selectable
  hierarchy links, so choosing any ancestor can populate the ID form.
- CV and taxonomy lookups are cached locally for about a week when the data is
  stable enough to reuse.
- `content-observation.js` adds hierarchy display on observation pages and
  controls the identify-page infinite paging behavior, including the loading
  overlay and cooldown period.

## Similar species

- The Similar Species feature is rendered inside the Identify modal Info panel
  instead of a separate tab.
- The similar-species section now lives below the identification activity so it
  does not squeeze the native map and observation details.
