// Native control records use UTF-8 JSON lines over the inherited private pipe.
// Bound bytes before decoding, including when a multibyte character is split.
export class NativeRecords {
  private parts: Uint8Array[] = []
  private bytes = 0
  private currentLimit: number
  constructor(private readonly limit = 65536, firstLimit = limit) { this.currentLimit = firstLimit }
  push(chunk: Uint8Array) {
    const lines: string[] = []
    let offset = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue
      this.add(chunk.subarray(offset, index))
      const record = new Uint8Array(this.bytes)
      let position = 0
      for (const part of this.parts) { record.set(part, position); position += part.length }
      lines.push(new TextDecoder('utf-8', { fatal: true }).decode(record))
      this.parts = []; this.bytes = 0; offset = index + 1
      this.currentLimit = this.limit
    }
    this.add(chunk.subarray(offset))
    return lines
  }
  private add(value: Uint8Array) {
    this.bytes += value.length
    if (this.bytes > this.currentLimit) throw new Error('Native control record exceeded its limit')
    if (value.length) this.parts.push(value.slice())
  }
}
