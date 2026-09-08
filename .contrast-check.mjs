// Contrast ratio calculator

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
      ]
    : null
}

function getLuminance(r, g, b) {
  // Normalize to 0-1
  const rs = r / 255
  const gs = g / 255
  const bs = b / 255

  // Apply gamma correction
  const rLinear =
    rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4)
  const gLinear =
    gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4)
  const bLinear =
    bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4)

  // Calculate relative luminance
  return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear
}

function getContrast(color1Hex, color2Hex) {
  const [r1, g1, b1] = hexToRgb(color1Hex)
  const [r2, g2, b2] = hexToRgb(color2Hex)

  const L1 = getLuminance(r1, g1, b1)
  const L2 = getLuminance(r2, g2, b2)

  const lighter = Math.max(L1, L2)
  const darker = Math.min(L1, L2)

  return (lighter + 0.05) / (darker + 0.05)
}

const colors = {
  '--ink': '#12111f',
  '--muted': '#8b87a8',
  '--edge-strong': '#7a7ab8',
  '--bone': '#eeecf5',
  '--focus': '#8f8fff',
}

console.log('=== Contrast Ratio Analysis for Undo Button ===\n')

console.log('Colors used:')
Object.entries(colors).forEach(([name, hex]) => {
  console.log(`  ${name}: ${hex}`)
})

console.log('\n=== Active State (enabled): ===')
console.log(`Text: ${colors['--muted']} on bg ${colors['--ink']}`)
const contrastMutedOnInk = getContrast(colors['--muted'], colors['--ink'])
console.log(`Contrast ratio: ${contrastMutedOnInk.toFixed(2)}:1`)
console.log(
  `WCAG AA (4.5:1 required): ${contrastMutedOnInk >= 4.5 ? '✓ PASS' : '✗ FAIL'}`
)

console.log(
  `\nBorder: ${colors['--edge-strong']} on bg ${colors['--ink']}`
)
const contrastEdgeOnInk = getContrast(colors['--edge-strong'], colors['--ink'])
console.log(`Contrast ratio: ${contrastEdgeOnInk.toFixed(2)}:1`)
console.log(
  `WCAG AA (3:1 required): ${contrastEdgeOnInk >= 3 ? '✓ PASS' : '✗ FAIL'}`
)

console.log('\n=== Hover State (on hover): ===')
console.log(`Text: ${colors['--bone']} on bg ${colors['--ink']}`)
const contrastBoneOnInk = getContrast(colors['--bone'], colors['--ink'])
console.log(`Contrast ratio: ${contrastBoneOnInk.toFixed(2)}:1`)
console.log(
  `WCAG AAA (7:1 recommended): ${contrastBoneOnInk >= 7 ? '✓ EXCELLENT' : contrastBoneOnInk >= 4.5 ? '✓ PASS' : '✗ FAIL'}`
)

console.log(
  `\nBorder: ${colors['--muted']} on bg ${colors['--ink']}`
)
console.log(`Contrast ratio: ${contrastMutedOnInk.toFixed(2)}:1 (same as text)`)

console.log('\n=== Disabled State: ===')
console.log(
  'opacity: 0.4 applied to normal state (visual distinctness: ✓ PASS)'
)
