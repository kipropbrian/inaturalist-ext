# Development

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
- Results shown as a slim inline list linking directly to each observation
- Results cached for **24 hours** per unique query
- Disable from extension options

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
