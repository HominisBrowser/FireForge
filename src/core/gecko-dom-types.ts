// SPDX-License-Identifier: EUPL-1.2
/** Adds Gecko's cross-compartment DOM predicates to virtual lib.dom constructor types. */
export function withGeckoDomTypes(
  ts: typeof import('typescript'),
  host: import('typescript').CompilerHost
): import('typescript').CompilerHost {
  const original = host.getSourceFile.bind(host);
  return {
    ...host,
    getSourceFile(...args) {
      const file = original(...args);
      if (!file || !args[0].endsWith('/lib.dom.d.ts')) return file;
      const source = file.text.replace(
        /declare var (\w+): \{\s*prototype: (\w+);/g,
        (declaration: string, name: string, instance: string) =>
          declaration +
          `\n    isInstance(value: unknown): value is ${instance};` +
          (name === 'MouseEvent' ? '\n    readonly MOZ_SOURCE_PEN: number;' : '')
      );
      return ts.createSourceFile(args[0], source, args[1], true);
    },
  };
}
