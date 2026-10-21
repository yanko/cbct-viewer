import dicomParser, { type DataSet, type Element } from "dicom-parser";

// dental-cbct-viewer@1.4.0 treats every DICOM file as a single image, so an
// enhanced multi-frame volume (e.g. Sirona/Sidexis "X-Ray 3D Craniofacial Image"
// with all slices in one file) shows up as one flat picture. This module splits
// such volumes into ordinary single-frame CT images the viewer can stack.

const CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2";
const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";
const NATIVE_TRANSFER_SYNTAXES = new Set(["1.2.840.10008.1.2", EXPLICIT_VR_LE]);
// UUID-derived UID (DICOM PS3.5 §B.2) identifying this app as the writer of the split files.
const IMPLEMENTATION_CLASS_UID = "2.25.215604331577254870911416337946298424407";
// Secondary Capture (rendered screenshots) and Raw Data: not slices of the volume.
const NON_VOLUME_SOP_PREFIXES = ["1.2.840.10008.5.1.4.1.1.7", "1.2.840.10008.5.1.4.1.1.66"];

// A multi-frame CBCT volume is tens of MB or more; single slices are smaller.
const VOLUME_CANDIDATE_MIN_BYTES = 8 * 1024 * 1024;
// The header (incl. per-frame functional groups) sits before the pixel data.
const HEADER_PROBE_BYTES = 8 * 1024 * 1024;
const SMALL_HEADER_PROBE_BYTES = 256 * 1024;

const PIXEL_DATA = "x7fe00010";
const SHARED_GROUPS = "x52009229";
const PER_FRAME_GROUPS = "x52009230";

/**
 * Returns `files` with every multi-frame DICOM volume replaced by one file per
 * frame. When a volume was split, screenshots and raw-data objects exported
 * alongside it are dropped so they don't show up as a bogus series.
 */
export async function expandMultiFrameDicom(files: File[]): Promise<File[]> {
  const out: File[] = [];
  const rest: File[] = [];
  let expanded = false;

  for (const file of files) {
    if (file.size < VOLUME_CANDIDATE_MIN_BYTES) {
      rest.push(file);
      continue;
    }
    const header = await readHeader(file, HEADER_PROBE_BYTES);
    if (!header || frameCount(header) < 2) {
      out.push(file);
      continue;
    }
    out.push(...splitVolume(file.name, await readFull(file)));
    expanded = true;
  }

  for (const file of rest) {
    if (expanded) {
      const sopClass = (await readHeader(file, SMALL_HEADER_PROBE_BYTES))?.string("x00080016");
      if (sopClass && NON_VOLUME_SOP_PREFIXES.some((p) => sopClass.startsWith(p))) continue;
    }
    out.push(file);
  }
  return out;
}

async function readHeader(file: File, bytes: number): Promise<DataSet | undefined> {
  try {
    const buf = new Uint8Array(await file.slice(0, bytes).arrayBuffer());
    return dicomParser.parseDicom(buf, { untilTag: PIXEL_DATA });
  } catch {
    return undefined; // not DICOM, or a header larger than the probe
  }
}

async function readFull(file: File): Promise<DataSet> {
  return dicomParser.parseDicom(new Uint8Array(await file.arrayBuffer()));
}

function frameCount(ds: DataSet): number {
  return ds.intString("x00280008") ?? 1;
}

/** Looks a value up in the frame's functional group, then the shared one, then top level. */
function frameValue(ds: DataSet, frame: number, sequence: string, tag: string): string | undefined {
  const fromGroup = (group: string, index: number) =>
    ds.elements[group]?.items?.[index]?.dataSet?.elements[sequence]?.items?.[0]?.dataSet?.string(
      tag,
    );
  return fromGroup(PER_FRAME_GROUPS, frame) ?? fromGroup(SHARED_GROUPS, 0) ?? ds.string(tag);
}

function splitVolume(name: string, ds: DataSet): File[] {
  const transferSyntax = ds.string("x00020010") ?? "";
  const pixels = ds.elements[PIXEL_DATA];
  if (!pixels) throw new Error(`${name}: no pixel data`);
  if (!NATIVE_TRANSFER_SYNTAXES.has(transferSyntax) || pixels.encapsulatedPixelData) {
    throw new Error(
      `${name}: compressed multi-frame DICOM (transfer syntax ${transferSyntax}) is not supported`,
    );
  }

  const frames = frameCount(ds);
  const rows = ds.uint16("x00280010") ?? 0;
  const columns = ds.uint16("x00280011") ?? 0;
  const samples = ds.uint16("x00280002") ?? 1;
  const bitsAllocated = ds.uint16("x00280100") ?? 16;
  const frameBytes = (rows * columns * samples * bitsAllocated) / 8;
  if (!Number.isInteger(frameBytes) || frameBytes * frames > pixels.length) {
    throw new Error(`${name}: pixel data does not match ${frames} frames of ${columns}×${rows}`);
  }

  const sopInstance = ds.string("x00080018") ?? "";
  const spacing = frameValue(ds, 0, "x00289110", "x00180050") ?? ds.string("x00180088") ?? "1";
  const bytes = ds.byteArray;
  const copy = (vr: string, tag: string) => {
    const el = ds.elements[tag];
    return el ? element(tag, vr, bytes.subarray(el.dataOffset, el.dataOffset + el.length)) : [];
  };
  const us = (tag: string) => element(tag, "US", uint16(ds.uint16(tag) ?? 0));
  // Unsigned volumes without a Modality LUT (e.g. Sirona ORTHOPHOS) store HU + 1024.
  // The viewer's 3D presets and bone classes expect HU, so apply the standard offset.
  const hasRescale = frameValue(ds, 0, "x00289145", "x00281052") !== undefined;
  const defaultIntercept = !hasRescale && ds.uint16("x00280103") === 0 ? -1024 : 0;

  return Array.from({ length: frames }, (_, i) => {
    const sop = uniqueUid(sopInstance, i + 1);
    const position =
      frameValue(ds, i, "x00209113", "x00200032") ??
      `0\\0\\${(i * parseFloat(spacing)).toFixed(4)}`;
    const rescale = (tag: string, fallback: string) =>
      frameValue(ds, i, "x00289145", tag) ?? fallback;
    const windowCenter = frameValue(ds, i, "x00289132", "x00281050");
    const windowWidth = frameValue(ds, i, "x00289132", "x00281051");

    const meta = [
      element("x00020001", "OB", new Uint8Array([0, 1])),
      element("x00020002", "UI", text(CT_IMAGE_STORAGE)),
      element("x00020003", "UI", text(sop)),
      element("x00020010", "UI", text(EXPLICIT_VR_LE)),
      element("x00020012", "UI", text(IMPLEMENTATION_CLASS_UID)),
    ].flat();
    const dataset = [
      copy("CS", "x00080005"),
      element("x00080008", "CS", text("DERIVED\\SECONDARY\\AXIAL")),
      element("x00080016", "UI", text(CT_IMAGE_STORAGE)),
      element("x00080018", "UI", text(sop)),
      copy("DA", "x00080020"),
      element("x00080060", "CS", text("CT")),
      copy("LO", "x00080070"),
      copy("LO", "x00081030"),
      copy("LO", "x0008103e"),
      copy("PN", "x00100010"),
      copy("LO", "x00100020"),
      copy("DA", "x00100030"),
      element("x00180050", "DS", text(spacing)),
      copy("UI", "x0020000d"),
      copy("UI", "x0020000e"),
      copy("IS", "x00200011"),
      element("x00200013", "IS", text(String(i + 1))),
      element("x00200032", "DS", text(position)),
      element(
        "x00200037",
        "DS",
        text(frameValue(ds, i, "x00209116", "x00200037") ?? "1\\0\\0\\0\\1\\0"),
      ),
      copy("UI", "x00200052"),
      us("x00280002"),
      copy("CS", "x00280004"),
      us("x00280010"),
      us("x00280011"),
      element(
        "x00280030",
        "DS",
        text(frameValue(ds, i, "x00289110", "x00280030") ?? `${spacing}\\${spacing}`),
      ),
      us("x00280100"),
      us("x00280101"),
      us("x00280102"),
      us("x00280103"),
      // The window centre moves with the added offset; the width doesn't.
      optional(
        "x00281050",
        "DS",
        windowCenter && String(parseFloat(windowCenter) + defaultIntercept),
      ),
      optional("x00281051", "DS", windowWidth),
      element("x00281052", "DS", text(rescale("x00281052", String(defaultIntercept)))),
      element("x00281053", "DS", text(rescale("x00281053", "1"))),
      element(
        PIXEL_DATA,
        bitsAllocated > 8 ? "OW" : "OB",
        frameSlice(bytes, pixels, i, frameBytes),
      ),
    ].flat();

    const metaLength = meta.reduce((sum, part) => sum + part.length, 0);
    const parts = [
      new Uint8Array(128),
      text("DICM"),
      ...element("x00020000", "UL", uint32(metaLength)),
      ...meta,
      ...dataset,
    ];
    return new File(parts as BlobPart[], `${name}_${String(i + 1).padStart(4, "0")}.dcm`, {
      type: "application/dicom",
    });
  });
}

function frameSlice(
  bytes: Uint8Array,
  pixels: Element,
  frame: number,
  frameBytes: number,
): Uint8Array {
  const start = pixels.dataOffset + frame * frameBytes;
  return bytes.subarray(start, start + frameBytes);
}

/** `<base>.<n>` when it fits the 64-char UID limit, otherwise a fresh UUID-derived UID. */
function uniqueUid(base: string, n: number): string {
  const derived = `${base}.${n}`;
  if (base && derived.length <= 64) return derived;
  const hex = crypto.randomUUID().replace(/-/g, "");
  return `2.25.${BigInt(`0x${hex}`).toString()}`;
}

const LONG_LENGTH_VRS = new Set(["OB", "OW", "OF", "SQ", "UN", "UT"]);

/** One explicit-VR little-endian element: header + value, padded to even length. */
function element(tag: string, vr: string, value: Uint8Array): Uint8Array[] {
  const padded = value.length % 2 ? pad(value, vr === "UI" || vr === "OB" ? 0 : 0x20) : value;
  const long = LONG_LENGTH_VRS.has(vr);
  const header = new DataView(new ArrayBuffer(long ? 12 : 8));
  header.setUint16(0, parseInt(tag.slice(1, 5), 16), true);
  header.setUint16(2, parseInt(tag.slice(5, 9), 16), true);
  header.setUint8(4, vr.charCodeAt(0));
  header.setUint8(5, vr.charCodeAt(1));
  if (long) header.setUint32(8, padded.length, true);
  else header.setUint16(6, padded.length, true);
  return [new Uint8Array(header.buffer), padded];
}

function optional(tag: string, vr: string, value: string | undefined): Uint8Array[] {
  return value === undefined ? [] : element(tag, vr, text(value));
}

function pad(value: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(value.length + 1);
  out.set(value);
  out[value.length] = byte;
  return out;
}

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

function uint16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}
