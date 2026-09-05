// @ts-check
import { defineConfig } from 'astro/config'

// Static output: the site is a folder of files, deployable to Vercel, Netlify or
// GitHub Pages without change. `site` is used for canonical URLs and the sitemap.
export default defineConfig({
  site: 'https://ephesushq.com',
  output: 'static',
  // vercel.json sets trailingSlash:false, so the canonical URLs Astro emits must
  // match that or every page has a canonical pointing at a URL that redirects.
  trailingSlash: 'never',
  build: { format: 'file' },
  devToolbar: { enabled: false }
})
