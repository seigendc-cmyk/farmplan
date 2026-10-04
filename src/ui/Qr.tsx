import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** Renders a QR code for `value` as inline SVG (generated locally, works offline). */
export function Qr({ value, size = 140 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState('')
  useEffect(() => { let live = true; QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(s => { if (live) setSvg(s) }).catch(() => setSvg('')); return () => { live = false } }, [value])
  return <div role="img" aria-label={`QR code for ${value}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
}
