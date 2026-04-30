// Intentional type error: assigning a string to a number-typed const.
import { greet } from './helper.js';

/** @type {number} */
export const value = greet('world');
