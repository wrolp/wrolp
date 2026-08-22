import { useEffect, useMemo, useState } from 'react'

interface HexViewerProps {
  /** Raw file bytes as Base64. */
  base64: string
  /** File name / size shown in the toolbar. */
  name: string
  size: number
}

const BYTES_PER_ROW = 16

function decodeBase64(b64: string): Uint8Array {
  // base64url vs standard — the Rust side uses STANDARD, but be tolerant.
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(normalized)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

function toHexByte(b: number): string {
  return b.toString(16).padStart(2, '0')
}

/**
 * Read-only hex dump viewer for binary files. Renders `offset | hex | ascii`
 * rows (16 bytes per row) with a viewport-cap (e.g. first 1 MB) to avoid
 * freezing the UI on very large binaries; a button reveals more.
 */
export default function HexViewer({ base64, name, size }: HexViewerProps) {
  const bytes = useMemo(() => {
    try {
      return decodeBase64(base64)
    } catch {
      return new Uint8Array(0)
    }
  }, [base64])

  const [shownBytes, setShownBytes] = useState(1_048_576) // 1 MiB
  const slice = bytes.subarray(0, Math.min(shownBytes, bytes.length))
  const more = bytes.length - slice.length

  // Reset the reveal cap when a different file is loaded.
  useEffect(() => {
    setShownBytes(1_048_576)
  }, [base64])

  const rows = useMemo(() => {
    const out: React.ReactNode[] = []
    for (let off = 0; off < slice.length; off += BYTES_PER_ROW) {
      const end = Math.min(off + BYTES_PER_ROW, slice.length)
      const rowBytes = Array.from(slice.subarray(off, end))
      const hex = rowBytes.map(toHexByte).join(' ')
      const pad = '   '.repeat(BYTES_PER_ROW - rowBytes.length)
      const ascii = rowBytes
        .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
        .join('')
      out.push(
        <div key={off} className="hex-row">
          <span className="hex-offset">{off.toString(16).padStart(8, '0')}</span>
          <span className="hex-bytes">
            {hex}
            {pad}
          </span>
          <span className="hex-ascii">{ascii}</span>
        </div>,
      )
    }
    return out
  }, [slice])

  if (bytes.length === 0) {
    return (
      <div className="hex-viewer">
        <div className="hex-empty">Unable to decode binary data.</div>
      </div>
    )
  }

  return (
    <div className="hex-viewer">
      <div className="hex-toolbar">
        <span className="hex-filename" title={name}>
          {name}
        </span>
        <span className="hex-meta">{bytes.length.toLocaleString()} bytes</span>
        <span className="hex-spacer" />
        <span className="hex-hint">hex dump · read-only</span>
      </div>
      <div className="hex-head">
        <span className="hex-offset">Offset</span>
        <span className="hex-bytes">Hex bytes</span>
        <span className="hex-ascii">ASCII</span>
      </div>
      <div className="hex-body">{rows}</div>
      {more > 0 && (
        <div className="hex-more">
          <button className="editor-btn" onClick={() => setShownBytes((n) => n + 1_048_576)}>
            Show next 1 MiB ({more.toLocaleString()} bytes remaining)
          </button>
        </div>
      )}
    </div>
  )
}
