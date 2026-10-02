# hammerkit.dev

The website and documentation, built with [Fumadocs](https://fumadocs.dev) on
Next.js and exported as a static site to GitHub Pages
([workflow](../.github/workflows/website.yaml)).

```bash
npm install
npm run dev       # http://localhost:3000
npm run build     # static export to out/
```

- `app/(home)` — the landing page and `/changelog`
- `content/docs` — the documentation pages (MDX); the sidebar follows the
  `meta.json` files
- `content/changelog` — one entry per release (`version`, `date` frontmatter)
- `app/sitemap.ts`, `app/robots.ts` — `sitemap.xml` and `robots.txt`; search,
  `llms.txt` and per-page Markdown come with Fumadocs

The YAML examples in `content/docs` are validated against the build-file schema
by `src/schema/doc-build-files.spec.ts`, so a docs example the tool would reject
fails the unit tests.
