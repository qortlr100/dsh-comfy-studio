import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  PNG_TEXT_MAX_ENTRIES,
  PNG_TEXT_SCAN_LIMIT,
  PngTextError,
  pngTextChunks,
} from "./png-text.ts";
import { pngTextChunksWithCompressed } from "./png-text.server.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** One chunk with a correct length and a garbage CRC (the parser ignores CRCs). */
function chunk(type: string, data: Uint8Array | number[] = []): Uint8Array {
  const body = Uint8Array.from(data);
  const out = new Uint8Array(12 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(
    Array.from(type, (c) => c.charCodeAt(0)),
    4,
  );
  out.set(body, 8);
  out.set([0xde, 0xad, 0xbe, 0xef], 8 + body.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const IHDR = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const IDAT = chunk("IDAT", [1, 2, 3]);
const IEND = chunk("IEND");

function png(...chunks: Uint8Array[]): Uint8Array {
  return concat([Uint8Array.from(SIGNATURE), IHDR, ...chunks, IDAT, IEND]);
}

const latin1 = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
const utf8 = (s: string) => new TextEncoder().encode(s);

function tEXt(keyword: string, text: string): Uint8Array {
  return chunk("tEXt", latin1(`${keyword}\0${text}`));
}

function iTXt(keyword: string, text: string, compressed = false): Uint8Array {
  const body = compressed ? deflateSync(utf8(text)) : utf8(text);
  return chunk(
    "iTXt",
    concat([
      latin1(keyword),
      Uint8Array.from([0, compressed ? 1 : 0, 0]),
      latin1("ko\0"),
      utf8("프롬프트\0"),
      body,
    ]),
  );
}

describe("pngTextChunks", () => {
  it("reads tEXt as latin-1", () => {
    expect(pngTextChunks(png(tEXt("prompt", '{"a":1}'), tEXt("Comment", "café")))).toEqual([
      ["prompt", '{"a":1}'],
      ["Comment", "café"],
    ]);
  });

  it("reads uncompressed iTXt as UTF-8 and skips compressed iTXt and zTXt", () => {
    const zTXt = chunk(
      "zTXt",
      concat([latin1("z\0"), Uint8Array.from([0]), deflateSync(latin1("x"))]),
    );
    const bytes = png(iTXt("parameters", "고양이, 1girl"), iTXt("packed", "zipped", true), zTXt);
    expect(pngTextChunks(bytes)).toEqual([["parameters", "고양이, 1girl"]]);
  });

  it("reads compressed text with the server helper", () => {
    const zTXt = chunk(
      "zTXt",
      concat([latin1("z\0"), Uint8Array.from([0]), deflateSync(latin1("x"))]),
    );
    const bytes = png(iTXt("packed", "압축됨", true), zTXt, tEXt("plain", "p"));
    expect(pngTextChunksWithCompressed(bytes)).toEqual([
      ["packed", "압축됨"],
      ["z", "x"],
      ["plain", "p"],
    ]);
  });

  it("keeps file order across mixed chunks, ignores other chunk types and stops at IEND", () => {
    const bytes = concat([
      Uint8Array.from(SIGNATURE),
      IHDR,
      tEXt("prompt", "{}"),
      chunk("gAMA", [0, 0, 0xb1, 0x8f]),
      iTXt("workflow", '{"nodes":[]}'),
      IDAT,
      tEXt("after-idat", "yes"),
      IEND,
      tEXt("after-iend", "no"),
    ]);
    expect(pngTextChunks(bytes)).toEqual([
      ["prompt", "{}"],
      ["workflow", '{"nodes":[]}'],
      ["after-idat", "yes"],
    ]);
  });

  it("skips malformed text chunks (no keyword separator, empty keyword)", () => {
    const bytes = png(chunk("tEXt", latin1("nokeyword")), tEXt("", "x"), tEXt("ok", "1"));
    expect(pngTextChunks(bytes)).toEqual([["ok", "1"]]);
  });

  it(`collects at most ${PNG_TEXT_MAX_ENTRIES} entries`, () => {
    const many = Array.from({ length: PNG_TEXT_MAX_ENTRIES + 6 }, (_, i) => tEXt(`k${i}`, `${i}`));
    const entries = pngTextChunks(png(...many));
    expect(entries).toHaveLength(PNG_TEXT_MAX_ENTRIES);
    expect(entries.at(-1)).toEqual([`k${PNG_TEXT_MAX_ENTRIES - 1}`, `${PNG_TEXT_MAX_ENTRIES - 1}`]);
  });

  it("walks only the first 2 MB and returns what it found before", () => {
    const filler = chunk("IDAT", new Uint8Array(PNG_TEXT_SCAN_LIMIT));
    const bytes = png(tEXt("before", "1"), filler, tEXt("after", "2"));
    expect(bytes.length).toBeGreaterThan(PNG_TEXT_SCAN_LIMIT);
    expect(pngTextChunks(bytes)).toEqual([["before", "1"]]);

    // A text chunk that runs past the limit is not read either.
    const big = tEXt("big", "x".repeat(PNG_TEXT_SCAN_LIMIT));
    expect(pngTextChunks(png(tEXt("small", "s"), big))).toEqual([["small", "s"]]);
  });

  it("rejects a non-PNG signature", () => {
    expect(() => pngTextChunks(utf8('{"prompt":{}}'))).toThrow(PngTextError);
    expect(() => pngTextChunks(new Uint8Array(0))).toThrow("PNG 파일이 아닙니다");
  });

  it("rejects a truncated chunk or a file without IEND", () => {
    const whole = png(tEXt("prompt", "{}"));
    const cut = whole.subarray(0, SIGNATURE.length + IHDR.length + 10);
    expect(() => pngTextChunks(cut)).toThrow(/잘렸습니다 \(tEXt 청크/);
    const noEnd = whole.subarray(0, whole.length - IEND.length);
    expect(() => pngTextChunks(noEnd)).toThrow(/IEND/);
  });

  it("reads a Uint8Array view at a non-zero offset", () => {
    const bytes = png(tEXt("prompt", "{}"));
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    expect(pngTextChunks(padded.subarray(3))).toEqual([["prompt", "{}"]]);
  });
});
