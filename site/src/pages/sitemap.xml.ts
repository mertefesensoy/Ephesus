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

  const pages: Array<{ path: string; changefreq: string; priority: string; lastmod: string }> = [
    { path: '/', changefreq: 'weekly', priority: '1.0', lastmod: iso(new Date()) },
    { path: '/compare', changefreq: 'monthly', priority: '0.9', lastmod: iso(new Date()) },
    { path: '/city', changefreq: 'monthly', priority: '0.8', lastmod: iso(new Date()) },
    { path: '/roadmap', changefreq: 'weekly', priority: '0.8', lastmod: iso(new Date()) },
    { path: '/record', changefreq: 'weekly', priority: '0.8', lastmod: iso(new Date()) },
    { path: '/contribute', changefreq: 'weekly', priority: '0.9', lastmod: iso(new Date()) },
    { path: '/about', changefreq: 'monthly', priority: '0.6', lastmod: iso(new Date()) },
    { path: '/blog', changefreq: 'weekly', priority: '0.9', lastmod: iso(latestPost ?? new Date()) },
    { path: '/privacy', changefreq: 'yearly', priority: '0.2', lastmod: iso(new Date()) }
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
