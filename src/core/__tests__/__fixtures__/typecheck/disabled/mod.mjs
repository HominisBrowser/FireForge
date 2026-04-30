// Identical type error to basic/mod.mjs — should NOT be reported because
// the project sets checkJs: false.
/** @type {number} */
export const value = 'not a number';
