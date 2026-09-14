// Minimal ambient types for the mp4box.js surface the preview uses (the package
// ships no .d.ts). Everything is exposed on the default export (UMD).
declare module "mp4box" {
  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }
  export interface MP4VideoTrackInfo {
    id: number;
    codec: string;
    timescale: number;
    duration: number;
    nb_samples: number;
    video: { width: number; height: number };
  }
  export interface MP4Info {
    videoTracks: MP4VideoTrackInfo[];
    duration: number;
    timescale: number;
  }
  export interface MP4Sample {
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    data: Uint8Array;
    number: number;
  }
  export interface DataStream {
    buffer: ArrayBuffer;
  }
  export interface DataStreamCtor {
    new (buffer?: ArrayBuffer, byteOffset?: number, endianness?: number): DataStream;
    BIG_ENDIAN: number;
  }
  export interface CodecBox {
    write(stream: DataStream): void;
  }
  export interface StsdEntry {
    avcC?: CodecBox;
    hvcC?: CodecBox;
    vpcC?: CodecBox;
    av1C?: CodecBox;
  }
  /** An entry of the sample table mp4box builds from the moov, BEFORE any media bytes are
   *  appended: where the sample lives in the file rather than its contents. */
  export interface MP4SampleInfo {
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    offset: number;
    size: number;
    number: number;
  }
  export interface MP4Track {
    mdia: { minf: { stbl: { stsd: { entries: StsdEntry[] } } } };
    samples: MP4SampleInfo[];
  }
  export interface MP4File {
    onReady: ((info: MP4Info) => void) | null;
    onError: ((e: string) => void) | null;
    onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null;
    appendBuffer(data: MP4ArrayBuffer): number;
    start(): void;
    stop(): void;
    flush(): void;
    setExtractionOptions(id: number, user?: unknown, opts?: { nbSamples?: number }): void;
    getTrackById(id: number): MP4Track;
  }
  export interface MP4BoxStatic {
    createFile(): MP4File;
    DataStream: DataStreamCtor;
  }
  const MP4Box: MP4BoxStatic;
  export default MP4Box;
}
