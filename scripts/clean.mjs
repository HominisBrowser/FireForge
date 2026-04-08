// SPDX-License-Identifier: EUPL-1.2
import { rm } from 'node:fs/promises';

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
