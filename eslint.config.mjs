import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

// Import-boundary enforcement per ENGINEERING-STANDARDS §1 (NFR-12):
//   1. renderer may not import from main/ (or electron directly — preload is the door)
//   2. voice SDKs only under src/main/herald/
//   3. engine SDKs only under src/main/engines/
const voiceSdkPatterns = [
  {
    group: ['elevenlabs', 'elevenlabs/*', '@elevenlabs/*', 'openai', 'openai/*'],
    message: 'Voice SDK imports are allowed only under src/main/herald/ (ENGINEERING-STANDARDS §1).'
  }
]
const engineSdkPatterns = [
  {
    group: ['@anthropic-ai/*', '@openai/codex*', '@google/gemini*'],
    message:
      'Engine SDK imports are allowed only under src/main/engines/ (ENGINEERING-STANDARDS §1).'
  }
]
const rendererPatterns = [
  {
    group: ['**/main/**', 'electron', 'electron/*'],
    message:
      'The renderer is sandboxed: no main-process or electron imports — go through window.eph (SDD §1, BUILD-PROMPT §3.2).'
  }
]

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{ts,tsx}', 'shims/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/main/herald/**', 'src/main/engines/**', 'src/renderer/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...voiceSdkPatterns, ...engineSdkPatterns] }]
    }
  },
  {
    files: ['src/main/herald/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: engineSdkPatterns }]
    }
  },
  {
    files: ['src/main/engines/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: voiceSdkPatterns }]
    }
  },
  {
    // Build/maintenance scripts are plain CommonJS Node programs.
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        module: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...rendererPatterns, ...voiceSdkPatterns, ...engineSdkPatterns] }
      ]
    }
  }
)
