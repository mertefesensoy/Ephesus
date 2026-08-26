import { contextBridge } from 'electron'

// The single door between renderer and main (SDD §1). M0.2 grows this into the
// typed window.eph surface; until then it exposes an empty, frozen namespace.
const eph = Object.freeze({})

contextBridge.exposeInMainWorld('eph', eph)
