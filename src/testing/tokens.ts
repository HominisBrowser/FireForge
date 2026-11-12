// SPDX-License-Identifier: EUPL-1.2

/**
 * A token file in the shape the token commands edit: a base `:root` divided
 * into banner categories, theme-attribute blocks, a variant block and a dark
 * `@media` block.
 */
export const TOKENS_CSS = `/* Design tokens */

:root {
  /* = Colors = */
  /* a note { with braces } */
  --acme-ink: #111111; /* static, fork-specific */
  --acme-paper: light-dark(#ffffff, #222222); /* auto (light-dark) */

  /* = Spacing = */
  --acme-gap: 8px; /* static, fork-specific */
}

:root[data-skin="plain"] {
  --acme-gap: 4px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --acme-ink: #eeeeee;
  }
}

:root[data-theme="dark"] {
  --acme-ink: #eeeeee;
}

:root[data-theme="light"]:not([data-private]) {
  --acme-ink: #111111;
}
`;
