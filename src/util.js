export function now() {
  return new Date().toISOString();
}

export function randomId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function bump(version = 0) {
  return Number(version || 0) + 1;
}

export function compareVersion(a, b) {
  return Number(a || 0) - Number(b || 0);
}

export function integer(value, { name = 'value', min = 0, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

export function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

export function stableSortBy(array, selector) {
  return [...array].sort((a, b) => {
    const av = selector(a);
    const bv = selector(b);
    if (av === bv) return 0;
    return av > bv ? 1 : -1;
  });
}
