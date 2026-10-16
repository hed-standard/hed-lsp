/**
 * Own-property lookup for keyword maps.
 *
 * `map[key]` also returns members inherited from Object.prototype, so a query
 * such as `constructor` or `__proto__` would match a non-array value. Reading
 * only own properties keeps keyword lookups limited to the keys we define.
 */
export function lookupOwn<T>(map: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined;
}
