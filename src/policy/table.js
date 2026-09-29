// Every operation-specific rule keycloak-mcp applies to the Keycloak Admin REST API. Each entry
// states why and cites Keycloak HEAD source; paths are relative to services/src/main/java/org/keycloak/
// unless they name another module. Everything not listed here follows the method-based defaults in
// classify.js: GET and HEAD read, every other method mutates, and DELETE is irreversible.

const RTM = 'server-spi-private/src/main/java/org/keycloak/models/utils/RepresentationToModel.java';

// Keyed by exact operation key. `mutation` and `irreversible` override the defaults.
export const OPERATION_OVERRIDES = {
  'GET /admin/realms/{realm}/identity-provider/instances/{alias}/reload-keys': {
    mutation: true, irreversible: true,
    reason: 'A GET that makes the provider fetch its remote keys and replace the cached ones; the previous keys cannot be put back.',
    source: 'services/resources/admin/IdentityProviderResource.java:502-517',
  },
  'POST /admin/realms/{realm}/client-description-converter': {
    mutation: false,
    reason: 'Converts a client description into a ClientRepresentation and returns it without storing anything.',
    source: 'services/resources/admin/RealmAdminResource.java:168-192',
  },
  'POST /admin/realms/{realm}/identity-provider/upload-certificate': {
    mutation: false,
    reason: 'Parses the uploaded certificate or key and returns it; no identity provider is changed.',
    source: 'services/resources/admin/IdentityProvidersResource.java:146-171',
  },
  'GET /admin/realms/{realm}/clients/{client-uuid}/test-nodes-available': {
    mutation: true, irreversible: true,
    reason: 'A GET that needs configure permission, makes Keycloak POST a token signed with the realm key to the management URL of every registered cluster node, and records an ACTION admin event; the calls it made cannot be taken back.',
    source: 'services/resources/admin/ClientResource.java:711-724; services/managers/ResourceAdminManager.java:392-428',
  },
  'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/policy/evaluate': {
    mutation: false,
    reason: 'Evaluates the policies for a supplied identity with view-authorization permission; the temporary user session it creates is removed before it answers.',
    source: 'authorization/admin/PolicyService.java:347-354; PolicyEvaluationService.java:109-147, :275-290',
  },
  'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/permission/evaluate': {
    mutation: false,
    reason: 'The permission route reaches the same evaluator as policy/evaluate, which stores nothing.',
    source: 'authorization/admin/PermissionService.java:37; PolicyService.java:347-354; PolicyEvaluationService.java:109-147, :275-290',
  },
  'POST /admin/realms/{realm}/clients/{client-uuid}/certificates/{attr}/download': {
    mutation: false,
    reason: 'Builds a keystore around the stored certificate with view permission and stores nothing; the keystore stays withheld as a sensitive response.',
    source: 'services/resources/admin/ClientAttributeCertificateResource.java:219-247',
  },
  'POST /admin/realms/{realm}/partial-export': {
    mutation: false,
    reason: 'Exports the realm, with groups, roles and clients on request, without changing it; Keycloak masks client secrets in the export.',
    source: 'services/resources/admin/RealmAdminResource.java:1386-1425',
  },
  'PUT /admin/realms/{realm}/users/{user-id}/credentials/{credentialId}/userLabel': {
    irreversible: false,
    reason: 'Changes only the label of a stored credential, which a PUT of the previous label restores; the credential itself is untouched.',
    source: 'services/resources/admin/UserResource.java:906-928',
  },
  'POST /admin/realms/{realm}/logout-all': {
    invalidatesServiceToken: true,
    reason: 'Moves the realm not-before to now, so every token issued earlier in that realm, the service account\'s included when it authenticates there, is rejected afterwards.',
    source: 'services/resources/admin/RealmAdminResource.java:727-731; services/managers/ResourceAdminManager.java:278-279',
  },
};

// Routes the Java admin client reaches that no bundled OpenAPI definition lists; the nightly catalog adds
// them from its admin-client supplement. The supplement derives their path-parameter names, so a rule
// matches the method and the path with every parameter written {}. A matching rule decides mutation,
// irreversible and sensitive for its route, whichever document lists it.
const route = pattern => new RegExp(`^${pattern.replaceAll('{}', '\\{\\}')}$`);
const AUTHZ = '/admin/realms/{}/clients/{}/authz/resource-server';
const TYPED_POLICY = '(?:policy/(?:aggregate|client|client-scope|group|js|regex|role|time|user)|permission/(?:resource|scope))';
const POLICY_BY_ID = `(?:policy|${TYPED_POLICY})/{}`;
const VC = '/admin/realms/{}/users/{}/vc';
const VC_SOURCE = 'protocol/oid4vc/resources/admin/UserVerifiableCredentialResource.java';
const STORAGE_SOURCE = 'model/storage-services/src/main/java/org/keycloak/services/resources/admin';
export const ADMIN_CLIENT_ROUTES = {
  'authz-policy-reads': {
    methods: ['GET'], path: route(`${AUTHZ}/(?:${TYPED_POLICY}(?:/search)?|${POLICY_BY_ID}(?:/(?:associatedPolicies|dependentPolicies|resources|scopes))?)`),
    mutation: false, irreversible: false, sensitive: false,
    reason: 'Typed authorization policy and permission reads: a list, a search by name, and one policy\'s representation, associated and dependent policies, resources and scopes. None changes anything.',
    source: 'authorization/admin/PolicyService.java:95-111, :168-302; PolicyResourceService.java:133-254; PermissionService.java:36-45',
  },
  'authz-policy-creates': {
    methods: ['POST'], path: route(`${AUTHZ}/${TYPED_POLICY}`),
    mutation: true, irreversible: false, sensitive: false,
    reason: 'Creates a policy or permission of the type in the path. Keycloak refuses a name already taken with 409 and answers 201 with the new representation, id included, and no Location, so a DELETE of that id bound to $step.responseId undoes it.',
    source: 'authorization/admin/PolicyService.java:95-166; PolicyTypeService.java:36-86',
  },
  'authz-policy-updates': {
    methods: ['PUT'], path: route(`${AUTHZ}/${POLICY_BY_ID}`),
    mutation: true, irreversible: false, sensitive: false,
    reason: 'Replaces a policy\'s name, description, decision strategy, logic, resource type, config and associated resources, scopes and policies with the body; a PUT of the representation read before puts them back.',
    source: `authorization/admin/PolicyResourceService.java:78-103; ${RTM}:1384-1460`,
  },
  'authz-policy-deletes': {
    methods: ['DELETE'], path: route(`${AUTHZ}/${POLICY_BY_ID}`),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Deletes an existing policy or permission, which a create cannot bring back under its id.',
    source: 'authorization/admin/PolicyResourceService.java:105-131',
  },
  'credential-grant-reads': {
    methods: ['GET'], path: route(`${VC}/(?:credentials|issued-credentials)`),
    mutation: false, irreversible: false, sensitive: false,
    reason: 'Lists the user\'s verifiable-credential grants (credential scope, revision, dates and a snapshot of the user\'s attributes) and the metadata of the credentials issued to the user (id, type, client, issue and expiry times); neither holds credential material.',
    source: `${VC_SOURCE}:127-144, :225-241; core/src/main/java/org/keycloak/representations/idm/oid4vc/UserVerifiableCredentialRepresentation.java:10-15; IssuedVerifiableCredentialRepresentation.java:7-33`,
  },
  'credential-grant-create': {
    methods: ['POST'], path: route(`${VC}/credentials`),
    mutation: true, irreversible: false, sensitive: false,
    reason: 'Grants the user a verifiable credential of one credential scope. Keycloak refuses a grant that exists with 409, so DELETE .../vc/credentials/{credentialScopeName} removes exactly the grant created.',
    source: `${VC_SOURCE}:83-125, :195-223`,
  },
  'credential-grant-refresh': {
    methods: ['PUT'], path: route(`${VC}/credentials/{}`),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Takes a new snapshot of the user\'s attributes into the grant and increments its revision; the request has no body, so the previous snapshot and revision cannot be written back.',
    source: `${VC_SOURCE}:146-193`,
  },
  'credential-offer': {
    methods: ['PUT'], path: route(`${VC}/credentials/send-credential-offer`),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Emails the user a link to a credential offer.', source: `${VC_SOURCE}:267-335`,
  },
  'credential-revocations': {
    methods: ['DELETE'], path: route(`${VC}/(?:credentials|issued-credentials)/{}`),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Revokes a verifiable-credential grant or an issued credential; neither comes back with its revision or id.',
    source: `${VC_SOURCE}:195-223, :243-265`,
  },
  'server-info': {
    methods: ['GET'], path: route('/admin/serverinfo'),
    mutation: false, irreversible: false, sensitive: false,
    reason: 'Returns the server\'s version, features, providers, themes and system information to a realm administrator and changes nothing. It names no realm, so it also needs realm administration enabled.',
    source: 'services/resources/admin/AdminRoot.java:273-298; services/resources/admin/info/ServerInfoAdminResource.java:121-130',
  },
  'cache-clears': {
    methods: ['POST'], path: route('/admin/realms/{}/clear-(?:realm|user|keys|crl)-cache'),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Evicts the realm, user, key or certificate-revocation-list cache; an eviction cannot be reverted.',
    source: `${STORAGE_SOURCE}/ClearRealmCacheResource.java:50-57; ClearUserCacheResource.java:50-57; ClearKeysCacheResource.java:48-55; ClearCrlCacheResource.java:48-55`,
  },
  'ldap-probes': {
    methods: ['POST'], path: route('/admin/realms/{}/(?:testLDAPConnection|ldap-server-capabilities)'),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Makes Keycloak connect to the LDAP URL in the body and bind with the body\'s credential, or with a component\'s stored one when the URL and bind DN are the component\'s. Keycloak itself does not change, but the connection and bind reach a host the caller chooses and cannot be taken back.',
    source: 'federation/ldap/src/main/java/org/keycloak/services/resources/admin/TestLdapConnectionResource.java:62-99; LdapServerCapabilitiesResource.java:72-84; ' +
      'federation/ldap/src/main/java/org/keycloak/services/managers/LDAPServerCapabilitiesManager.java:68-86, :177-202',
  },
  'user-storage-syncs': {
    methods: ['POST'], path: route('/admin/realms/{}/user-storage/{}/(?:sync|mappers/{}/sync)'),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Imports or updates users from a user storage provider, or copies a mapper\'s groups or roles between the directory and Keycloak in the direction the query names (keycloakToFed writes into the directory); what changed is not recorded, so no call undoes it.',
    source: `${STORAGE_SOURCE}/UserStorageProviderResource.java:130-183, :239-275`,
  },
  'user-storage-detach': {
    methods: ['POST'], path: route('/admin/realms/{}/user-storage/{}/(?:unlink-users|remove-imported-users)'),
    mutation: true, irreversible: true, sensitive: false,
    reason: 'Deletes the users imported from a user storage provider, or turns them into local users without their federation link; neither the users nor the links can be restored.',
    source: `${STORAGE_SOURCE}/UserStorageProviderResource.java:192-230`,
  },
};

// Mutations whose effect a later Keycloak call cannot undo. A path matching any pattern is irreversible.
export const IRREVERSIBLE_PATHS = [
  { pattern: /\/logout/, reason: 'Ends user sessions; ended sessions cannot be restored.',
    source: 'services/resources/admin/RealmAdminResource.java:718-735; UserResource.java:688' },
  { pattern: /\/reset-password/, reason: 'Replaces a stored password or emails a reset link; the old hash cannot be read back.',
    source: 'services/resources/admin/UserResource.java:773, :991' },
  { pattern: /\/send-/, reason: 'Sends an email.', source: 'services/resources/admin/UserResource.java:1094' },
  { pattern: /\/execute-actions-email/, reason: 'Sends an email with required-action links.', source: 'services/resources/admin/UserResource.java:1028' },
  { pattern: /\/client-secret/, reason: 'Regenerates the client secret; the previous secret cannot be set back.',
    source: 'services/resources/admin/ClientResource.java:300-306' },
  { pattern: /\/sessions(?:\/|$)/, reason: 'Removes a user session; sessions cannot be recreated.',
    source: 'services/resources/admin/RealmAdminResource.java:742-751' },
  { pattern: /\/brute-force\/users/, reason: 'Clears brute-force lockout state, which cannot be recreated.',
    source: 'services/resources/admin/AttackDetectionResource.java:149, :173' },
  { pattern: /\/credentials\//, reason: 'Changes a stored credential (removal, label, priority); its prior state is only readable through the sensitive credentials endpoint.',
    source: 'services/resources/admin/UserResource.java:879, :910, :939, :957' },
  { pattern: /\/disable-credential-types/, reason: 'Disabling a stored credential cannot restore its prior secret.',
    source: 'services/resources/admin/UserResource.java:750' },
  { pattern: /\/push-revocation/, reason: 'Pushes a not-before revocation to client admin URLs, an effect outside Keycloak.',
    source: 'services/resources/admin/RealmAdminResource.java:696; ClientResource.java:542' },
  { pattern: /\/testSMTPConnection/, reason: 'Sends a test email.', source: 'services/resources/admin/RealmAdminResource.java:1145, :1162' },
  { pattern: /\/impersonation/, reason: 'Opens a user session for the impersonating administrator.',
    source: 'services/resources/admin/UserResource.java:382' },
  { pattern: /\/members\/invite-/, reason: 'Sends an organization invitation email.',
    source: 'organization/admin/resource/OrganizationMemberResource.java:131, :155' },
  { pattern: /\/identity-provider\/import-config/, reason: 'Fetches identity-provider metadata from a caller-supplied URL.',
    source: 'services/resources/admin/IdentityProvidersResource.java:129, :181' },
  { pattern: /\/invitations\/\{id\}\/resend$/, reason: 'Resends an invitation email and invalidates the original invitation ID.',
    source: 'organization/admin/resource/OrganizationInvitationResource.java:408-415' },
  { pattern: /\/certificates\/\{attr\}\/(?:generate|upload)/, reason: 'Generating or uploading a client key or certificate replaces the stored certificate and removes the stored private key and jwks.string, which Keycloak never returns again.',
    source: 'services/resources/admin/ClientAttributeCertificateResource.java:116-135, :147-205, :262-300; services/util/CertificateInfoHelper.java:131-154' },
  { pattern: /\/registration-access-token$/, reason: 'Issues the client a new registration access token, which invalidates the previous one.',
    source: 'services/resources/admin/ClientResource.java:344-360' },
  { pattern: /\/partialImport$/, reason: 'Imports many resources in one call, and with ifResourceExists OVERWRITE first deletes the existing users and clients it replaces; no single compensation undoes that.',
    source: 'services/resources/admin/RealmAdminResource.java:1326-1345; partialimport/AbstractPartialImport.java:60-61; UsersPartialImport.java:99-109; ClientsPartialImport.java:100-113' },
  { pattern: /\/authz\/resource-server\/import$/, reason: 'Imports authorization settings, updating the scopes, resources and policies it matches by ID or name and creating the rest; no single compensation undoes that.',
    source: 'authorization/admin/ResourceServerService.java:132-146; server-spi-private/src/main/java/org/keycloak/models/utils/RepresentationToModel.java:1269-1380' },
  { pattern: /\/workflows\/(?:migrate$|\{id\}\/(?:activate|deactivate)\/)/, reason: 'Schedules, cancels or migrates workflow executions for existing resources.',
    source: 'workflow/admin/resource/WorkflowsResource.java:164; WorkflowResource.java:147, :201' },
];

// Request bodies that make an otherwise reversible write irreversible, keyed by rule name. A rule covers
// the operations it lists, or every operation with one of its `methods`. `applies(request)` gets the
// JSON Keycloak reads from the request as `body`, its path values as `path` (the configured realm as
// `path.realm`) and `setsSecret()`, whether the body sets a field that SECRET_FIELDS holds secret. A
// body is judged alone, without reading Keycloak's current state, so a field that would change
// something counts as changing it: send only the fields an update changes.
//
// Keycloak reads bodies with a default Jackson ObjectMapper, which coerces scalars into the field's type
// (services/util/ObjectMapperResolver.java:43-67; jackson-databind StdDeserializer#_parseBoolean). A
// Boolean reads true, "true", "True" or "TRUE", trimmed as Java trims, or an integer other than 0 as true;
// the same spellings of false, or 0, as false; and null, "", a blank string or "null" as no value. kc-head
// applied each of these to adminEventsEnabled. booleanOf gives true, false, null for no value, or REFUSED
// for a value Jackson rejects, which a rule counts as the state it guards against, so a spelling missing
// here fails closed. A Long reads numeric strings too, Arabic-Indic digits included, so a value the rules
// cannot show to be at most 0 counts as positive.
const REFUSED = Symbol('refused boolean');
const BOOLEAN_TEXTS = new Map([['true', true], ['True', true], ['TRUE', true], ['false', false], ['False', false], ['FALSE', false], ['', null], ['null', null]]);
const javaTrim = text => text.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
function booleanOf(value) {
  if (value === undefined || value === null || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'string') {
    const text = javaTrim(value);
    return BOOLEAN_TEXTS.has(text) ? BOOLEAN_TEXTS.get(text) : REFUSED;
  }
  const integer = JSON.isRawJSON(value) ? value.rawJSON : typeof value === 'number' ? JSON.stringify(value) : '';
  return /^-?\d+$/.test(integer) ? !/^-?0$/.test(integer) : REFUSED;
}
const mayTurn = (value, state) => [state, REFUSED].includes(booleanOf(value));
const keepsTrue = value => booleanOf(value) === true;
const isSet = value => value !== undefined && value !== null;
const numberOf = value => Number(JSON.isRawJSON(value) ? value.rawJSON : value);
const mayBePositive = value => isSet(value) && !(numberOf(value) <= 0);
const configHas = (body, keys) => keys.some(key => isSet(body?.config?.[key]));
const stopsRecording = (body, userEventsOff) => userEventsOff || mayTurn(body?.adminEventsEnabled, false) || mayTurn(body?.adminEventsDetailsEnabled, false) ||
  isSet(body?.eventsListeners) || isSet(body?.enabledEventTypes) || mayBePositive(body?.eventsExpiration);
const REALM_UPDATE = 'model/storage-private/src/main/java/org/keycloak/storage/datastore/DefaultExportImportManager.java';
const EVENT_PURGE = 'model/jpa/src/main/java/org/keycloak/events/jpa/JpaEventStoreProvider.java:90-111';
const ADMIN_EVENT_PURGE = 'model/jpa/src/main/java/org/keycloak/events/jpa/JpaEventStoreProvider.java:242-275; ' +
  'model/jpa/src/main/java/org/keycloak/models/jpa/entities/RealmAttributes.java:56; ' +
  'model/storage-private/src/main/java/org/keycloak/storage/datastore/DefaultDatastoreProviderFactory.java:149';
const USER = 'PUT /admin/realms/{realm}/users/{user-id}';
const CLIENT = 'PUT /admin/realms/{realm}/clients/{client-uuid}';
const REALM = 'PUT /admin/realms/{realm}';
const COMPONENT = 'PUT /admin/realms/{realm}/components/{id}';
const IDP = 'PUT /admin/realms/{realm}/identity-provider/instances/{alias}';
export const IRREVERSIBLE_BODIES = {
  'sets-credentials': {
    operations: [USER],
    applies: ({ body }) => isSet(body?.credentials),
    summary: 'the body sets credentials',
    reason: 'A user update stores every credential in the body, setting the password from a value or creating a credential through its provider; the previous password hash cannot be read back (SEC-2).',
    source: `services/resources/admin/UserResource.java:233; ${RTM}:849-873`,
  },
  'links-federation': {
    operations: [USER],
    applies: ({ body }) => isSet(body?.federationLink),
    summary: 'the body links the user to a user storage provider',
    reason: 'A user whose federation link names a provider that does not validate it is deleted the next time Keycloak loads it, by a plain read included.',
    source: 'services/resources/admin/UserResource.java:310; model/storage-private/src/main/java/org/keycloak/storage/UserStorageManager.java:159-209',
  },
  'unlocks-user': {
    operations: [USER],
    applies: ({ body }) => mayTurn(body?.enabled, true),
    summary: 'the body enables the user, which clears a brute-force lockout',
    reason: 'Enabling a temporarily or permanently locked-out user deletes its login-failure record, which cannot be recreated.',
    source: 'services/resources/admin/UserResource.java:201-213, :236-238',
  },
  'disables-service-account': {
    operations: [CLIENT],
    applies: ({ body }) => mayTurn(body?.serviceAccountsEnabled, false),
    summary: 'the body turns serviceAccountsEnabled off, which deletes the service-account user',
    reason: 'Turning service accounts off deletes the service-account user with its role mappings; turning them on again creates a different user.',
    source: 'services/resources/admin/ClientResource.java:851; services/managers/ClientManager.java:179-186, :247-258',
  },
  'drops-authorization': {
    operations: [CLIENT],
    applies: ({ body }) => !keepsTrue(body?.authorizationServicesEnabled) || mayTurn(body?.bearerOnly, true) || mayTurn(body?.publicClient, true),
    summary: 'the body does not keep authorizationServicesEnabled true, which deletes any authorization settings',
    reason: 'A client update whose body does not set authorizationServicesEnabled to true, leaving it out included, or that makes the client public or bearer-only, deletes the client\'s authorization resource server with all its resources, scopes and policies.',
    source: 'services/resources/admin/ClientResource.java:861-867, :893-907; authorization/admin/AuthorizationService.java:73-77',
  },
  'renames-realm': {
    operations: [REALM],
    applies: ({ body, path }) => isSet(body?.realm) && String(body.realm) !== path.realm,
    summary: 'the body renames the realm',
    reason: 'A different realm name renames the realm, and a compensation, which addresses the configured realm name, can no longer reach it.',
    source: `${REALM_UPDATE}:804-807`,
  },
  'moves-not-before': {
    operations: [REALM],
    applies: ({ body }) => isSet(body?.notBefore),
    summary: 'the body sets the realm not-before',
    reason: 'The realm not-before rejects every token issued before it; clients refused meanwhile have dropped their tokens, which setting it back does not restore.',
    source: `${REALM_UPDATE}:870`,
  },
  'replaces-smtp': {
    operations: [REALM],
    applies: ({ body }) => isSet(body?.smtpServer),
    summary: 'the body replaces the SMTP settings',
    reason: 'The SMTP settings are replaced whole: the stored password or token secret is dropped unless the body masks it and names the same destination, which a body alone cannot show.',
    source: `${REALM_UPDATE}:932-980`,
  },
  'stops-realm-events': {
    operations: [REALM],
    applies: ({ body }) => stopsRecording(body, mayTurn(body?.eventsEnabled, false)) || mayBePositive(body?.attributes?.adminEventsExpiration),
    summary: 'the body turns off or narrows event recording, or schedules stored events or admin events for deletion',
    reason: 'Events not recorded while recording is off or narrowed, or not passed to a removed listener, are lost for good. A positive eventsExpiration makes Keycloak delete older stored events, and a positive adminEventsExpiration realm attribute, which a scheduled task reads with Long.parseLong, makes it delete older admin events, the delayed equivalent of DELETE /admin-events (SEC-7).',
    source: `${REALM_UPDATE}:809-820, :903-910; ${EVENT_PURGE}; ${ADMIN_EVENT_PURGE}`,
  },
  'stops-events': {
    operations: ['PUT /admin/realms/{realm}/events/config'],
    applies: ({ body }) => stopsRecording(body, !keepsTrue(body?.eventsEnabled)),
    summary: 'the body turns off or narrows event recording, or schedules stored events for deletion',
    reason: 'As for the realm update, with one difference: eventsEnabled is a plain boolean in this body, so leaving it out turns user events off (SEC-7).',
    source: `services/managers/RealmManager.java:337-360; core/src/main/java/org/keycloak/representations/idm/RealmEventsConfigRepresentation.java:27; ${EVENT_PURGE}`,
  },
  'repoints-federation': {
    operations: [COMPONENT],
    applies: ({ body }) => configHas(body, ['connectionUrl', 'bindDn', 'scimurl', 'loginusername']),
    summary: 'the body changes where a user storage provider connects with its stored credential',
    reason: 'A component update keeps a bind credential the body leaves out or masks, so a new LDAP or Ipatuura address receives the stored credential on the next user search; a sent credential cannot be recalled (SEC-3).',
    source: `federation/ldap/src/main/java/org/keycloak/storage/ldap/LDAPStorageProviderFactory.java:147-169; LDAPStorageProvider.java:400; ${RTM}:1221-1245; federation/ipatuura/src/main/java/org/keycloak/ipatuura_user_spi/IpatuuraUserStorageProviderFactory.java:56-66`,
  },
  'regenerates-keys': {
    operations: [COMPONENT],
    applies: ({ body }) => configHas(body, ['keySize', 'secretSize', 'ecdsaEllipticCurveKey', 'ecdhEllipticCurveKey', 'eddsaEllipticCurveKey']),
    summary: 'the body sets a key size or curve, which generates new key material',
    reason: 'A generated key provider whose size or curve differs from its key generates a new key and discards the old one, which Keycloak never returns.',
    source: 'keys/AbstractGeneratedRsaKeyProviderFactory.java:99-113; AbstractGeneratedSecretKeyProviderFactory.java:41-54; AbstractGeneratedEcKeyProviderFactory.java:86-100; GeneratedEddsaKeyProviderFactory.java:104-117',
  },
  'drops-idp-secret': {
    operations: [IDP],
    applies: ({ body }) => !isSet(body?.config?.clientSecret) || body.config.clientSecret === '',
    summary: 'the body leaves out the identity provider\'s clientSecret, which deletes the stored secret',
    reason: 'An identity-provider update replaces the whole config map and keeps the stored clientSecret only for a clientSecret that is exactly Keycloak\'s mask; without one, or with null or an empty string, which Keycloak drops, the stored secret is deleted, and Keycloak only ever returns it masked, so no compensation can restore it. The body\'s providerId does not name the stored provider, which the update keeps: kc-head applied a body naming saml to an OIDC provider, which stayed OIDC and lost its secret. So the rule holds whatever the providerId; Keycloak accepts the mask for a provider without a secret too (SEC-2).',
    source: `services/resources/admin/IdentityProviderResource.java:195-217; ${RTM}:963-1002, :1833-1845; model/jpa/src/main/java/org/keycloak/models/jpa/JpaIdentityProviderStorageProvider.java:129-143`,
  },
  'repoints-idp-secret': {
    operations: [IDP],
    applies: ({ body }) => configHas(body, ['tokenUrl', 'tokenIntrospectionUrl']) && body.config.clientSecret === KEYCLOAK_OWN_MASKS.mask,
    summary: 'the body names a token endpoint while keeping the stored client secret',
    reason: 'A masked clientSecret keeps the stored secret, which Keycloak sends to the token and introspection endpoints, so a new address there receives it (SEC-3).',
    source: 'services/resources/admin/IdentityProviderResource.java:212-214; broker/oidc/AbstractOAuth2IdentityProvider.java:674-711, :865, :1053-1064',
  },
  'renames-role': {
    operations: ['PUT /admin/realms/{realm}/roles/{role-name}', 'PUT /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}'],
    applies: ({ body, path }) => isSet(body?.name) && String(body.name) !== path['role-name'],
    summary: 'the body renames the role',
    reason: 'A different name renames the role, and a compensation must address the old name, which no longer exists.',
    source: 'services/resources/admin/RoleResource.java:65-73; RoleContainerResource.java:338-346',
  },
  'renames-required-action': {
    operations: ['PUT /admin/realms/{realm}/authentication/required-actions/{alias}'],
    applies: ({ body, path }) => !isSet(body?.alias) || String(body.alias) !== path.alias,
    summary: 'the body changes or leaves out the required action alias',
    reason: 'The update stores the body alias as given, so a different alias renames the required action and a missing one clears its alias; either way the compensation cannot address it again.',
    source: 'services/resources/admin/AuthenticationManagementResource.java:1267-1283',
  },
  'disables-admin-permissions': {
    operations: [
      'PUT /admin/realms/{realm}/clients/{client-uuid}/management/permissions', 'PUT /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}/management/permissions',
      'PUT /admin/realms/{realm}/groups/{group-id}/management/permissions', 'PUT /admin/realms/{realm}/identity-provider/instances/{alias}/management/permissions',
      'PUT /admin/realms/{realm}/roles-by-id/{role-id}/management/permissions', 'PUT /admin/realms/{realm}/roles/{role-name}/management/permissions',
      'PUT /admin/realms/{realm}/users-management-permissions',
    ],
    applies: ({ body }) => !keepsTrue(body?.enabled),
    summary: 'the body does not keep enabled true, which deletes the permissions',
    reason: 'With fine-grained admin permissions (version 1), disabling deletes the permission policies configured for the object; enabled is a plain boolean, so leaving it out disables.',
    source: 'core/src/main/java/org/keycloak/representations/idm/ManagementPermissionReference.java:26; services/resources/admin/fgap/ClientPermissions.java:197-226; GroupPermissions.java:168-173; RolePermissions.java:83-88; IdentityProviderPermissions.java:118-123; UserPermissions.java:175-180',
  },
  'moves-group': {
    operations: [
      'POST /admin/realms/{realm}/groups', 'POST /admin/realms/{realm}/groups/{group-id}/children',
      'POST /admin/realms/{realm}/organizations/{org-id}/groups', 'POST /admin/realms/{realm}/organizations/{org-id}/groups/{group-id}/children',
    ],
    applies: ({ body }) => isSet(body?.id),
    summary: 'the body names an existing group, which Keycloak moves instead of creating one',
    reason: 'A group create whose body names an ID moves that existing group here and answers 204 without a Location; nothing is created for a compensation to delete, and the previous parent is not recorded.',
    source: 'services/resources/admin/GroupsResource.java:213-225; GroupResource.java:257-266; organization/admin/resource/OrganizationGroupsResource.java:115-141; OrganizationGroupResource.java:257-277',
  },
  'sets-secret': {
    methods: ['PUT', 'PATCH'],
    applies: request => request.setsSecret(),
    summary: 'the body sets a secret',
    reason: 'An update that sets a secret field replaces the stored secret, whose previous value keycloak-mcp never shows, so no compensation can put it back. Keycloak\'s own mask sets nothing only where MASKED_SECRET_HOLDERS says so.',
    source: `${RTM}:625-642, :1221-1245; services/resources/admin/IdentityProviderResource.java:212-214`,
  },
};

// Triggered, in place of the rules above, by a bodyBase64 body sent as JSON that keycloak-mcp cannot
// read the way Keycloak does (see readJsonBytes), for any operation the rules above cover.
export const UNREADABLE_BODY = {
  name: 'unreadable-body',
  summary: 'the body is not JSON that keycloak-mcp can read the way Keycloak does',
  reason: 'Keycloak reads JSON bodies with a default Jackson ObjectMapper, which detects UTF-8, UTF-16 and UTF-32 with or without a byte-order mark, decodes overlong UTF-8 and ignores whatever follows the first document; a body the rules cannot read could set anything they look for (SEC-2).',
  source: 'services/util/ObjectMapperResolver.java:43-67; quarkus/runtime/src/main/java/org/keycloak/quarkus/runtime/integration/jaxrs/QuarkusObjectMapperResolver.java:28-35',
};

// Holders in which Keycloak never stores its own mask as a secret: a config map keeps the stored value
// for it, and smtpServer keeps or drops the stored password (see replaces-smtp). A client secret sent
// as the mask is stored as the mask.
export const MASKED_SECRET_HOLDERS = {
  holders: ['config', 'smtpServer'],
  reason: 'Component, identity-provider and authenticator config updates keep the stored secret for a value that is exactly the mask, and the SMTP settings keep or drop it; ClientRepresentation.secret is stored as sent.',
  source: `${RTM}:1235, :625-642; services/resources/admin/IdentityProviderResource.java:212-214; AuthenticationManagementResource.java:1687-1693; ${REALM_UPDATE}:957-976`,
};

// Endpoints whose whole response is replaced by a marker unless sensitive reads are enabled.
export const SENSITIVE_RESPONSE_PATHS = [
  { pattern: /\/client-secret(?:\/|$)/, reason: 'Returns the current or rotated client secret.',
    source: 'services/resources/admin/ClientResource.java:300-306, :367-373, :831-837' },
  { pattern: /\/clients-initial-access(?:\/|$)/, reason: 'Returns client-registration initial access tokens.',
    source: 'services/resources/admin/ClientInitialAccessResource.java:84, :117' },
  { pattern: /\/credentials(?:\/|$)/, reason: 'Returns stored credential representations, including secretData and credentialData.',
    source: 'services/resources/admin/UserResource.java:826; core/src/main/java/org/keycloak/representations/idm/CredentialRepresentation.java:37-38' },
  { pattern: /\/certificates\/\{attr\}(?:\/|$)/, reason: 'Returns client certificates, generated private keys and keystore bytes.',
    source: 'services/resources/admin/ClientAttributeCertificateResource.java:101, :118-122, :221-273' },
  { pattern: /\/installation\/providers\//, reason: 'Adapter installation files embed the client secret.',
    source: 'services/resources/admin/ClientResource.java:249' },
  { pattern: /\/evaluate-scopes\/generate-example-/, reason: 'Mints signed example tokens and SAML responses for a real user.',
    source: 'services/resources/admin/ClientScopeEvaluateResource.java:195-297' },
];

// Fields of Keycloak responses that hold secrets, redacted unless sensitive reads are enabled. The list
// follows StripSecretsUtils, which Keycloak applies for callers that may not see secrets; a service
// account that can manage clients gets the client entries in clear, and the rest are masked by Keycloak
// and listed here in case a server does not. `in` names the key holding the object that carries the
// field (for a list, the key holding the list); a rule without `in` applies at any depth. `suffix`
// matches field names ending in it.
const STRIP_SECRETS = 'server-spi-private/src/main/java/org/keycloak/models/utils/StripSecretsUtils.java';
export const SECRET_FIELDS = [
  { field: 'secret', reason: 'ClientRepresentation.secret, the confidential client secret, returned in clear to a caller that can manage the client.',
    source: `services/resources/admin/ClientResource.java:207-212; ${STRIP_SECRETS}:230-233` },
  { field: 'registrationAccessToken', reason: 'The client registration access token, returned in clear by POST .../registration-access-token.',
    source: 'services/resources/admin/ClientResource.java:349-358' },
  { field: 'client.secret.rotated', in: 'attributes', reason: 'The previous client secret kept during secret rotation, returned in clear to a client manager.',
    source: `${STRIP_SECRETS}:238; server-spi-private/src/main/java/org/keycloak/models/ClientSecretConstants.java:12` },
  { suffix: 'private.key', in: 'attributes', reason: 'Client key material stored as <prefix>.private.key, such as saml.signing.private.key, returned in clear to a client manager.',
    source: `${STRIP_SECRETS}:240-247; server-spi-private/src/main/java/org/keycloak/models/Constants.java:267` },
  { field: 'password', in: 'smtpServer', reason: 'The SMTP password, which Keycloak masks.', source: `${STRIP_SECRETS}:189-193` },
  { field: 'authTokenClientSecret', in: 'smtpServer', reason: 'The client secret for SMTP token authentication, which Keycloak masks.', source: `${STRIP_SECRETS}:189-193` },
  { field: 'clientSecret', in: 'config', reason: 'IdentityProviderRepresentation.config.clientSecret, which Keycloak masks.', source: `${STRIP_SECRETS}:184-187` },
  { field: 'bindCredential', in: 'config', reason: 'The LDAP bind password, a secret provider property that Keycloak masks.',
    source: 'federation/ldap/src/main/java/org/keycloak/storage/ldap/LDAPStorageProviderFactory.java:166-169' },
  { field: 'privateKey', reason: 'A private key in any representation: CertificateRepresentation.privateKey, which POST .../identity-provider/upload-certificate returns in clear and without a PEM header for an uploaded keystore; a key provider\'s imported key, a secret provider property that Keycloak masks; and RealmRepresentation.privateKey.',
    source: 'services/util/CertificateInfoHelper.java:303-305; services/resources/admin/IdentityProvidersResource.java:146-171; keys/Attributes.java:47-48; ' +
      'core/src/main/java/org/keycloak/representations/idm/CertificateRepresentation.java:27; RealmRepresentation.java:107' },
  { field: 'keystorePassword', in: 'config', reason: 'A Java keystore key provider\'s store password, a secret provider property.',
    source: 'keys/JavaKeystoreKeyProviderFactory.java:75-76' },
  { field: 'keyPassword', in: 'config', reason: 'A Java keystore key provider\'s key password, a secret provider property.',
    source: 'keys/JavaKeystoreKeyProviderFactory.java:86-87' },
  { field: 'loginpassword', in: 'config', reason: 'The Ipatuura user storage password, a secret provider property.',
    source: 'federation/ipatuura/src/main/java/org/keycloak/ipatuura_user_spi/IpatuuraUserStorageProviderFactory.java:63-66' },
  { field: 'secret.key', in: 'config', reason: 'The reCAPTCHA secret in authenticator config, a secret property that Keycloak masks.',
    source: 'authentication/forms/RegistrationRecaptcha.java:50, :136-142' },
  { field: 'api.key', in: 'config', reason: 'The reCAPTCHA Enterprise API key in authenticator config, a secret property that Keycloak masks.',
    source: 'authentication/forms/RegistrationRecaptchaEnterprise.java:48, :152-157' },
  { field: 'value', in: 'credentials', reason: 'A credential value such as a password, which user exports strip.',
    source: `core/src/main/java/org/keycloak/representations/idm/CredentialRepresentation.java:41; ${STRIP_SECRETS}:104-107` },
  { field: 'secretData', in: 'credentials', reason: 'A credential\'s secret data, such as an OTP seed or password hash.',
    source: 'core/src/main/java/org/keycloak/representations/idm/CredentialRepresentation.java:37' },
];

// Values that are secrets whatever field holds them. A string that is itself JSON, such as a jwks.string
// client attribute, is redacted as JSON.
export const SECRET_VALUE_SHAPES = {
  pemPrivateKey: {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    reason: 'PEM private key material, for example pasted into a custom attribute; Keycloak reads keys in this form.',
    source: 'common/src/main/java/org/keycloak/common/util/PemUtils.java:41-44',
  },
  // Base64 of one DER SEQUENCE that opens with a one-byte INTEGER version and then the element named by `next`.
  derPrivateKey: {
    layouts: [
      { versions: [0, 1], next: 0x02, name: 'PKCS#1 RSAPrivateKey, two- or multi-prime (RFC 8017 appendix A.1.2)' },
      { versions: [0, 1], next: 0x30, name: 'PKCS#8 PrivateKeyInfo or OneAsymmetricKey (RFC 5958 section 2)' },
      { versions: [1], next: 0x04, name: 'SEC1 ECPrivateKey (RFC 5915 section 3)' },
    ],
    reason: 'Keycloak writes private keys as base64 DER without the PEM header and footer, so a key in a field this table does not name is recognized by its structure; no certificate or public key opens with a one-byte version.',
    source: 'crypto/default/src/main/java/org/keycloak/crypto/def/BCPemUtilsProvider.java:48-60; common/src/main/java/org/keycloak/common/crypto/PemUtilsProvider.java:137-143; services/util/CertificateInfoHelper.java:303-305',
  },
  jwkPrivateMembers: {
    members: ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'],
    reason: 'The private and symmetric members of a JSON Web Key (RFC 7518 section 6); a jwks.string client attribute is returned in clear with whatever keys were stored in it.',
    source: 'server-spi-private/src/main/java/org/keycloak/protocol/oidc/OIDCConfigAttributes.java:40',
  },
};

// Maps whose keys a deployment chooses. Keycloak cannot tell which of them hold secrets and returns them
// in clear, so an operator names such keys in KEYCLOAK_MCP_SECRET_ATTRIBUTES.
export const CUSTOM_KEY_MAPS = {
  holders: ['attributes', 'config'],
  reason: 'Realm, client, user and group attributes and component and identity-provider config accept any key.',
  source: 'core/src/main/java/org/keycloak/representations/idm/RealmRepresentation.java:219; ClientRepresentation.java:61; AbstractUserRepresentation.java:46; ComponentRepresentation.java:35; IdentityProviderRepresentation.java:66',
};

// Values Keycloak masked itself or that only reference a vault; they are not secrets and are left as
// sent, which Keycloak understands on update as "keep the stored value".
export const KEYCLOAK_OWN_MASKS = {
  mask: '**********',
  vault: /^\$\{vault\.(.+?)\}$/,
  reason: 'Keycloak masks secrets as ComponentRepresentation.SECRET_VALUE and keeps vault references visible.',
  source: `core/src/main/java/org/keycloak/representations/idm/ComponentRepresentation.java:27; ${STRIP_SECRETS}:59, :95-102`,
};

// Further fields redacted for one path, keyed by path template.
export const FIELD_REDACTIONS = {
  '/admin/realms/{realm}/admin-events': {
    fields: ['representation'],
    reason: 'Each admin event carries the changed entity, of any representation type, as a JSON string; it is withheld whole rather than left to the field rules.',
    source: 'services/resources/admin/RealmAdminResource.java:1001-1012; core/src/main/java/org/keycloak/representations/idm/AdminEventRepresentation.java:34',
  },
};

// Path parameters recorded as the redaction marker in the on-disk workflow receipt.
export const RECEIPT_SENSITIVE_PATH_PARAMETER = {
  pattern: /secret|token|password|credential/i,
  reason: 'Receipts are plain files; parameters named after credentials, such as {credentialId}, are kept out of them.',
  source: 'services/resources/admin/UserResource.java:879',
};

// The one global create a workflow may run: it must name the pinned realm and be undone by deleting it.
export const REALM_CREATION = {
  operation: 'POST /admin/realms',
  compensation: 'DELETE /admin/realms/{realm}',
  bodyField: 'realm',
  reason: 'importRealm creates the realm named in the body; deleting that realm is the only undo.',
  source: 'services/resources/admin/RealmsAdminResource.java:156-188',
};

// Completed step and compensation pairs that need a freshly minted service-account token.
export const TOKEN_REFRESH_BEFORE_COMPENSATION = [
  {
    operation: REALM_CREATION.operation, compensation: REALM_CREATION.compensation,
    reason: 'Creating a realm adds its management roles to the master admin role, so a token minted before the create lacks the roles needed to delete it.',
    source: 'services/managers/RealmManager.java:394-402',
  },
];

// Creates whose new child is addressed by a name taken from the request body rather than a generated ID.
// Names change, so right after such a create keycloak-mcp reads the child by its name (`lookup`) for its
// immutable ID (`idField`). The compensation then deletes by that ID (`deleteById`) where Keycloak has a
// route for it, and otherwise checks, right before deleting by name, that the name still has that ID.
const ROLE_BY_ID = { operation: 'DELETE /admin/realms/{realm}/roles-by-id/{role-id}', parameter: 'role-id' };
const ROLE_NAMES = 'The role is created under, and its Location names, the body name. A PUT with another name renames a role, so a later step or another administrator can give that name to a different role; roles-by-id deletes the created role whatever it is called by then.';
const ROLE_SOURCE = 'services/resources/admin/RoleContainerResource.java:170-174; RoleResource.java:65-73; RoleByIdResource.java:124-145';
export const NAMED_CREATE_TARGETS = {
  'POST /admin/realms/{realm}/roles': {
    child: 'role-name', field: 'name', lookup: 'GET /admin/realms/{realm}/roles/{role-name}', idField: 'id', deleteById: ROLE_BY_ID,
    reason: ROLE_NAMES, source: ROLE_SOURCE,
  },
  'POST /admin/realms/{realm}/clients/{client-uuid}/roles': {
    child: 'role-name', field: 'name', lookup: 'GET /admin/realms/{realm}/clients/{client-uuid}/roles/{role-name}', idField: 'id', deleteById: ROLE_BY_ID,
    reason: `${ROLE_NAMES} Client roles share the realm-wide roles-by-id route.`, source: ROLE_SOURCE,
  },
  'POST /admin/realms/{realm}/identity-provider/instances': {
    child: 'alias', field: 'alias', lookup: 'GET /admin/realms/{realm}/identity-provider/instances/{alias}', idField: 'internalId',
    reason: 'The identity provider is created under, and its Location names, the body alias. Keycloak has no route by internalId; HEAD refuses to change an alias, but an alias can be deleted and created again, so the compensation deletes by alias only while it still has the created internalId.',
    source: 'services/resources/admin/IdentityProvidersResource.java:265-291; IdentityProviderResource.java:196-205',
  },
};

// Creates that Keycloak answers with an existing object instead of refusing it, so an ID in the response
// may name something that existed before the workflow. Given an ID nothing has yet in `idField`, the
// same create is strict: Keycloak creates the object with exactly that ID or refuses a taken name with
// 409 through the table's unique constraint. keycloak-mcp therefore chooses that ID itself for any such
// create whose compensation binds the created ID.
const AUTHZ_ENTITIES = 'model/jpa/src/main/java/org/keycloak/authorization/jpa/entities';
export const UPSERT_CREATES = {
  'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope': {
    idField: 'id',
    reason: 'ScopeService.create looks the scope up by the body id, else by name, and answers 201 with the existing scope, renamed to the body name when found by id; deleting it also deletes every permission that references only that scope.',
    source: `authorization/admin/ScopeService.java:94-104, :145-154; ${RTM}:1789-1817; ${AUTHZ_ENTITIES}/ScopeEntity.java:38-40`,
  },
  'POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/resource': {
    idField: '_id',
    reason: 'ResourceSetService.create refuses a taken name only for an owner given by ID; for a body _id, or an owner given by username, the upsert updates and returns the existing resource. Scopes the body names that do not exist are created too, and deleting the resource leaves them.',
    source: `authorization/admin/ResourceSetService.java:128-156; ${RTM}:1687-1783; ${AUTHZ_ENTITIES}/ResourceEntity.java:52-54`,
  },
};

// Child path parameters that hold a server-generated ID, so a create compensation must bind them
// to the ID the create returns rather than accept a caller-chosen value.
export const GENERATED_ID_PARAMETER = {
  pattern: /id|uuid/i,
  reason: 'Creates answer with a Location ending in the generated ID ({user-id}, {client-uuid}, ...); a caller-chosen ID could name a resource that existed before the workflow.',
  source: 'services/resources/admin/UsersResource.java:179, :226; ClientsResource.java:209, :276',
};

// A path parameter whose value spans several segments; any other value must stay one segment.
export const MULTI_SEGMENT_PATH_PARAMETER = {
  name: 'path',
  reason: 'group-by-path binds {path: .*}, so a group path such as /parent/child is sent segment by segment.',
  source: 'services/resources/admin/RealmAdminResource.java:1301; organization/admin/resource/OrganizationGroupsResource.java:228',
};
