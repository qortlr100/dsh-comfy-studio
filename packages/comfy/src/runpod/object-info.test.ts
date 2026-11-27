import { describe, expect, it } from "vitest";
import { inputFileNames, pickNodeInfo, withInputFiles } from "./object-info.ts";

const SNAPSHOT = {
  KSampler: { input: { required: { steps: ["INT", { min: 1, max: 100 }] } } },
  LoadImage: {
    input: {
      required: { image: [["old.png"], { image_upload: true }] },
      optional: { mask: [["m.png"], { image_upload: true }] },
    },
  },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"], {}] } } },
  "Weird.Node": {
    input: { required: { image: ["COMBO", { options: ["x"], image_upload: true }] } },
  },
};

describe("RunPod object_info snapshot", () => {
  it("picks only the requested classes", () => {
    const picked = pickNodeInfo(SNAPSHOT, ["KSampler", "Missing", "LoadImage"]);
    expect(Object.keys(picked).toSorted()).toEqual(["KSampler", "LoadImage"]);
    expect(pickNodeInfo(null, ["KSampler"])).toEqual({});
    expect(pickNodeInfo({ KSampler: "nope" }, ["KSampler"])).toEqual({});
  });

  it("swaps upload-style image choices for the volume's input listing, leaving the rest", () => {
    const picked = pickNodeInfo(SNAPSHOT, ["LoadImage", "CheckpointLoaderSimple", "Weird.Node"]);
    // Audio and video in the folder are not image choices.
    const out = withInputFiles(picked, ["ref-1.png", "ref-2.png", "voice.wav", "clip.mp4"]);
    expect(out.LoadImage!.input!.required!.image).toEqual([
      ["ref-1.png", "ref-2.png"],
      { image_upload: true },
    ]);
    expect(out.LoadImage!.input!.optional!.mask![0]).toEqual(["ref-1.png", "ref-2.png"]);
    expect(out["Weird.Node"]!.input!.required!.image).toEqual([
      "COMBO",
      { options: ["ref-1.png", "ref-2.png"], image_upload: true },
    ]);
    expect(out.CheckpointLoaderSimple).toBe(picked.CheckpointLoaderSimple);
    // The snapshot itself is untouched.
    expect(SNAPSHOT.LoadImage.input.required.image[0]).toEqual(["old.png"]);
  });

  it("lists audio and video upload inputs from the same folder, each its own kind", () => {
    const info = pickNodeInfo(
      {
        LoadAudio: { input: { required: { audio: [["old.wav"], { audio_upload: true }] } } },
        LoadVideo: { input: { required: { file: [["old.mp4"], { video_upload: true }] } } },
      },
      ["LoadAudio", "LoadVideo"],
    );
    const out = withInputFiles(info, ["ref.png", "voice.wav", "clip.mp4", "clip.webm"]);
    expect(out.LoadAudio!.input!.required!.audio).toEqual([["voice.wav"], { audio_upload: true }]);
    expect(out.LoadVideo!.input!.required!.file).toEqual([
      ["clip.mp4", "clip.webm"],
      { video_upload: true },
    ]);
  });

  it("lists top-level input names only, sorted", () => {
    expect(
      inputFileNames(["input/b.png", "input/a.png", "input/sub/c.png", "input/", "output/x.png"]),
    ).toEqual(["a.png", "b.png"]);
  });
});
