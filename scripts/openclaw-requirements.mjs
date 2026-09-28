// Requirement predicates for the live OpenClaw run. The harness evaluates them when it writes a
// receipt; test/openclaw-evidence.test.js evaluates them again over each committed receipt.
export const tools = ['keycloak_search_operations', 'keycloak_describe_operation', 'keycloak_describe_schema', 'keycloak_read', 'keycloak_workflow'];

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const sameSet = (actual, expected) => same([...(actual ?? [])].sort(), [...expected].sort());
const served = call => call?.httpStatus === 200 && call.ok === true;
const reads = ['gateway-search', 'gateway-describe', 'gateway-schema', 'gateway-read'];
const refusals = ['gateway-read-refuses-mutation', 'gateway-preflight-read-only', 'gateway-execute-read-only'];

const definitions = [
  ['REQ-1', 'OpenClaw installs the packed tarball into the throwaway home after source confirmation and capability consent', ['install', 'metadata'],
    e => e.install.exitCode === 0 && e.install.installed === true && e.metadata.installedUnderThrowawayHome === true],
  ['REQ-2', 'Before importing plugin code, OpenClaw reads the five tools from the manifest and the consent record covers them', ['metadata'],
    e => e.metadata.imported === false && e.metadata.diagnostics === 0 && same(e.metadata.contractTools, tools) &&
      sameSet(e.metadata.consentedTools, tools)],
  ['REQ-3', 'Without a config file, registration fails because KEYCLOAK_BASE_URL is missing and registers no tools', ['unconfigured'],
    e => e.unconfigured.status === 'error' && e.unconfigured.tools.length === 0 &&
      e.unconfigured.diagnostics.some(message => message.includes('KEYCLOAK_BASE_URL is required'))],
  ['REQ-4', 'Given a 0600 configPath and no KEYCLOAK_* variables, the runtime loads the five tools and doctor passes', ['runtime', 'doctor'],
    e => e.runtime.configMode === '0600' && e.runtime.keycloakVariablesPassed === 0 && e.runtime.status === 'loaded' &&
      e.runtime.imported === true && same(e.runtime.tools, tools) && e.runtime.diagnostics === 0 && e.doctor.exitCode === 0 &&
      e.doctor.ok === true && e.doctor.pluginErrors === 0 && e.doctor.diagnostics === 0],
  ['REQ-5', 'The Gateway serves the read-side tools, and a live read returns the configured realm, each graded successful', reads,
    e => reads.every(key => served(e[key]) && e[key].gradedError === false) && e['gateway-search'].total > 0 &&
      e['gateway-describe'].key === 'GET /admin/realms/{realm}/groups' && e['gateway-schema'].hasProperties === true &&
      e['gateway-read'].detailsStatus === 200 && e['gateway-read'].realmMatches === true],
  ['REQ-6', 'Refused calls are graded failed and write nothing; the exact-name query finds a control group', [...refusals, 'gateway-read-only-count'],
    e => refusals.every(key => served(e[key]) && e[key].gradedError === true) && served(e['gateway-read-only-count']) &&
      e['gateway-read-only-count'].gradedError === false && e['gateway-read-only-count'].controlExactNameCount === 1 &&
      e['gateway-read-only-count'].exactNameCountBefore === 0 && e['gateway-read-only-count'].exactNameCountAfter === 0],
  ['REQ-7', 'With writes enabled, a compensated create through the Gateway is rolled back, graded failed, and leaves only the control group', ['gateway-preflight-write', 'gateway-compensated-write'],
    e => {
      const preflight = e['gateway-preflight-write'];
      const cycle = e['gateway-compensated-write'];
      return served(preflight) && preflight.detailsStatus === 'PREFLIGHT_OK' && preflight.gradedError === false &&
        served(cycle) && cycle.detailsStatus === 'IN_DOUBT' && cycle.gradedError === true && cycle.createStatus === 201 &&
        cycle.forcedReadFailure === 404 && cycle.rollbackStatus === 204 && cycle.failedStepMayHaveCommitted === false &&
        cycle.priorStepsCompensated === true && cycle.exactNameCountBefore === 0 && cycle.exactNameCountAfter === 0 &&
        cycle.groupCountBefore === 1 && cycle.groupCountAfter === 1 && cycle.journalDirMode === '0700' && same(cycle.receiptModes, ['0600']);
    }],
  ['REQ-8', 'Both Gateways exited, the realm this run created is deleted, and the throwaway directory is removed', [],
    (e, cleanup) => cleanup.gatewaysExited === true && cleanup.realmDelete === 204 && cleanup.realmAbsentRead === 404 && cleanup.workDirRemoved === true],
];

export function evaluate(evidence, cleanup) {
  const step = Object.fromEntries(evidence.map(item => [item.step, item]));
  return definitions.map(([id, predicate, steps, holds]) => {
    const cited = steps.map(key => step[key]?.id ?? null);
    let status = 'NOT_RUN';
    if (cited.every(Boolean)) {
      try { status = holds(step, cleanup ?? {}) ? 'PROVEN' : 'CONTRADICTED'; } catch { status = 'CONTRADICTED'; }
    }
    return { id, predicate, evidence: cited.length ? cited : ['cleanup'], status };
  });
}
