/**
 * Tests of the citations of a prompt: parsing, the cited assets, and replacement.
 */
import { describe, expect, it } from "vitest";
import { brandString } from "@deepseek-ai/dsh-brand";
import {
  citedAsset,
  citedInput,
  elementCitationUri,
  parsePromptCitations,
  promptAssets,
  replacePromptCitations,
  type AssetId,
} from "./index.ts";

const PROMPT =
  "@[Mia · front](cs:asset/a1) meets @[Bo](cs:asset/b%2F2) by @[the lake](cs:element/e1@2), then @[Mia](cs:asset/a1) waves";

describe("prompt citations", () => {
  it("finds each citation with its label, URI and offsets", () => {
    const citations = parsePromptCitations(PROMPT);
    expect(citations.map(({ label, uri }) => ({ label, uri }))).toEqual([
      { label: "Mia · front", uri: "cs:asset/a1" },
      { label: "Bo", uri: "cs:asset/b%2F2" },
      { label: "the lake", uri: "cs:element/e1@2" },
      { label: "Mia", uri: "cs:asset/a1" },
    ]);
    expect(PROMPT.slice(citations[1]?.start, citations[1]?.end)).toBe("@[Bo](cs:asset/b%2F2)");
    expect(parsePromptCitations("a cat [x](cs:asset/a1) @[y](https://example.com)")).toEqual([]);
  });

  it("names the cited assets once each, in the order of their first citation", () => {
    expect(citedAsset("cs:asset/b%2F2")).toBe("b/2");
    expect(citedAsset("cs:element/e1@2")).toBeNull();
    expect(citedInput("cs:input/first_frame")).toBe("first_frame");
    expect(citedInput("cs:asset/a1")).toBeNull();
    // A prompt cites an element without its version; the input reference names the version.
    expect(elementCitationUri({ test_character: "c 1", version: 2 })).toBe(
      "cs:test_character/c%201",
    );
    expect(elementCitationUri({ test_location: "l1", version: 1 })).toBe("cs:test_location/l1");
    expect(elementCitationUri({ test_style: "s1", version: 1 })).toBe("cs:test_style/s1");
    expect(elementCitationUri({ asset: brandString<AssetId>("a1") })).toBeNull();
    expect(promptAssets(PROMPT)).toEqual(["a1", "b/2"]);
    expect(promptAssets("a cat")).toEqual([]);
  });

  it("replaces each citation and keeps the text around it", () => {
    expect(replacePromptCitations(PROMPT, (citation) => `<${citation.label}>`)).toBe(
      "<Mia · front> meets <Bo> by <the lake>, then <Mia> waves",
    );
    expect(replacePromptCitations("a cat", () => "x")).toBe("a cat");
  });
});
