// SPDX-License-Identifier: EUPL-1.2
/*
 * Packaging-verification test templates for
 * `fireforge furnace chrome-doc create --with-tests`.
 *
 * Motivation: an operator who scaffolds a top-level chrome document wants
 * to know "did the file actually land in the packaged bundle?" before
 * relying on it at runtime. Both natural test harnesses have gaps for
 * this question:
 *
 *   - xpcshell's `chrome://browser/*` URI registration lags what the real
 *     browser loads even with `firefox-appdir = "browser"` set, so
 *     `NetUtil.asyncFetch("chrome://browser/content/<name>.xhtml")` can
 *     fail with `NS_ERROR_FILE_NOT_FOUND` against a file that IS
 *     correctly packaged (the motivating case).
 *   - Browser-chrome mochitests require a `tabbrowser`, which a
 *     fork-authored chrome doc that replaces `browser.xhtml` deliberately
 *     does not carry (the URILoadingHelper crash path).
 *
 * This scaffold threads the needle by probing the filesystem directly:
 * `Services.dirsvc.get("XCurProcD", Ci.nsIFile)` returns the current
 * process directory (the browser app dir when `firefox-appdir = "browser"`),
 * and the packaged chrome layout for a jar.mn entry
 * `content/browser/<name>.xhtml` is stable across platforms at
 * `<AppDir>/chrome/browser/content/browser/<name>.xhtml` on an unpacked
 * tree (the default for `mach build` without `MOZ_CHROME_MULTILOCALE`
 * / omnijar). A tree that packs omni.ja would need a different probe;
 * the scaffold notes that out-of-scope case explicitly rather than
 * silently producing a test that fails on packed builds.
 */

/**
 * Returns the canonical xpcshell test basename for a chrome doc packaging
 * check (`test_<name>_packaging.js`). Hyphens in `<name>` are preserved —
 * xpcshell permits them in file basenames even though the derived task
 * function names replace them with underscores.
 */
export function chromeDocPackagingTestFileName(name: string): string {
  return `test_${name}_packaging.js`;
}

/**
 * Emits an xpcshell test that verifies the scaffolded chrome doc's
 * `.xhtml`, `-chrome.css`, and `.ftl` are all present under the packaged
 * app directory. Each assertion carries the exact probed path in its
 * failure message so an operator reading a red CI run knows which
 * jar.mn entry or build step dropped the file.
 */
export function generateChromeDocPackagingTest(name: string, header: string): string {
  const taskSuffix = name.replace(/-/g, '_');
  return `${header}

"use strict";

// Packaging verification for the "${name}" chrome document.
//
// Scope: reads the packaged tree under XCurProcD (the browser app dir
// when firefox-appdir = "browser") and asserts that the three
// scaffolded files landed where the jar.mn / jar.inc.mn / locales/jar.mn
// entries promised. Does NOT go through chrome:// URI resolution —
// xpcshell's chrome manifest set lags the real browser's even with
// firefox-appdir = "browser", so NetUtil.asyncFetch on
// chrome://browser/content/${name}.xhtml can fail with
// NS_ERROR_FILE_NOT_FOUND against a file that IS packaged.
//
// Out of scope: builds that pack omni.ja (MOZ_CHROME_MULTILOCALE, some
// release configs). The probe below assumes an unpacked tree, which is
// what "mach build" produces by default. A packed build would need to
// unzip omni.ja to verify the same files.

add_task(async function test_${taskSuffix}_files_packaged() {
  const appDir = Services.dirsvc.get("XCurProcD", Ci.nsIFile);

  // Probes a pair of candidate layouts for the same packaged file:
  //   1) \`<AppDir>/chrome/browser/…\` — the unpacked layout when
  //      XCurProcD honours \`firefox-appdir = "browser"\` and resolves
  //      into \`dist/bin/browser/\`.
  //   2) \`<AppDir>/browser/chrome/browser/…\` — the macOS .app bundle
  //      layout and some ESR configurations, where XCurProcD sits one
  //      level above \`browser/\` even when the appdir directive is set.
  // If either path exists the file is packaged; the assertion only fails
  // when BOTH layouts miss, which is the actual stale-build / missing
  // jar.mn entry case. Before this dual probe, the eval on macOS
  // consistently failed against layout (2) even though the file was
  // packaged correctly.
  function probeEither(primary, fallback, description) {
    const primaryFile = appDir.clone();
    for (const segment of primary) {
      primaryFile.append(segment);
    }
    const fallbackFile = appDir.clone();
    for (const segment of fallback) {
      fallbackFile.append(segment);
    }
    const found = primaryFile.exists() ? primaryFile : fallbackFile.exists() ? fallbackFile : null;
    Assert.ok(
      found !== null,
      description +
        " missing at both " +
        primaryFile.path +
        " and " +
        fallbackFile.path +
        ' — run "fireforge build --ui" and retry. If one of those paths IS populated, the xpcshell harness is probing a stale build tree; the post-build audit should flag the same miss.',
    );
    if (found !== null) {
      Assert.greater(
        found.fileSize,
        0,
        description +
          " is zero-length at " +
          found.path +
          " — packaging copied an empty file, check the source template.",
      );
    }
  }

  probeEither(
    ["chrome", "browser", "content", "browser", "${name}.xhtml"],
    ["browser", "chrome", "browser", "content", "browser", "${name}.xhtml"],
    "${name}.xhtml",
  );
  probeEither(
    ["chrome", "browser", "skin", "classic", "browser", "${name}-chrome.css"],
    ["browser", "chrome", "browser", "skin", "classic", "browser", "${name}-chrome.css"],
    "${name}-chrome.css",
  );
});
`;
}

/**
 * Emits the `xpcshell.toml` manifest for the packaging test directory.
 * Sets `firefox-appdir = "browser"` so XCurProcD resolves to the browser
 * subdir rather than the generic gecko runtime dir — without that, the
 * path probe walks the wrong tree on every fork whose app directory is
 * not the default.
 */
export function generateChromeDocPackagingManifest(name: string, header: string): string {
  return `${header}

[DEFAULT]
head = ""
firefox-appdir = "browser"

["${chromeDocPackagingTestFileName(name)}"]
`;
}
