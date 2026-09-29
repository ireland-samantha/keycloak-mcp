import { test } from 'node:test';
import { createCatalog, describeOperation } from '../../src/catalog/index.js';
import { bodyRuleNames, isIrreversible, isMutation, isSensitiveEndpoint } from '../../src/policy/classify.js';
import { catalogVersions } from '../support/catalog.js';
import { assertSnapshot } from '../support/snapshot.js';

// Every operation of every bundled catalog with its reviewed classification: whether it mutates, whether
// it is irreversible whatever its body, whether its response is withheld, and the body rules that can make
// it irreversible. A policy or catalog change that moves any operation fails here, naming the rows it
// moved; once reviewed, UPDATE_GOLDEN=1 rewrites the fixture and the diff goes into the same commit.
for (const version of catalogVersions) {
  test(`every ${version} operation keeps its reviewed classification`, () => {
    const catalog = createCatalog('', version);
    const rows = Object.fromEntries(catalog.operations.map(({ key }) => [key, {
      mutation: isMutation(key, catalog), irreversible: isIrreversible(key, catalog),
      sensitive: isSensitiveEndpoint(describeOperation(key, catalog)), bodyRules: bodyRuleNames(key, catalog),
    }]));
    assertSnapshot(new URL(`fixtures/classification-${version}.json`, import.meta.url), rows, { depth: 1 });
  });
}
