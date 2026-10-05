export class MinPriorityQueue<T> {
  private readonly values: { value: T; priority: number }[] = [];

  get size() { return this.values.length; }

  push(value: T, priority: number) {
    const entry = { value, priority };
    this.values.push(entry);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].priority <= entry.priority) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = entry;
  }

  pop(): T | undefined {
    if (!this.values.length) return undefined;
    const first = this.values[0];
    const last = this.values.pop()!;
    if (this.values.length) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= this.values.length) break;
        if (child + 1 < this.values.length && this.values[child + 1].priority < this.values[child].priority) child++;
        if (this.values[child].priority >= last.priority) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return first.value;
  }
}
