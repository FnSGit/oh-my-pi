import { describe, expect, it } from "bun:test";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";
import { XlsxConverter } from "../src/markit/converters/xlsx";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function workbook(sharedStrings: string[], rows: string[]): Promise<Buffer> {
	const sst = sharedStrings.map(text => `<si><t>${text}</t></si>`).join("");
	const sheetRows = rows.map((cells, index) => `<row r="${index + 1}">${cells}</row>`).join("");
	const bytes = await encodeArchive("zip", [
		[
			"xl/workbook.xml",
			`<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		],
		[
			"xl/_rels/workbook.xml.rels",
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
		],
		["xl/sharedStrings.xml", `<sst xmlns="${NS}">${sst}</sst>`],
		["xl/worksheets/sheet1.xml", `<worksheet xmlns="${NS}"><sheetData>${sheetRows}</sheetData></worksheet>`],
	]);
	return Buffer.from(bytes);
}

describe("XlsxConverter", () => {
	it("keeps numeric-looking text cells verbatim (issue #16831)", async () => {
		const input = await workbook(
			["id", "12345678901234567890", "12345678901234567891", "00123"],
			[
				`<c t="s"><v>0</v></c>`,
				`<c t="s"><v>1</v></c>`,
				`<c t="s"><v>2</v></c>`,
				`<c t="s"><v>3</v></c>`,
				`<c t="inlineStr"><is><t>0x1A</t></is></c>`,
				`<c><v>42.5</v></c>`,
				`<c t="b"><v>1</v></c>`,
			],
		);

		const { markdown } = await new XlsxConverter().convert(input, { extension: ".xlsx" });

		expect(markdown).toBe(
			[
				"## Data",
				"",
				"| id |",
				"| --- |",
				"| 12345678901234567890 |",
				"| 12345678901234567891 |",
				"| 00123 |",
				"| 0x1A |",
				"| 42.5 |",
				"| TRUE |",
			].join("\n"),
		);
	});

	it("reads workbooks that prefix every element and use package-absolute targets", async () => {
		const bytes = await encodeArchive("zip", [
			[
				"xl/workbook.xml",
				`<x:workbook xmlns:x="${NS}" xmlns:r="${REL_NS}"><x:sheets><x:sheet name="数据" sheetId="1" r:id="R1"/></x:sheets></x:workbook>`,
			],
			[
				"xl/_rels/workbook.xml.rels",
				`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R1" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
			],
			[
				"xl/worksheets/sheet1.xml",
				`<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>地区</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
			],
		]);

		const { markdown } = await new XlsxConverter().convert(Buffer.from(bytes), { extension: ".xlsx" });

		expect(markdown).toBe(["## 数据", "", "| 地区 |", "| --- |"].join("\n"));
	});
});
