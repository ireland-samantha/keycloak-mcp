export function pathParameterNames(template) {
  return [...template.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
}

export function expandPathTemplate(template, valueFor) {
  return template.replace(/\{([^}]+)\}/g, (_match, name) => valueFor(name));
}

// The parameter name when childPath is exactly `${collectionPath}/{name}`.
export function directChildParameter(collectionPath, childPath) {
  return childPath.startsWith(`${collectionPath}/`)
    ? /^\{([^/{}]+)\}$/.exec(childPath.slice(collectionPath.length + 1))?.[1] : null;
}
