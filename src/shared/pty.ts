import { z } from 'zod'

/**
 * PTY IPC payload validators (SDD §5 `pty:` group). Main validates every
 * renderer-supplied payload with these before touching a PTY (BUILD-PROMPT §3.2).
 */
export const ptyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'pty id: lowercase alphanumerics and dashes')

export const ptyWriteSchema = z
  .object({
    id: ptyIdSchema,
    data: z.string().max(65536)
  })
  .strict()

export const ptyResizeSchema = z
  .object({
    id: ptyIdSchema,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000)
  })
  .strict()

export const ptyKillSchema = z.object({ id: ptyIdSchema }).strict()

export type PtyWrite = z.infer<typeof ptyWriteSchema>
export type PtyResize = z.infer<typeof ptyResizeSchema>
export type PtyKill = z.infer<typeof ptyKillSchema>
