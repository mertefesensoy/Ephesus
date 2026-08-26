import { defaultConfig, type EphConfig } from '../shared/config'

/**
 * Config access for the main process. Until M0.5 creates the harness home at
 * ~/.ephesus/ (SDD §2), the app runs on the validated in-memory default;
 * M0.5 replaces the source with config.json + atomic writes.
 */
export function getConfig(): EphConfig {
  return defaultConfig
}
