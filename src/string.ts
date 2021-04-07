export function splitBy(value: string, sep: string): [string, string | null] {
  const index = value.indexOf(sep);
  if (index > 0) {
    const prefix = value.substr(0, index);
    const suffix = value.substr(index + 1);
    return [prefix, suffix];
  } else {
    return [value, null];
  }
}
