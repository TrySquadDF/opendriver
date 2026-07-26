/**
 * Zero-dependency бенч-харнесс (bun и node).
 *
 * Методология:
 * - warmup до замеров — даём JIT прогреть и специализировать код;
 * - K сэмплов по batch итераций; репортим МЕДИАНУ (устойчива к выбросам
 *   от GC и планировщика ОС, в отличие от среднего) и разброс p25..p75;
 * - blackhole-аккумулятор публикуется наружу — иначе движок вправе
 *   выбросить «бесполезный» цикл целиком (dead code elimination),
 *   и бенч померяет пустоту.
 *
 * Числа сопоставимы только в рамках одного прогона на одной машине.
 * Это инструмент для сравнения «до/после» при правках горячего пути
 * (fields.ts, engine.ts), а не абсолютная истина для README-маркетинга.
 */

let blackhole = 0;
export const consume = (x: unknown): void => {
  // Числа складываем, остальное «трогаем» — достаточно, чтобы результат
  // считался использованным.
  blackhole += typeof x === 'number' ? x : 1;
};

export interface BenchResult {
  name: string;
  medianNsPerOp: number;
  p25NsPerOp: number;
  p75NsPerOp: number;
  opsPerSec: number;
}

const quantile = (sorted: number[], q: number): number => {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx]!;
};

export function bench(
  name: string,
  fn: () => void,
  opts: { warmupIters?: number; samples?: number; batch?: number } = {},
): BenchResult {
  const { warmupIters = 50_000, samples = 30, batch = 20_000 } = opts;

  for (let i = 0; i < warmupIters; i++) fn();

  const nsPerOp: number[] = [];
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) fn();
    const dtMs = performance.now() - t0;
    nsPerOp.push((dtMs * 1e6) / batch);
  }

  nsPerOp.sort((a, b) => a - b);
  const median = quantile(nsPerOp, 0.5);
  const result: BenchResult = {
    name,
    medianNsPerOp: median,
    p25NsPerOp: quantile(nsPerOp, 0.25),
    p75NsPerOp: quantile(nsPerOp, 0.75),
    opsPerSec: 1e9 / median,
  };

  const fmtOps = (v: number) =>
    v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${(v / 1e3).toFixed(0)}k`;
  console.log(
    `${name.padEnd(44)} ${median.toFixed(0).padStart(7)} ns/op `
    + `(p25..p75 ${result.p25NsPerOp.toFixed(0)}..${result.p75NsPerOp.toFixed(0)})  `
    + `${fmtOps(result.opsPerSec)} ops/s`,
  );
  return result;
}

export const flushBlackhole = (): void => {
  // Финальная публикация аккумулятора — гарантия, что он «жив» до конца.
  if (!Number.isFinite(blackhole)) console.log(blackhole);
};
