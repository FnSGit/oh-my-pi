import { describe, expect, it } from "bun:test";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";
import { PptxConverter } from "../src/markit/converters/pptx";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** A one-slide deck whose presentation rels point at `slideTarget` verbatim. */
async function deck(slideTarget: string): Promise<Buffer> {
	const bytes = await encodeArchive("zip", [
		[
			"ppt/presentation.xml",
			`<p:presentation xmlns:p="${P_NS}" xmlns:r="${REL_NS}"><p:sldIdLst><p:sldId id="256" r:id="rId9"/></p:sldIdLst></p:presentation>`,
		],
		[
			"ppt/_rels/presentation.xml.rels",
			`<Relationships xmlns="${PKG_NS}"><Relationship Id="rId9" Type="${REL_NS}/slide" Target="${slideTarget}"/></Relationships>`,
		],
		[
			"ppt/slides/slide1.xml",
			`<p:sld xmlns:p="${P_NS}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p xmlns:a="${A_NS}"><a:r><a:t>Q4 报告</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
		],
	]);
	return Buffer.from(bytes);
}

describe("PptxConverter", () => {
	it("resolves package-absolute slide targets", async () => {
		const { markdown } = await new PptxConverter().convert(await deck("/ppt/slides/slide1.xml"), {
			extension: ".pptx",
		});

		expect(markdown).toBe("<!-- Slide 1 -->\n# Q4 报告");
	});

	it("resolves targets relative to the declaring part", async () => {
		const { markdown } = await new PptxConverter().convert(await deck("slides/slide1.xml"), { extension: ".pptx" });

		expect(markdown).toBe("<!-- Slide 1 -->\n# Q4 报告");
	});
});
