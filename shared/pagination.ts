/** Local collection navigation only; it never mutates source records or invokes tools. */
export class CollectionPage {
  index = 0;
  size = 12;
  private key = '';
  slice<T>(items: readonly T[], key: string): T[] {
    if (key !== this.key) { this.key = key; this.index = 0; }
    this.index = Math.max(0, Math.min(this.index, Math.max(0, Math.ceil(items.length / this.size) - 1)));
    return items.slice(this.index * this.size, (this.index + 1) * this.size);
  }
  resize(size: number): void {
    if (![12, 24, 48].includes(size)) throw new Error('Unsupported page size');
    this.size = size; this.index = 0;
  }
}
