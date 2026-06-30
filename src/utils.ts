import { Buffer } from 'buffer';

/**
 * An asynchronous queue that implements AsyncIterable.
 * Used to pipe real-time audio chunks from the Twilio WebSocket 
 * directly into the AWS Transcribe client stream.
 */
export class AudioQueue implements AsyncIterable<Uint8Array> {
  private queue: Buffer[] = [];
  private resolveNext: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  private done = false;

  /**
   * Pushes a new raw buffer to the queue.
   */
  push(chunk: Buffer) {
    if (this.done) return;
    if (this.resolveNext) {
      this.resolveNext({ value: chunk, done: false });
      this.resolveNext = null;
    } else {
      this.queue.push(chunk);
    }
  }

  /**
   * Closes the queue, notifying the reader that no more elements are expected.
   */
  stop() {
    this.done = true;
    if (this.resolveNext) {
      this.resolveNext({ value: undefined as any, done: true });
      this.resolveNext = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (!this.done || this.queue.length > 0) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        const nextPromise = new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.resolveNext = resolve;
        });
        const result = await nextPromise;
        if (result.done) {
          break;
        }
        yield result.value;
      }
    }
  }
}

// 256-element lookup table to decode 8-bit mu-law (G.711) directly to 16-bit linear PCM.
// This is extremely fast (O(1) table lookup per sample) and requires zero arithmetic inside loops.
const MU_LAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  // Bits are inverted in G.711 mu-law transmission
  const u = ~i & 0xFF;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  
  // Reconstruct 16-bit linear sample from mantissa and exponent
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  
  MU_LAW_DECODE_TABLE[i] = sign * sample;
}

/**
 * Decodes a buffer of 8-bit mu-law audio to 16-bit linear PCM (signed little-endian).
 */
export function decodeMuLawToPcm(mulawBuffer: Buffer): Buffer {
  const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = MU_LAW_DECODE_TABLE[mulawBuffer[i]];
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  return pcmBuffer;
}

/**
 * Generates a standard 44-byte RIFF/WAVE header for a mono, 8000 Hz, 8-bit mu-law audio stream.
 * Prepending this header to raw mu-law audio chunks results in a fully standard, playable WAV file.
 * 
 * @param dataLength The total length of the raw mu-law audio payload (bytes).
 */
export function writeWavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  
  // 1. RIFF Chunk Descriptor
  header.write("RIFF", 0);                     // ChunkID
  header.writeUInt32LE(36 + dataLength, 4);     // ChunkSize
  header.write("WAVE", 8);                     // Format
  
  // 2. fmt Sub-chunk
  header.write("fmt ", 12);                    // Subchunk1ID
  header.writeUInt32LE(16, 16);                 // Subchunk1Size (16 for PCM/mu-law basic header)
  header.writeUInt16LE(7, 20);                  // AudioFormat (7 represents G.711 mu-law)
  header.writeUInt16LE(1, 22);                  // NumChannels (1 = Mono)
  header.writeUInt32LE(8000, 24);               // SampleRate (8000 Hz)
  header.writeUInt32LE(8000, 28);               // ByteRate (SampleRate * NumChannels * BitsPerSample/8 = 8000 * 1 * 1)
  header.writeUInt16LE(1, 32);                  // BlockAlign (NumChannels * BitsPerSample/8 = 1)
  header.writeUInt16LE(8, 34);                  // BitsPerSample (8 bits for G.711 mu-law)
  
  // 3. data Sub-chunk
  header.write("data", 36);                    // Subchunk2ID
  header.writeUInt32LE(dataLength, 40);         // Subchunk2Size
  
  return header;
}

/**
 * Buffers streaming text and splits it into segments based on sentence/clause boundaries
 * (punctuation characters like . , ? ! ; : \n \r). This prevents single words
 * from being streamed to ElevenLabs, resulting in natural speech prosody.
 */
export class SentenceChunker {
  private buffer = '';
  private onSentence: (sentence: string) => void;

  constructor(onSentence: (sentence: string) => void) {
    this.onSentence = onSentence;
  }

  /**
   * Adds a streaming text chunk and checks for sentence/clause boundary splits.
   */
  addChunk(chunk: string) {
    this.buffer += chunk;
    const punctuationRegex = /[.,?!;:、。，\n]/;
    
    let matchIndex = this.buffer.search(punctuationRegex);
    while (matchIndex !== -1) {
      const sentence = this.buffer.slice(0, matchIndex + 1);
      this.buffer = this.buffer.slice(matchIndex + 1);
      
      if (sentence.trim().length > 0) {
        this.onSentence(sentence);
      }
      
      matchIndex = this.buffer.search(punctuationRegex);
    }
  }

  /**
   * Flushes any remaining text in the buffer.
   */
  flush() {
    if (this.buffer.trim().length > 0) {
      this.onSentence(this.buffer);
      this.buffer = '';
    }
  }
}
