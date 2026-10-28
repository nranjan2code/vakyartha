# Skills supporting News Desk

This file is app documentation, not a skill-loader manifest or authority grant.

- app-authoring: construct the complete source/surface package and four documentation files using references/package-template.md.
- app-maintainer: change code/contracts/docs together using references/change-checklist.md, preserving data and review fingerprints.
- app-debugger plus debug-error: trace actual input/source/SQL/projection/commit failures from retained evidence before repair.
- app-operator and app-admin: published actions, scheduling, source/run receipts and exact-run recovery.
- Domain and surface procedures: daily-news for source/date/category discipline; research-brief for explicitly requested deeper source-backed research; interactive-ui and required surface-design for canonical editorial grids and controls.

Select only existing enabled skills relevant to the work. Load supporting text with read_skill_file after selection. No automatic chaining, new permissions or tool activation is implied. Ordinary app actions execute code without a model request. Keep this map aligned with actual source integrations, actions and maintenance responsibilities when updating the app.

The exact tool is web__fetch_page through the Web pages integration. Configure 1–6 credential-free public HTTPS RSS, Atom or JSON Feed URLs with name and category. Default sources cover World, Business, Technology and Science. Enable Web pages and set fetch_page to Allow before refreshing; declarations never grant permission.
