/**
 * Tests of the citation grammar and the input reference grammar of `@cs/project/grammar`.
 */
import { describe, expect, it } from "vitest";
import {
  citationTarget,
  citationUri,
  citedAsset,
  citedElement,
  citedInput,
  elementCitationUri,
  formatCitation,
  formatInputRef,
  formatInputSyntax,
  parsePromptCitations,
  splitInputRef,
} from "./grammar.ts";
import { standIn } from "./testing/support.ts";

describe("citation grammar", () => {
  it("writes an ID with parentheses so that the reader returns the whole URI and the element (V1)", () => {
    const citation = formatCitation("Mia", "character", "mia(young)");
    expect(citation).toBe("@[Mia](cs:character/mia%28young%29)");
    const [parsed] = parsePromptCitations(`${citation} waves`);
    expect(parsed?.uri).toBe("cs:character/mia%28young%29");
    expect(citedElement(parsed?.uri ?? "")).toEqual({ kind: "character", id: "mia(young)" });
    expect(elementCitationUri(standIn({ character: "mia(young)", version: 1 }))).toBe(parsed?.uri);
  });

  it("never writes an empty label or a label with a line break, and still reads both (V2)", () => {
    expect(formatCitation("", "asset", "a1")).toBe("@[a1](cs:asset/a1)");
    expect(formatCitation("Mia\nfront", "asset", "a1")).toBe("@[Mia front](cs:asset/a1)");
    expect(
      parsePromptCitations("@[](cs:asset/a1) @[Mia\nfront](cs:asset/a1)").map((c) => c.label),
    ).toEqual(["", "Mia\nfront"]);
  });

  it("reads the kind and the ID of any citation URI, which the writer writes back", () => {
    expect(citationTarget("cs:item/c%201")).toEqual({ kind: "item", id: "c 1" });
    expect(formatCitation("Item", "item", "c 1")).toBe("@[Item](cs:item/c%201)");
    expect([citationTarget("https://x"), citationTarget("cs:nothing")]).toEqual([null, null]);
  });

  it("reads a URI with a malformed escape as naming nothing, and decodes the role of an input citation", () => {
    expect([
      citedAsset("cs:asset/a%"),
      citationTarget("cs:character/c%zz"),
      citedElement("cs:character/c%"),
      citedInput("cs:input/x%"),
    ]).toEqual([null, null, null, null]);
    expect(citedInput(citationUri("input", "first frame"))).toBe("first frame");
  });

  it("writes a label from the ID that the reader can read when the label is empty", () => {
    const written = formatCitation("", "asset", "a]b\nc");
    expect(written).toBe("@[ab c](cs:asset/a%5Db%0Ac)");
    expect(
      parsePromptCitations(written).map((citation) => [citation.label, citedAsset(citation.uri)]),
    ).toEqual([["ab c", "a]b\nc"]]);
  });

  it("names no element for an asset, a record or an input citation", () => {
    expect(
      ["cs:asset/a1", "cs:record/r1", "cs:input/first_frame", "https://x"].map(citedElement),
    ).toEqual([null, null, null, null]);
  });
});

describe("input reference grammar", () => {
  it("splits each syntax and writes it back", () => {
    expect(splitInputRef("a1")).toEqual({ asset: "a1" });
    expect(splitInputRef("r7#0")).toEqual({ record: "r7", output: 0 });
    expect(splitInputRef("mia@2")).toEqual({ id: "mia", version: 2 });
    expect(splitInputRef("@2")).toEqual({ asset: "@2" });
    expect(
      [{ asset: "a1" }, { record: "r7", output: 0 }, { character: "mia", version: 2 }].map((ref) =>
        formatInputRef(standIn(ref)),
      ),
    ).toEqual(["a1", "r7#0", "mia@2"]);
    expect(["a1", "r7#0", "mia@2"].map((text) => formatInputSyntax(splitInputRef(text)))).toEqual([
      "a1",
      "r7#0",
      "mia@2",
    ]);
  });
});
