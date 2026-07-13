function textOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? String(value.text ?? '') : String(value ?? '');
}

function grams(value, size) {
  const result = new Set();
  for (let index = 0; index <= value.length - size; index += 1) result.add(value.slice(index, index + size));
  return result;
}

export class LogicalSearchIndex {
  constructor(entries = [], formatter = null) {
    this.entries = entries;
    this.formatter = formatter;
    this.lines = [];
    this.indexes = [null, new Map(), new Map(), new Map()];
    for (let entry = 0; entry < entries.length; entry += 1) {
      const rendered = String(formatter ? formatter(entries[entry]) : textOf(entries[entry]));
      let start = 0;
      const logical = rendered.split('\n');
      for (let line = 0; line < logical.length; line += 1) {
        const text = logical[line];
        const lower = text.toLocaleLowerCase();
        const lineIndex = this.lines.length;
        this.lines.push({ entry, line, start, text, lower });
        for (let size = 1; size <= 3; size += 1) {
          for (const gram of grams(lower, size)) {
            if (!this.indexes[size].has(gram)) this.indexes[size].set(gram, []);
            this.indexes[size].get(gram).push(lineIndex);
          }
        }
        start += text.length + (line < logical.length - 1 ? 1 : 0);
      }
    }
  }

  find(query) {
    const needle = String(query || '').toLocaleLowerCase();
    if (!needle) return [];
    const size = Math.min(3, needle.length);
    let candidates = null;
    if (size < 3) {
      candidates = this.indexes[size].get(needle) || [];
    } else {
      for (const gram of grams(needle, 3)) {
        const matches = this.indexes[3].get(gram) || [];
        if (candidates == null || matches.length < candidates.length) candidates = matches;
      }
      candidates ||= [];
    }
    const hits = [];
    for (const lineIndex of candidates) {
      const line = this.lines[lineIndex];
      const offset = line.lower.indexOf(needle);
      if (offset < 0) continue;
      hits.push({ entry: line.entry, logicalLine: line.line, offset: line.start + offset, lineOffset: offset, lineIndex });
    }
    return hits;
  }
}

export function nextSearchMatch(current, count, direction) {
  const total = Math.max(0, Number(count || 0));
  if (!total) return 0;
  return (Math.max(0, Number(current || 0)) + Math.sign(direction || 1) + total) % total;
}
