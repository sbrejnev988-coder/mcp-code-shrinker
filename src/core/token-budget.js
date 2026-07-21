// ═══ Token Budget — контроль лимитов токенов ═══

export class TokenBudget {
  constructor(opts = {}) {
    this.defaultLimit = opts.defaultLimit || 32000;
    this.hardLimit = opts.hardLimit || 100000;
  }

  /** Примерная оценка токенов: 1 токен ≈ 3.5 символов (для кода) */
  estimate(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
  }

  /** Усечь текст до бюджетного лимита, сохраняя смысловые блоки */
  truncate(text, limit = this.defaultLimit) {
    const budget = Math.floor(limit * 0.8); // 80% на код, 20% резерв
    const est = this.estimate(text);
    if (est <= budget) return text;

    // Разбиваем на блоки (по двойным переносам строк)
    const blocks = text.split(/\n\n+/);
    let result = "";
    let used = 0;

    for (const block of blocks) {
      const blockEst = this.estimate(block);
      if (used + blockEst > budget) {
        // Добавляем усечённый остаток
        const remaining = budget - used;
        if (remaining > 50) {
          const lines = block.split("\n");
          let partial = "";
          for (const line of lines) {
            if (this.estimate(partial + line) > remaining) break;
            partial += line + "\n";
          }
          result += partial.trimEnd() + "\n// ... truncated\n";
        } else {
          result += "// ... " + (blocks.length - blocks.indexOf(block) - 1) + " blocks truncated\n";
        }
        break;
      }
      result += block + "\n\n";
      used += blockEst;
    }

    return result.trim();
  }

  /** Форматировать бюджет для вывода */
  report(used, limit) {
    const pct = Math.round((used / limit) * 100);
    return `${used}/${limit} tokens (${pct}%)`;
  }
}
