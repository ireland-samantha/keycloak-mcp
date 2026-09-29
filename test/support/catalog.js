export const catalogVersions = ['latest', '26.3.5'];

export function samplePathArgs(operation, value = 'safe-value') {
  return Object.fromEntries(operation.parameters.filter(parameter => parameter.in === 'path' && parameter.name !== 'realm')
    .map(parameter => [parameter.name, value]));
}
