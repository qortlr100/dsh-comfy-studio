import { describe, expect, it } from "vitest";
import { EMPTY_PAYLOAD_HASH, amzDate, signRequest, uriEncode } from "./sigv4.ts";

describe("signRequest", () => {
  // "Example: GET Object" from the S3 SigV4 header-signing documentation.
  it("matches the AWS documentation example", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY_PAYLOAD_HASH,
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      date: new Date(Date.UTC(2013, 4, 24)),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.host).toBeUndefined();
  });
});

describe("uriEncode", () => {
  it("encodes everything but unreserved characters, keeping slashes on request", () => {
    expect(uriEncode("a b/c!'()*~._-")).toBe("a%20b%2Fc%21%27%28%29%2A~._-");
    expect(uriEncode("assets/한.png", true)).toBe("assets/%ED%95%9C.png");
  });
  it("formats the request timestamp", () => {
    expect(amzDate(new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678)))).toBe("20240102T030405Z");
  });
});
