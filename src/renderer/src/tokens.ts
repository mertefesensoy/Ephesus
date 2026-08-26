/**
 * Ephesus design tokens — numeric mirror of tokens.css for canvas/Pixi consumers.
 * Source of truth: docs/design/UI-DESIGN.md §2. Keep the two files in lockstep.
 */
export const tokens = {
  marble50: 0xfbf7ef,
  marble100: 0xf4ede0,
  marble200: 0xe7dcc6,
  marble300: 0xd3c4a5,
  parchment100: 0xf7f2e4,

  ink900: 0x221a14,
  ink700: 0x4a3b2c,
  ink500: 0x7a6a55,
  ink300: 0xb3a68e,

  aegean: 0x2e6f8e,
  aegeanLight: 0x9cc4d4,
  terracotta: 0xc4552d,
  terracottaLight: 0xe8a987,
  olive: 0x7a8b3d,
  oliveLight: 0xc2cd97,
  gold: 0xd9a441,
  goldLight: 0xf0d49b,
  laurel: 0x4e9b6f,
  wine: 0x8e3b4a,

  iris: 0x7b6bc4,
  poppy: 0xd65a5a,
  sand: 0xc9a05c,
  cypress: 0x3d7a6e,

  statusIdle: 0xb3a68e,
  statusThinking: 0x2e6f8e,
  statusWorking: 0xd9a441,
  statusWaiting: 0x6c8ef5,
  statusBlocked: 0xc4552d,
  statusSuccess: 0x7a8b3d,
  statusGhost: 0xd3c4a5,
  statusLooping: 0xe07b39,
  statusCompacting: 0x8e6fb8,
  statusTyping: 0xc9a05c,

  worldPath: 0xd8cbaf,
  worldTerraceA: 0xc9a05c,
  worldTerraceB: 0xb08a4c,
  worldWall: 0x8a6b4a,
  worldSeaA: 0x2e6f8e,
  worldSeaB: 0x5a93ac,
  worldCanopy: 0x7a8b3d
} as const

export type TokenName = keyof typeof tokens
