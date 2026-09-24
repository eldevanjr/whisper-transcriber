export interface Sample {
  t: number
  bytes: number
}

export const RATE_WINDOW_MS = 3000

/** Velocidade média (bytes/s) na janela dos últimos 3 s. */
export function transferRate(samples: readonly Sample[]): number {
  const last = samples.at(-1)
  if (!last) return 0
  const first = samples.reduce(
    (oldest, sample) =>
      last.t - sample.t <= RATE_WINDOW_MS && sample.t < oldest.t ? sample : oldest,
    last
  )
  const elapsed = last.t - first.t
  return elapsed > 0 ? ((last.bytes - first.bytes) * 1000) / elapsed : 0
}
