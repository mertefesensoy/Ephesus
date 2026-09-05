import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'

// Hand-rolled rather than @astrojs/rss, for the same reason as the sitemap: one
// feed does not justify a dependency, and the escaping is four characters.
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error('astro.config.mjs must set `site` for the feed to have absolute URLs')

  const posts = (await getCollection('blog')).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  )

  const self = new URL('/rss.xml', site).href
  const home = new URL('/', site).href

  const items = posts
    .map((p) => {
      const url = new URL(`/blog/${p.id}`, site).href.replace(/\/$/, '')
      return `    <item>
      <title>${esc(p.data.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${p.data.date.toUTCString()}</pubDate>
      <category>${esc(p.data.tag)}</category>
      <description>${esc(p.data.summary)}</description>
    </item>`
    })
    .join('\n')

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ephesus — notes from the build</title>
    <link>${home}</link>
    <atom:link href="${self}" rel="self" type="application/rss+xml" />
    <description>Notes from building Ephesus, a multi-agent harness you govern as its architect. Everything here comes out of the project's own records.</description>
    <language>en</language>
    <lastBuildDate>${(posts[0]?.data.date ?? new Date()).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`

  return new Response(body, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  })
}
