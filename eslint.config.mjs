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
  // `.claude/worktrees/` holds agent scratch checkouts of this same repo
  // (git-ignored via .git/info/exclude). Linting them makes every rule fire
  // twice and puts a second tsconfig root under the project — prettier
  // already ignores `.claude/`; this keeps eslint about this checkout too.
  { ignores: ['node_modules/**', 'out/**', 'dist/**', '.claude/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{ts,tsx}', 'shims/**/*.{ts,mjs}', 'test/**/*.{ts,mjs}'],
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
    // The hook shim and the fake engine are dependency-free ESM run by bare
    // `node` outside any bundler, so they see the Node globals directly.
    files: ['shims/**/*.mjs', 'test/fakes/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
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
