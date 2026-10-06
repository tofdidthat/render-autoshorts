export default [
  {
    ignores: [
      'node_modules/**'
    ]
  },
  {
    files: [
      '**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        AbortSignal: 'readonly',
        Blob: 'readonly',
        Buffer: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly'
      }
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none'
        }
      ]
    }
  }
]
