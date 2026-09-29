import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRefusedOffline, executeWorkflow, receipts } from '../support/scenario.js';
import { createStep, missingUser, readRealm } from '../support/steps.js';

const createdId = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const otherId = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e50';
const userCreate = createStep('users', 'user-id', { username: 'outcome-user' });
const client = { 'client-uuid': 'client-1' };
const authz = `/admin/realms/{realm}/clients/{client-uuid}/authz/resource-server`;
const responseIdCreate = (kind, idName) => ({ operation: `POST ${authz}/${kind}`, args: { path: client, body: { name: 'outcome' } },
  compensate: { operation: `DELETE ${authz}/${kind}/{${idName}}`, args: { path: { ...client, [idName]: '$step.responseId' } } } });
const deletes = mock => mock.adminRequests().filter(request => request.method === 'DELETE').map(request => request.path);

test('J1 a create without a Location is IN_DOUBT and nothing is deleted', async t => {
  const { mock, result } = await executeWorkflow(t, [userCreate], { program: mock => mock.on('POST /admin/realms/{realm}/users', { status: 201 }) });
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.error, 'create succeeded without a Location for compensation');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.deepEqual(deletes(mock), []);
});

test('J2 a Location that does not name one child of the collection is not trusted', async t => {
  const cases = [
    ['another collection', mock => mock.location(`${mock.realmPath}/groups/${createdId}`), /does not identify a child of the requested collection/],
    ['another origin', mock => `http://keycloak.example.invalid${mock.realmPath}/users/${createdId}`, /outside the configured Keycloak origin/],
    ['a nested path', mock => mock.location(`${mock.realmPath}/users/${createdId}/groups`), /has no single resource ID/],
    ['a query', mock => mock.location(`${mock.realmPath}/users/${createdId}?next=1`), /does not identify a child of the requested collection/],
  ];
  for (const [name, location, message] of cases) await t.test(name, async t => {
    const { mock, result } = await executeWorkflow(t, [userCreate], { program: mock =>
      mock.on('POST /admin/realms/{realm}/users', { status: 201, headers: { location: location(mock) } }) });
    assert.equal(result.status, 'IN_DOUBT');
    assert.match(result.error, message);
    assert.deepEqual(deletes(mock), []);
  });
});

test('J3 an IN_DOUBT result has the documented shape', async t => {
  const { mock, result } = await executeWorkflow(t, [userCreate, missingUser], { program: mock =>
    mock.on('POST /admin/realms/{realm}/users', mock.created(`${mock.realmPath}/users/${createdId}`)) });
  assert.deepEqual(Object.keys(result), ['runId', 'status', 'failedOperation', 'error', 'failedStepMayHaveCommitted',
    'priorStepsCompensated', 'rollback', 'completed']);
  assert.deepEqual(result.completed, [{ operation: 'POST /admin/realms/{realm}/users', status: 201,
    location: mock.location(`${mock.realmPath}/users/${createdId}`), id: createdId }]);
});

test('J4 a committed create whose compensation cannot be bound still reports what it created', async t => {
  const { mock, result, journalDir } = await executeWorkflow(t, [userCreate], { program: mock =>
    mock.on('POST /admin/realms/{realm}/users', mock.created(`${mock.realmPath}/users/${createdId}/groups`)) });
  const location = mock.location(`${mock.realmPath}/users/${createdId}/groups`);
  assert.equal(result.status, 'IN_DOUBT');
  assert.equal(result.failedStepMayHaveCommitted, true);
  assert.deepEqual(result.failedStepResponse, { status: 201, location });
  assert.deepEqual(deletes(mock), []);
  assert.deepEqual(receipts(journalDir)[0].failedStepResponse, { status: 201, location });
});

test('J5 a mutation that was never sent is not reported as possibly committed', async t => {
  const { mock, result } = await executeWorkflow(t, [readRealm, userCreate], { program: mock =>
    mock.onToken(() => mock.issueToken({ expiresIn: 0 }), { status: 503, json: { error: 'temporarily_unavailable' } }) });
  assert.deepEqual(mock.adminRequests().map(request => request.method), ['GET']);
  assert.equal(result.failedStepMayHaveCommitted, false);
});

test('J6 the error Keycloak sent is part of the failure report', async t => {
  const conflict = createStep('groups', 'group-id', { name: 'fixture-group' });
  const { result } = await executeWorkflow(t, [conflict], { program: mock => mock.on('POST /admin/realms/{realm}/groups', mock.fixture('groups.conflict')) });
  assert.match(result.error, /Top level group named 'fixture-group' already exists/);
});

test('J7 $step.responseId is refused where keycloak-mcp withholds the create response', async t => {
  const initialAccess = { operation: 'POST /admin/realms/{realm}/clients-initial-access', args: { body: { expiration: 60, count: 1 } },
    compensate: { operation: 'DELETE /admin/realms/{realm}/clients-initial-access/{id}', args: { path: { id: '$step.responseId' } } } };
  const refused = await executeWorkflow(t, [initialAccess]);
  assertRefusedOffline(refused.mock, refused, /step 1 cannot bind \$step\.responseId to a response keycloak-mcp withholds; use \$step\.locationId/);
  const byLocation = { ...initialAccess, compensate: { ...initialAccess.compensate, args: { path: { id: '$step.locationId' } } } };
  const { result } = await executeWorkflow(t, [byLocation, missingUser], { program: mock =>
    mock.on('POST /admin/realms/{realm}/clients-initial-access', mock.created(`${mock.realmPath}/clients-initial-access/${createdId}`)) });
  assert.equal(result.priorStepsCompensated, true);
});

test('K1 $step.locationId binds the ID from an absolute or a relative Location', async t => {
  for (const [name, location] of [['absolute', mock => mock.location(`${mock.realmPath}/users/${createdId}`)],
    ['relative', mock => `${mock.realmPath}/users/${createdId}`]]) await t.test(name, async t => {
    const { mock, result } = await executeWorkflow(t, [userCreate, missingUser], { program: mock =>
      mock.on('POST /admin/realms/{realm}/users', { status: 201, headers: { location: location(mock) } }) });
    assert.equal(result.priorStepsCompensated, true);
    assert.deepEqual(deletes(mock), [`${mock.realmPath}/users/${createdId}`]);
  });
});

test('K2 $step.responseId binds a generated id or _id from the JSON body', async t => {
  for (const [kind, idName, body] of [['scope', 'scope-id', { id: createdId, name: 'outcome' }],
    ['resource', 'resource-id', { _id: createdId, name: 'outcome' }]]) await t.test(kind, async t => {
    const { mock, result } = await executeWorkflow(t, [responseIdCreate(kind, idName), missingUser], { program: mock =>
      mock.on(`POST ${authz}/${kind}`, { status: 201, json: body }) });
    assert.equal(result.priorStepsCompensated, true);
    assert.deepEqual(deletes(mock), [`${mock.realmPath}/clients/client-1/authz/resource-server/${kind}/${createdId}`]);
  });
});

test('K3 ambiguous or conflicting generated IDs are refused and nothing is deleted', async t => {
  const resource = responseIdCreate('resource', 'resource-id');
  const cases = [
    ['id and _id disagree', { status: 201, json: { id: createdId, _id: otherId } }, /no unambiguous generated UUID/],
    ['the id is not a UUID', { status: 201, json: { _id: 'existing-name' } }, /no unambiguous generated UUID/],
    ['the id disagrees with Location', (request, mock) => ({ status: 201, json: { _id: createdId },
      headers: { location: mock.location(`${mock.realmPath}/clients/client-1/authz/resource-server/resource/${otherId}`) } }), /disagrees with Location/],
  ];
  for (const [name, response, message] of cases) await t.test(name, async t => {
    const { mock, result } = await executeWorkflow(t, [resource], { program: mock => mock.on(`POST ${authz}/resource`, response) });
    assert.equal(result.status, 'IN_DOUBT');
    assert.match(result.error, message);
    assert.deepEqual(deletes(mock), []);
  });
  await t.test('the compensation targets another collection', async t => {
    const { mock, isError, text } = await executeWorkflow(t, [{ ...resource, compensate: { operation: `DELETE ${authz}/scope/{scope-id}`,
      args: { path: { ...client, 'scope-id': '$step.responseId' } } } }]);
    assertRefusedOffline(mock, { isError, text }, /compensation must target the created resource/);
  });
});

test('K4 named creates are compensated by deleting exactly that name', async t => {
  const { mock, result } = await executeWorkflow(t, [
    { operation: 'POST /admin/realms/{realm}/roles', args: { body: { name: 'k4 role' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/roles/{role-name}', args: { path: { 'role-name': 'k4 role' } } } },
    { operation: 'POST /admin/realms/{realm}/identity-provider/instances', args: { body: { alias: 'k4-idp', providerId: 'oidc' } },
      compensate: { operation: 'DELETE /admin/realms/{realm}/identity-provider/instances/{alias}', args: { path: { alias: 'k4-idp' } } } },
    missingUser,
  ]);
  assert.equal(result.priorStepsCompensated, true);
  assert.deepEqual(deletes(mock), [`${mock.realmPath}/identity-provider/instances/k4-idp`, `${mock.realmPath}/roles/k4%20role`]);
});
