import { describe, expect, it } from "vitest";
import {
  errorMessageOf,
  parseJobOutput,
  parseJobRecord,
  parseJobStatus,
  parseRunResponse,
} from "./protocol.ts";

const OUTPUT = {
  images: [
    {
      node_id: "9",
      output_key: "images",
      filename: "x_00001_.png",
      subfolder: "",
      type: "volume",
      data: "x_00001_.png",
    },
    {
      node_id: 12,
      output_key: "gifs",
      filename: "clip.mp4",
      subfolder: "video",
      type: "volume",
      data: "video\\clip.mp4",
    },
    { node_id: "9", filename: "x_00001_.png", subfolder: "", type: "volume", data: "dup" },
    { node_id: "13", filename: "inline.png", type: "base64", data: "iVBOR..." },
    { not: "a file" },
  ],
  errors: ["node 7 skipped", { error: "warn", details: ["a", "b"] }],
  output_dir: "/runpod-volume/output",
};

describe("RunPod job API parsers", () => {
  it("reads the job id from /run", () => {
    expect(parseRunResponse({ id: "abc-123", status: "IN_QUEUE" })).toBe("abc-123");
    expect(parseRunResponse({ status: "IN_QUEUE" })).toBeNull();
    expect(parseRunResponse("nope")).toBeNull();
  });

  it("maps every /status state", () => {
    expect(parseJobStatus({ status: "IN_QUEUE" })).toEqual({ status: "pending", progress: null });
    expect(
      parseJobStatus({ status: "IN_PROGRESS", output: { node: 3, value: 5, max: 20 } }),
    ).toEqual({ status: "pending", progress: { node: "3", value: 5, max: 20 } });
    // Picked up by a worker but no progress payload (yet, or an image without progress reports).
    const started = { status: "pending", progress: { node: null, value: null, max: null } };
    expect(parseJobStatus({ status: "IN_PROGRESS", output: "warming up" })).toEqual(started);
    expect(parseJobStatus({ status: "IN_PROGRESS" })).toEqual(started);
    expect(parseJobStatus({ status: "COMPLETED", output: OUTPUT })).toEqual({
      status: "completed",
      output: OUTPUT,
    });
    expect(parseJobStatus({ status: "COMPLETED" })).toEqual({ status: "completed", output: null });
    expect(
      parseJobStatus({
        status: "FAILED",
        output: { error: "Error queuing workflow", details: ["ckpt_name: not in list"] },
      }),
    ).toEqual({ status: "failed", error: "Error queuing workflow: ckpt_name: not in list" });
    expect(parseJobStatus({ status: "FAILED", error: "worker crashed" })).toEqual({
      status: "failed",
      error: "worker crashed",
    });
    expect(parseJobStatus({ status: "FAILED" })).toMatchObject({ status: "failed" });
    expect(parseJobStatus({ status: "TIMED_OUT" })).toMatchObject({ status: "failed" });
    expect(parseJobStatus({ status: "CANCELLED" })).toEqual({ status: "cancelled" });
    expect(parseJobStatus({ status: "SOMETHING_NEW" })).toEqual({
      status: "pending",
      progress: null,
    });
    expect(parseJobStatus({ nope: true })).toBeNull();
  });

  it("turns the handler's result into volume-backed output files, noting the rest", () => {
    const out = parseJobOutput(OUTPUT);
    expect(out.kind).toBe("succeeded");
    if (out.kind !== "succeeded") return;
    expect(out.files).toEqual([
      {
        nodeId: "9",
        filename: "x_00001_.png",
        subfolder: "",
        type: "output",
        volumePath: "x_00001_.png",
      },
      {
        nodeId: "12",
        filename: "clip.mp4",
        subfolder: "video",
        type: "output",
        volumePath: "video/clip.mp4",
      },
    ]);
    expect(out.warnings).toEqual([
      "inline.png: 볼륨에 남지 않은 출력(base64)은 받을 수 없습니다",
      "node 7 skipped",
      "warn: a; b",
    ]);
  });

  it("treats a result carrying `error` as a failure, and garbage as one too", () => {
    expect(parseJobOutput({ error: "Missing 'workflow' parameter" })).toEqual({
      kind: "failed",
      error: "Missing 'workflow' parameter",
    });
    expect(parseJobOutput(null)).toMatchObject({ kind: "failed" });
    expect(parseJobOutput({ images: [] })).toEqual({ kind: "succeeded", files: [], warnings: [] });
  });

  it("reads the handler's job record", () => {
    expect(parseJobRecord({ id: "j1", finished_at: 1, output: OUTPUT })).toEqual(OUTPUT);
    expect(parseJobRecord({ id: "j1" })).toBeNull();
    expect(parseJobRecord("x")).toBeNull();
  });

  it("finds a message in strings and error objects only", () => {
    expect(errorMessageOf(null, undefined, "  boom ")).toBe("boom");
    expect(errorMessageOf({ message: "m", details: "d" })).toBe("m: d");
    expect(errorMessageOf({ images: [] })).toBeNull();
  });
});
