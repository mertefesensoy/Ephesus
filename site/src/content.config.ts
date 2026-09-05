import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// Posts are markdown files in src/content/blog. `date` is required and the index
// sorts by it, so a post without one fails the build rather than silently
// landing in the wrong place.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    summary: z.string(),
    tag: z.string(),
    reading: z.string()
  })
})

export const collections = { blog }
