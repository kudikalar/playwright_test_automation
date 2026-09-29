/**
 * =============================================================================
 * PRAKURA PLAYWRIGHT ENTERPRISE AUTOMATION PLATFORM
 * Prettier Configuration
 * =============================================================================
 *
 * Purpose:
 * - Consistent formatting across the automation framework
 * - TypeScript / JavaScript / JSON / YAML support
 * - Stable formatting in VS Code and CI/CD
 * - Enterprise-friendly line wrapping and whitespace rules
 */

/** @type {import('prettier').Config} */
export default {
  // ---------------------------------------------------------------------------
  // Core Formatting
  // ---------------------------------------------------------------------------

  semi: true,
  singleQuote: true,
  trailingComma: 'all',

  printWidth: 100,
  tabWidth: 2,
  useTabs: false,

  // ---------------------------------------------------------------------------
  // JavaScript / TypeScript
  // ---------------------------------------------------------------------------

  arrowParens: 'always',
  bracketSpacing: true,
  bracketSameLine: false,

  // ---------------------------------------------------------------------------
  // End of Line
  // ---------------------------------------------------------------------------

  endOfLine: 'lf',

  // ---------------------------------------------------------------------------
  // Quotes
  // ---------------------------------------------------------------------------

  quoteProps: 'as-needed',
  jsxSingleQuote: false,

  // ---------------------------------------------------------------------------
  // Parentheses / Wrapping
  // ---------------------------------------------------------------------------

  singleAttributePerLine: false,

  // ---------------------------------------------------------------------------
  // Embedded Languages
  // ---------------------------------------------------------------------------

  embeddedLanguageFormatting: 'auto',

  // ---------------------------------------------------------------------------
  // Prose / Markdown
  // ---------------------------------------------------------------------------

  proseWrap: 'preserve',

  // ---------------------------------------------------------------------------
  // File Overrides
  // ---------------------------------------------------------------------------

  overrides: [
    {
      files: ['*.json', '*.json5', '*.yaml', '*.yml'],
      options: {
        singleQuote: false,
        tabWidth: 2,
      },
    },
    {
      files: ['*.md', '*.mdx'],
      options: {
        proseWrap: 'preserve',
        printWidth: 100,
      },
    },
    {
      files: ['*.html'],
      options: {
        singleQuote: false,
        printWidth: 120,
      },
    },
  ],
};