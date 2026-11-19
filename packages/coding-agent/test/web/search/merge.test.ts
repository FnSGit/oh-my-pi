import { describe, expect, it } from "bun:test";
import { mergeSearchSources } from "@oh-my-pi/pi-coding-agent/web/search/merge";
import type { SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";

function source(url: string, extra: Partial<SearchSource> = {}): SearchSource {
	return { title: url, url, ...extra };
}

describe("mergeSearchSources", () => {
	it("ranks cross-engine consensus above a single high-authority hit", () => {
		const shared = source("https://example.com/shared", { snippet: "shared" });
		const authoritative = source("https://agency.example/report", {
			relevance: 1,
			authority: 1,
		});

		const merged = mergeSearchSources([[shared, authoritative], [shared]]);

		expect(merged.map(entry => entry.url)).toEqual(["https://example.com/shared", "https://agency.example/report"]);
	});

	it("honors an engine-reported relevance score over rank position", () => {
		const low = source("https://example.com/low", { relevance: 0.1 });
		const high = source("https://example.com/high", { relevance: 0.9 });

		const merged = mergeSearchSources([
			[low, source("https://example.com/b"), source("https://example.com/c"), high],
		]);

		expect(merged[0]!.url).toBe("https://example.com/high");
		expect(merged.at(-1)!.url).toBe("https://example.com/low");
	});
	it("dedups URL variants, keeps the best snippet, and adds no synthetic fields", () => {
		const merged = mergeSearchSources([
			[source("https://www.example.com/page/", { title: "First", snippet: "short" })],
			[source("https://example.com/page", { title: "Second", snippet: "a much longer snippet" })],
		]);

		expect(merged).toHaveLength(1);
		expect(Object.keys(merged[0]!).sort()).toEqual(["snippet", "title", "url"]);
		expect(merged[0]).toEqual({
			title: "First",
			url: "https://www.example.com/page/",
			snippet: "a much longer snippet",
		});
	});

	it("truncates to the requested limit", () => {
		const merged = mergeSearchSources([[source("https://a.example"), source("https://b.example")]], { limit: 1 });

		expect(merged).toHaveLength(1);
		expect(merged[0]!.url).toBe("https://a.example");
	});
});
