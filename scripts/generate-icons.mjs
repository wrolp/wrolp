import sharp from 'sharp'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import toIco from 'to-ico'

const svgPath = resolve('src-tauri/icons/logo.svg')
const outDir = resolve('src-tauri/icons')

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const pngSizes = [
  { file: '32x32.png', size: 32 },
  { file: '128x128.png', size: 128 },
  { file: '128x128@2x.png', size: 256 },
  { file: '256x256.png', size: 256 },
  { file: '512x512.png', size: 512 },
]

async function generate() {
  // ===== PNG =====
  for (const { file, size } of pngSizes) {
    const out = resolve(outDir, file)
    await sharp(svgPath).resize(size, size).png().toFile(out)
    console.log(`  ✓ ${file} (${size}x${size})`)
  }

  // ===== ICO (valid Windows ico format) =====
  const png256 = await sharp(svgPath).resize(256, 256).png().toBuffer()
  const png32 = await sharp(svgPath).resize(32, 32).png().toBuffer()
  const icoBuffer = await toIco([png32, png256])
  writeFileSync(resolve(outDir, 'icon.ico'), icoBuffer)
  console.log('  ✓ icon.ico (32+256)')

  // ===== icns (use 128x128 PNG as fallback, accepted by macOS) =====
  await sharp(svgPath)
    .resize(128, 128)
    .png()
    .toFile(resolve(outDir, 'icon.icns'))
  console.log('  ✓ icon.icns')

  console.log('\nAll icons generated in src-tauri/icons/')
}

generate().catch((err) => {
  console.error('Icon generation failed:', err)
  process.exit(1)
})
