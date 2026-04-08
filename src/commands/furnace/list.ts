// SPDX-License-Identifier: EUPL-1.2
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { info, intro, note, outro } from '../../utils/logger.js';

/**
 * Runs the furnace list command to display all registered components.
 * @param projectRoot - Root directory of the project
 */
export async function furnaceListCommand(projectRoot: string): Promise<void> {
  intro('Furnace List');

  if (!(await furnaceConfigExists(projectRoot))) {
    info(
      'No components configured. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
    outro('Done');
    return;
  }

  const config = await loadFurnaceConfig(projectRoot);

  const stockCount = config.stock.length;
  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;
  const total = stockCount + overrideCount + customCount;

  if (total === 0) {
    info(
      'No components configured. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
    outro('Done');
    return;
  }

  // --- Stock ---
  if (stockCount > 0) {
    info('Stock:');
    for (const name of config.stock) {
      info(`  ${name}`);
    }
  }

  // --- Overrides ---
  if (overrideCount > 0) {
    info('Overrides:');
    for (const [name, entry] of Object.entries(config.overrides)) {
      let line = `  ${name} (${entry.type})`;
      if (entry.description) {
        line += ` — ${entry.description}`;
      }
      info(line);
    }
  }

  // --- Custom ---
  if (customCount > 0) {
    info('Custom:');
    for (const [name, entry] of Object.entries(config.custom)) {
      const flags: string[] = [];
      if (entry.localized) flags.push('localized');
      if (entry.register) flags.push('registered');

      let line = `  ${name}`;
      if (entry.description) {
        line += ` — ${entry.description}`;
      }
      if (flags.length > 0) {
        line += ` [${flags.join(', ')}]`;
      }
      info(line);
    }
  }

  note(
    `Stock: ${stockCount}  Overrides: ${overrideCount}  Custom: ${customCount}  Total: ${total}`,
    'Summary'
  );

  outro('List complete');
}
