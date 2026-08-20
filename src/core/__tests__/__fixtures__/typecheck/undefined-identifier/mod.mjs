// Intentional undefined free identifier: `EditorState` has no
// import and no declaration anywhere — at runtime this is a ReferenceError.
// `Services` is a shim-covered Firefox global and must stay clean.
export const state = EditorState.create({ tabSize: 2 });
export const prefs = Services.prefs;
