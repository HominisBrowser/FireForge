// Resolves via tsconfig "paths" — should not produce TS2307.
import { greet } from '@mybrowser/greet.js';

export const message = greet('world');
