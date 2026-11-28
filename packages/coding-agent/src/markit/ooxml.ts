/**
 * OOXML packaging helpers shared by the markit converters.
 *
 * Two producer quirks break naive readers:
 * - Relationship `Target` values may be package-absolute (`/ppt/slides/slide1.xml`)
 *   instead of relative to the declaring part; naive `dir + target` joins double the path.
 * - Element names may carry any namespace prefix (`<x:workbook>`, `<p:sld>`), while the
 *   converters look elements up by local name.
 */

const ATTRIBUTE_KEY = "@_";
const TEXT_KEY = "#";

/**
 * Drops `ns:` prefixes from element names of a parsed document, in place.
 * Attributes (`@_r:id`) and text (`#text`) keys keep their prefix: relationship ids must stay
 * distinguishable from a neighboring plain `id` attribute.
 */
export function stripElementPrefixes(document: unknown): void {
	if (document === null || typeof document !== "object") return;
	if (Array.isArray(document)) {
		for (const item of document) stripElementPrefixes(item);
		return;
	}
	const record = document as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		const value = record[key];
		const colon = key.indexOf(":");
		if (colon > 0 && !key.startsWith(ATTRIBUTE_KEY) && !key.startsWith(TEXT_KEY)) {
			const local = key.slice(colon + 1);
			// A document using both `<workbook>` and `<x:workbook>` keeps the prefixed key rather than dropping data.
			if (!Object.hasOwn(record, local)) {
				record[local] = value;
				delete record[key];
			}
		}
		stripElementPrefixes(value);
	}
}

/** Resolves a relationship `Target` against the part that declares it; absolute targets resolve from the package root. */
export function resolvePartPath(partPath: string, target: string): string {
	const base = partPath.slice(0, partPath.lastIndexOf("/") + 1);
	const joined = target.startsWith("/") ? target.slice(1) : `${base}${target}`;
	const segments: string[] = [];
	for (const segment of joined.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return segments.join("/");
}
