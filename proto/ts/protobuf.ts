/**
 * The protobuf-es runtime (`@bufbuild/protobuf`) for apps. An app imports it from here, never from its
 * own copy: this file resolves the one copy pinned in proto/package.json, which the generated code uses
 * too, so every app bundles exactly one runtime at the generator's version (proto/README.md, Rules).
 */
export * from '@bufbuild/protobuf';
