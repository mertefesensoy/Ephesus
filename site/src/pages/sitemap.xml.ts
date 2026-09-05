import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'

// Hand-rolled rather than @astrojs/sitemap: twelve routes do not justify a
// dependency, and this way the priorities and change frequencies are ours to
// argue about rather than a plugin's defaults.
export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error('astro.config.mjs must set `site` for the sitemap to have absolute URLs')

  const posts = await getCollection('blog')
  const latestPost = posts
    .map((p) => p.data.date)
    .sort((a, b) => b.valueOf() - a.valueOf())[0]

  const iso = (d: Date) => d.toISOString().split('T')[0]
  const abs = (p: string) => new URL(p, site).href.replace(/\/$/, '') || new URL('/', site).href

  // lastmod is maintained BY HAND, and that is deliberate.
  //
  // The first version used `new Date()` for every static page, so each rebuild
  // told crawlers all nine had changed that day. Google's guidance is explicit
  // that an inaccurate lastmod is worse than none: once a site is caught
  // claiming everything changed on every deploy, the value stops being trusted
  // at all. A build timestamp is not a modification date.
  //
  // Blog posts derive theirs honestly from their own publication date. Static
  // pages carry the date they were last meaningfully edited — update the entry
  // in the same commit that changes the page, or leave it alone and the sitemap
  // stays truthful by default.
  const pages: Array<{ path: string; changefreq: string; priority: string; lastmod: string }> = [
    { path: '/', changefreq: 'weekly', priority: '1.0', lastmod: '2026-09-05' },
    { path: '/compare', changefreq: 'monthly', priority: '0.9', lastmod: '2026-09-05' },
    { path: '/city', changefreq: 'monthly', priority: '0.8', lastmod: '2026-09-05' },
    { path: '/roadmap', changefreq: 'weekly', priority: '0.8', lastmod: '2026-09-05' },
    { path: '/record', changefreq: 'weekly', priority: '0.8', lastmod: '2026-09-05' },
    { path: '/contribute', changefreq: 'weekly', priority: '0.9', lastmod: '2026-09-05' },
    { path: '/about', changefreq: 'monthly', priority: '0.6', lastmod: '2026-09-05' },
    // the blog index genuinely changes when a post lands, so this one is derived
    { path: '/blog', changefreq: 'weekly', priority: '0.9', lastmod: iso(latestPost ?? new Date()) },
    { path: '/privacy', changefreq: 'yearly', priority: '0.2', lastmod: '2026-09-05' }
  ]

  for (const post of posts) {
    pages.push({
      path: `/blog/${post.id}`,
      changefreq: 'yearly',
      priority: '0.7',
      lastmod: iso(post.data.date)
    })
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) => `  <url>
    <loc>${abs(p.path)}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>
`

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  })
}
