import dicomParser from "dicom-parser";
import { describe, expect, it } from "vitest";
import { expandMultiFrameDicom } from "./splitMultiFrame";

// Minimal explicit-VR little-endian DICOM writer for synthetic test data.
type El = [tag: number, vr: string, value: Uint8Array];
const enc = new TextEncoder();
const str = (s: string) => enc.encode(s.length % 2 ? `${s} ` : s);
const u16 = (v: number) => new Uint8Array(new Uint16Array([v]).buffer);
const u32 = (v: number) => new Uint8Array(new Uint32Array([v]).buffer);
const LONG = new Set(["OB", "OW", "SQ"]);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function encode([tag, vr, value]: El): Uint8Array {
  const head = new DataView(new ArrayBuffer(LONG.has(vr) ? 12 : 8));
  head.setUint16(0, tag >>> 16, true);
  head.setUint16(2, tag & 0xffff, true);
  head.setUint8(4, vr.charCodeAt(0));
  head.setUint8(5, vr.charCodeAt(1));
  if (LONG.has(vr)) head.setUint32(8, value.length, true);
  else head.setUint16(6, value.length, true);
  return concat([new Uint8Array(head.buffer), value]);
}

/** A sequence of items, each item a list of elements (explicit lengths). */
function seq(tag: number, items: El[][]): El {
  const body = items.map((item) => {
    const content = concat(item.map(encode));
    return concat([u16(0xfffe), u16(0xe000), u32(content.length), content]);
  });
  return [tag, "SQ", concat(body)];
}

interface VolumeOptions {
  frames: number;
  size: number;
  pixelRepresentation?: number;
  rescaleIntercept?: string;
  transferSyntax?: string;
}

function multiFrameVolume(opts: VolumeOptions): File {
  const { frames, size, pixelRepresentation = 0, rescaleIntercept } = opts;
  const transferSyntax = opts.transferSyntax ?? "1.2.840.10008.1.2.1";
  // Each frame is filled with its own index so frames can be told apart.
  const pixels = new Uint16Array(frames * size * size);
  for (let f = 0; f < frames; f++) pixels.fill(1000 + f, f * size * size, (f + 1) * size * size);

  const sharedItem: El[] = [
    seq(0x00209116, [[[0x00200037, "DS", str("1\\0\\0\\0\\1\\0")]]]),
    seq(0x00289110, [
      [
        [0x00180050, "DS", str("0.25")],
        [0x00280030, "DS", str("0.25\\0.25")],
      ],
    ]),
    seq(0x00289132, [
      [
        [0x00281050, "DS", str("1024")],
        [0x00281051, "DS", str("4096")],
      ],
    ]),
    ...(rescaleIntercept
      ? [
          seq(0x00289145, [
            [
              [0x00281052, "DS", str(rescaleIntercept)],
              [0x00281053, "DS", str("1")],
            ],
          ]),
        ]
      : []),
  ];
  const perFrame = Array.from({ length: frames }, (_, f): El[] => [
    seq(0x00209113, [[[0x00200032, "DS", str(`-10\\-20\\${(f * 0.25).toFixed(2)}`)]]]),
  ]);

  const meta = concat(
    (
      [
        [0x00020001, "OB", new Uint8Array([0, 1])],
        [0x00020002, "UI", str("1.2.840.10008.5.1.4.1.1.13.1.2")],
        [0x00020003, "UI", str("1.2.3.4")],
        [0x00020010, "UI", str(transferSyntax)],
      ] as El[]
    ).map(encode),
  );
  const dataset: El[] = [
    [0x00080016, "UI", str("1.2.840.10008.5.1.4.1.1.13.1.2")],
    [0x00080018, "UI", str("1.2.3.4")],
    [0x00080060, "CS", str("DX")],
    [0x00100010, "PN", str("Test^Patient")],
    [0x0020000d, "UI", str("1.2.3")],
    [0x0020000e, "UI", str("1.2.3.9")],
    [0x00280002, "US", u16(1)],
    [0x00280004, "CS", str("MONOCHROME2")],
    [0x00280008, "IS", str(String(frames))],
    [0x00280010, "US", u16(size)],
    [0x00280011, "US", u16(size)],
    [0x00280100, "US", u16(16)],
    [0x00280101, "US", u16(12)],
    [0x00280102, "US", u16(11)],
    [0x00280103, "US", u16(pixelRepresentation)],
    seq(0x52009229, [sharedItem]),
    seq(0x52009230, perFrame),
    [0x7fe00010, "OW", new Uint8Array(pixels.buffer)],
  ];
  const bytes = concat([
    new Uint8Array(128),
    enc.encode("DICM"),
    encode([0x00020000, "UL", u32(meta.length)]),
    meta,
    ...dataset.map(encode),
  ]);
  return new File([bytes as BlobPart], "X3D");
}

function singleFrame(name: string, sopClass: string): File {
  const meta = encode([0x00020010, "UI", str("1.2.840.10008.1.2.1")]);
  const bytes = concat([
    new Uint8Array(128),
    enc.encode("DICM"),
    encode([0x00020000, "UL", u32(meta.length)]),
    meta,
    encode([0x00080016, "UI", str(sopClass)]),
  ]);
  return new File([bytes as BlobPart], name);
}

async function parse(file: File) {
  return dicomParser.parseDicom(new Uint8Array(await file.arrayBuffer()));
}

// 1024² × 16-bit × 5 frames ≈ 10 MB, above the multi-frame probe threshold.
const SIZE = 1024;
const FRAMES = 5;

describe("expandMultiFrameDicom", () => {
  it("splits a multi-frame volume into single-frame CT slices", async () => {
    const out = await expandMultiFrameDicom([multiFrameVolume({ frames: FRAMES, size: SIZE })]);
    expect(out).toHaveLength(FRAMES);

    for (const [i, file] of out.entries()) {
      const ds = await parse(file);
      expect(ds.string("x00080016")).toBe("1.2.840.10008.5.1.4.1.1.2");
      expect(ds.string("x00080018")).toBe(`1.2.3.4.${i + 1}`);
      expect(ds.string("x00080060")).toBe("CT");
      expect(ds.string("x00100010")).toBe("Test^Patient");
      expect(ds.string("x0020000e")).toBe("1.2.3.9");
      expect(ds.string("x00200013")).toBe(String(i + 1));
      expect(ds.string("x00200032")).toBe(`-10\\-20\\${(i * 0.25).toFixed(2)}`);
      expect(ds.string("x00200037")).toBe("1\\0\\0\\0\\1\\0");
      expect(ds.string("x00280030")).toBe("0.25\\0.25");
      expect(ds.uint16("x00280010")).toBe(SIZE);

      const pixel = ds.elements.x7fe00010;
      expect(pixel.length).toBe(SIZE * SIZE * 2);
      expect(ds.uint16("x7fe00010")).toBe(1000 + i);
    }
  });

  it("adds the -1024 HU offset to unsigned data without a rescale", async () => {
    const [first] = await expandMultiFrameDicom([multiFrameVolume({ frames: FRAMES, size: SIZE })]);
    const ds = await parse(first);
    expect(ds.string("x00281052")).toBe("-1024");
    expect(ds.string("x00281053")).toBe("1");
    expect(ds.string("x00281050")).toBe("0");
    expect(ds.string("x00281051")).toBe("4096");
  });

  it("keeps an existing rescale and window untouched", async () => {
    const volume = multiFrameVolume({
      frames: FRAMES,
      size: SIZE,
      pixelRepresentation: 1,
      rescaleIntercept: "-500",
    });
    const [first] = await expandMultiFrameDicom([volume]);
    const ds = await parse(first);
    expect(ds.string("x00281052")).toBe("-500");
    expect(ds.string("x00281050")).toBe("1024");
  });

  it("drops screenshots and raw data exported next to a volume", async () => {
    const out = await expandMultiFrameDicom([
      singleFrame("screenshot", "1.2.840.10008.5.1.4.1.1.7"),
      singleFrame("raw", "1.2.840.10008.5.1.4.1.1.66"),
      singleFrame("slice", "1.2.840.10008.5.1.4.1.1.2"),
      multiFrameVolume({ frames: FRAMES, size: SIZE }),
    ]);
    expect(out.map((f) => f.name)).not.toContain("screenshot");
    expect(out.map((f) => f.name)).not.toContain("raw");
    expect(out.map((f) => f.name)).toContain("slice");
    expect(out).toHaveLength(FRAMES + 1);
  });

  it("passes ordinary single-frame series through unchanged", async () => {
    const files = [
      singleFrame("a", "1.2.840.10008.5.1.4.1.1.2"),
      singleFrame("screenshot", "1.2.840.10008.5.1.4.1.1.7"),
    ];
    expect(await expandMultiFrameDicom(files)).toEqual(files);
  });

  it("rejects compressed multi-frame volumes with a clear error", async () => {
    const volume = multiFrameVolume({
      frames: FRAMES,
      size: SIZE,
      transferSyntax: "1.2.840.10008.1.2.4.70",
    });
    await expect(expandMultiFrameDicom([volume])).rejects.toThrow(/compressed multi-frame/);
  });
});
