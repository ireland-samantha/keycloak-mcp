import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog } from '../../src/api.js';
import { catalogVersions } from '../support/catalog.js';
import { startScenario } from '../support/scenario.js';

const OLD_NAME = 'GET /admin/realms/{realm}/roles/{role-name}/composites/clients/{client-uuid}';
const WORKFLOWS = 'GET /admin/realms/{realm}/workflows';
const MEMBERSHIP_TYPE = 'PUT /admin/realms/{realm}/organizations/{org-id}/members/{member-id}/membership-type';
// Routes that tell the catalogs apart: only 26.3.5 names this parameter {client-uuid}, 26.3.5 lacks the
// workflows API, and only HEAD has the membership-type update.
const present = { latest: [WORKFLOWS], '26.3.5': [OLD_NAME], nightly: [WORKFLOWS, MEMBERSHIP_TYPE] };
const absent = { latest: [OLD_NAME, MEMBERSHIP_TYPE], '26.3.5': [WORKFLOWS, MEMBERSHIP_TYPE], nightly: [OLD_NAME] };

test('S1 KEYCLOAK_MCP_CATALOG_VERSION selects the catalog the stdio server searches and describes', async t => {
  for (const version of catalogVersions) await t.test(version, async t => {
    const { mcp } = await startScenario(t, { transport: 'stdio', settings: { KEYCLOAK_MCP_CATALOG_VERSION: version } });
    const catalog = createCatalog('', version);
    const search = await mcp.call('keycloak_search_operations', { limit: 1 });
    assert.equal(search.value.total, catalog.operations.length);
    assert.equal(search.value.sourceSha256, catalog.sourceSha256);
    assert.match(search.value.source, new RegExp(`^https://www\\.keycloak\\.org/docs-api/${version.replaceAll('.', '\\.')}/rest-api/openapi\\.json`));
    for (const operation of present[version]) {
      const described = await mcp.call('keycloak_describe_operation', { operation });
      assert.equal(described.isError, false, `${version} ${operation}`);
      assert.equal(described.value.origin, 'openapi');
    }
    for (const operation of absent[version]) {
      const described = await mcp.call('keycloak_describe_operation', { operation });
      assert.equal(described.isError, true, `${version} ${operation}`);
      assert.match(described.text, /not in the pinned Keycloak catalog/);
    }
  });
});
