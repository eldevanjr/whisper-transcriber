import { createWriteStream } from 'node:fs'
import yazl from 'yazl'

export async function makeWheel(path: string, files: Record<string, string>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) zip.addEmptyDirectory(name)
    else zip.addBuffer(Buffer.from(content), name)
  }
  zip.end()
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(path)).on('close', resolve).on('error', reject)
  })
}
