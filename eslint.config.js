import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'reports/**',
      'logs/**',
      'storage/**',
      'test-results/**',
      'playwright-report/**',
      'demo-app/public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    /* Typed linting applies to TypeScript sources only; tooling JS is linted syntactically. */
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ---- typing discipline (enterprise rule 16: no stray `any`) ----
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'explicit', overrides: { constructors: 'no-public' } },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true, allowAny: false },
      ],

      // ---- rule 26: never swallow an exception ----
      'no-empty': ['error', { allowEmptyCatch: false }],
      /* Playwright fixtures and hooks must destructure their first argument, even when empty. */
      'no-empty-pattern': 'off',

      // ---- hygiene ----
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // ---- test-file specific rules ----
  {
    files: ['tests/**/*.ts'],
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      /*
       * Playwright requires a hook's first argument to be an object destructuring pattern,
       * so `({}, testInfo)` is the supported idiom for a hook that only needs testInfo.
       */
      'no-empty-pattern': 'off',
      // rule 5: no arbitrary sleeps anywhere in a test
      'playwright/no-wait-for-timeout': 'error',
      'playwright/no-force-option': 'warn',
      'playwright/no-skipped-test': ['warn', { allowConditional: true }],
      /*
       * A test "asserts" when it calls `expect`, an API validator, or a Page Object /
       * component assertion method. The rule matches the final identifier of the call, so a
       * new assertion helper must be named `expectX` / `assertX` and registered here.
       */
      'playwright/expect-expect': [
        'error',
        {
          assertFunctionNames: [
            'assertAll',
            'assertAttribute',
            'assertChecked',
            'assertContainsText',
            'assertCount',
            'assertDisabled',
            'assertEnabled',
            'assertErrorEnvelope',
            'assertHidden',
            'assertMatchesSubset',
            'assertOneOfStatus',
            'assertResponseTimeUnder',
            'assertSchema',
            'assertStatus',
            'assertSuccessEnvelope',
            'assertText',
            'assertTitle',
            'assertUrl',
            'assertValue',
            'assertVisible',
            'expect',
            'expectActiveItem',
            'expectClosed',
            'expectContainsText',
            'expectDoesNotContainText',
            'expectEmployeeAbsent',
            'expectEmployeeRow',
            'expectEmployeeVisible',
            'expectEmpty',
            'expectError',
            'expectErrorMessage',
            'expectLoaded',
            'expectNoErrorMessage',
            'expectOpen',
            'expectRole',
            'expectRowCount',
            'expectRowMatching',
            'expectSignedInAs',
            'expectSuccess',
            'verify',
          ],
        },
      ],
      'playwright/no-conditional-in-test': 'off',
      'playwright/valid-title': 'off',
    },
  },

  // ---- framework code may use console via the Logger sink only ----
  {
    files: ['src/utils/Logger.ts', 'src/reporting/**/*.ts', 'scripts/**/*', 'demo-app/**/*'],
    rules: { 'no-console': 'off' },
  },

  // ---- plain JS / MJS tooling files are not type-checked ----
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      /* Spread first: a bare `rules` key would discard everything disableTypeChecked turns off. */
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  prettier,
);
