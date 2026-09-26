import { z } from 'zod'
import { readJson, writeJsonAtomic } from '../fs-utils'

const FlagsSchema = z.object({ hiddenHintShown: z.boolean() })
export type Flags = z.infer<typeof FlagsSchema>
const DEFAULT_FLAGS: Flags = { hiddenHintShown: false }

/** Marcas internas do app (fora das configurações): avisos que só aparecem uma vez. */
export class FlagsStore {
  private constructor(
    private current: Flags,
    private readonly path: string
  ) {}

  static async open(path: string): Promise<FlagsStore> {
    const raw: unknown = await readJson(path).catch(() => null)
    const parsed = FlagsSchema.safeParse(raw)
    return new FlagsStore(parsed.success ? parsed.data : DEFAULT_FLAGS, path)
  }

  get(): Flags {
    return this.current
  }

  async set(patch: Partial<Flags>): Promise<void> {
    this.current = { ...this.current, ...patch }
    await writeJsonAtomic(this.path, this.current)
  }
}
