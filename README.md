# Collect & Conquer — Reality Fracture

Interactive Magic: The Gathering ranking boards for the Collect & Conquer YouTube channel.

## Run locally

```bash
npm install
npm run sync:cards
npm run dev
```

The sync script retrieves the `fra` Reality Fracture set and `frc` Reality Fracture Commander set from Scryfall, keeps one canonical mechanically unique printing, and caches the card images under `public/cards/reality-fracture/`. The app has no runtime dependency on Scryfall.

Scryfall represents double-faced cards such as `Bloodline Recollector // Ancestral Craving` and `Carnivorous Cultivator // Enroot` with their full face names; the starter rankings resolve the requested front-face names to those canonical cards. The five Reality Fracture Elder Sphinx cards (Aerid Konstrari, Denzilore Fatehold, Ingris Stingerquill, Kwia Vigorbloom, and Uldaros Theorix) are added to Friend's honorable mentions automatically.

Use `npm run refresh:cards` to force-refresh the local card assets. `npm run build` creates the static `dist/` site and `npm run preview` serves the production build locally.

## GitHub Pages

The included workflow deploys `dist/` to GitHub Pages whenever `main` is updated. In the repository settings, set Pages → Source to **GitHub Actions**. `vite.config.ts` uses a relative base path, so the site works under `https://USERNAME.github.io/REPOSITORY/` without changing the repository name in code.

## Controls

Each table is independent. Dragging between tables copies the card; dragging within a table reorders it. Use the small move menu on a card when drag-and-drop is not convenient. The shared pool can be searched or collapsed, and Presentation hides editing chrome while keeping drag-and-drop active.
