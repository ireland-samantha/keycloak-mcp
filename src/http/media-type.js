// Types whose bodies are read and written as text rather than JSON or bytes.
export const isTextType = type => type.startsWith('text/') || type.includes('xml') || type.includes('yaml');
